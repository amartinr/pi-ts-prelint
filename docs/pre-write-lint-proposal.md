# Pre-Write Linting Extension Proposal

## Context
We are working with small, quantized language models. These models are prone to syntactic and type errors, and they often struggle to interpret complex runtime error messages, leading to long loops of writing, failing, and retrying.

## The Hypothesis
Pre-write linting with `tsc` can save tokens by:
1. Catching type/syntax errors **before** the code is persisted to the project.
2. Providing structured, line-specific error messages that are easier for small models to interpret than runtime stack traces.
3. Preventing the session context from being contaminated with code that the model will then have to "unlearn" or fix in subsequent turns.

## The Proposal
A minimal pi extension that intercepts `write` and `edit` tool calls for TypeScript files (`.ts`, `.tsx`) and runs a quick type-check before allowing the change to proceed.

## The Flow

1. Agent calls `write("src/foo.ts", content)` or `edit("src/foo.ts", { oldText, newText })`.
2. Extension intercepts the call via the `tool_call` event.
3. If the target is **not** a `.ts` / `.tsx` file, the extension passes through.
4. The extension builds the resulting file content:
   - For `write`: uses `event.input.content` directly.
   - For `edit`: reads the existing file, applies each `oldText` → `newText` replacement sequentially (each `oldText` is replaced only once, using `String.replace`).
5. The resulting content is **written to a temp file** in the same directory as the target, with a `~` prefix and `~` suffix (e.g. `src/foo.ts` → `src/~foo.ts~`). This keeps the real file untouched during linting.
6. `npx tsc --noEmit --pretty false` is run **on the temp file only**.
7. The `tsc` output is filtered to only include errors that mention the affected file path (using a word-boundary regex to avoid false positives).
8. If there are errors: the change is **blocked** and the error output is returned to the agent.
9. If compilation succeeds: the extension cleans up the temp file in a `finally` block (the actual `write`/`edit` tool will apply the change).
10. If `tsc` times out or throws unexpectedly, the change is allowed to proceed as a fail-safe.

## Implementation Notes

The actual implementation diverges from the original sketch in several ways:

- **Temp file with `~` prefix/suffix**: The candidate content is written to a temp file in the same directory as the target (e.g. `src/~foo.ts~`), so `tsc` won't match it in glob patterns. The real file is never modified during linting.
- **Single-file `tsc`**: `tsc` is run on the temp file only, not the entire project. This is faster and more targeted — it checks the candidate content for syntax/type errors without needing to compile the full codebase.
- **Multiple edits**: For `edit` events, all `oldText`/`newText` pairs are applied sequentially using `String.replace()` (each `oldText` is replaced only once).
- **`oldText` not found**: If `oldText` is missing from the file, the edit is silently skipped (via `continue`) but the lint check still proceeds on the existing content.
- **Single-edit format**: In addition to the array format `{ edits: [...] }`, the extension also supports a single-edit format `{ oldText, newText }` as direct properties of `event.input`.
- **File size limit**: Files exceeding 10 MB are skipped with an informational notification.
- **Word-boundary error filtering**: `tsc` errors are filtered using a regex with word boundary (`\bfilename:`) to avoid false positives (e.g. matching `src/foo.ts.backup`).

```typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TSC_TIMEOUT_MS = 30_000;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * Generate a temp file path for linting.
 * Uses ~ prefix and ~ suffix so tsc won't match it in glob patterns.
 * e.g. src/foo.ts → src/~foo.ts~
 */
function lintTempPath(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return path.join(dir, `~${base}~`);
}

function isTsFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".ts" || ext === ".tsx";
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runTsc(tempPath: string, filePath: string, cwd: string): Promise<string | null> {
  try {
    await execFileAsync("npx", ["tsc", "--noEmit", "--pretty", "false", tempPath], {
      cwd,
      timeout: TSC_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 10,
    });
    return null;
  } catch (err: unknown) {
    const nodeErr = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const output =
      (nodeErr.stdout && typeof nodeErr.stdout.toString === "function" ? nodeErr.stdout.toString() : "") +
      "\n" +
      (nodeErr.stderr && typeof nodeErr.stderr.toString === "function" ? nodeErr.stderr.toString() : "");
    const escaped = escapeRegex(filePath);
    const fileErrorPattern = new RegExp(`\\b${escaped}:`);
    const relevantErrors = output
      .split("\n")
      .filter(line => fileErrorPattern.test(line))
      .join("\n")
      .trim();
    return relevantErrors || null;
  }
}

function cleanupTemp(tempPath: string): void {
  try { fs.rmSync(tempPath, { force: true }); } catch {}
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (
      !isToolCallEventType("write", event) &&
      !isToolCallEventType("edit", event)
    ) {
      return;
    }

    const filePath = event.input.path;
    if (!filePath || !isTsFile(filePath)) return;

    const absPath = path.resolve(ctx.cwd, filePath);
    const tempPath = path.resolve(ctx.cwd, lintTempPath(filePath));

    // Skip files that are too large to lint
    let existingSize = 0;
    try { existingSize = fs.statSync(absPath).size; } catch {}
    if (existingSize > MAX_FILE_SIZE) {
      ctx.ui.notify(`Skipping lint for ${filePath}: file exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit.`, "info");
      return;
    }

    let newContent: string;

    if (isToolCallEventType("write", event)) {
      newContent = event.input.content;
      if (newContent.length > MAX_FILE_SIZE) {
        ctx.ui.notify(`Skipping lint for ${filePath}: new content exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit.`, "info");
        return;
      }
    } else {
      let existingContent: string;
      try {
        existingContent = fs.readFileSync(absPath, "utf-8");
      } catch {
        return; // file doesn't exist yet
      }

      const edits = event.input.edits;
      const singleEdit = (event.input as { oldText?: string; newText?: string }).oldText != null;
      if (!edits && !singleEdit) return;

      newContent = existingContent;

      if (edits && edits.length > 0) {
        for (const edit of edits) {
          if (!edit.oldText) continue;
          if (!newContent.includes(edit.oldText)) continue;
          newContent = newContent.replace(edit.oldText, edit.newText ?? "");
        }
      }
      if (singleEdit) {
        const { oldText, newText } = event.input as { oldText: string; newText?: string };
        if (newContent.includes(oldText)) {
          newContent = newContent.replace(oldText, newText ?? "");
        }
      }
    }

    // Write candidate content to temp file (real file untouched)
    fs.writeFileSync(tempPath, newContent, "utf-8");

    let blocked = false;
    let blockReason: string | undefined;

    try {
      const errors = await runTsc(tempPath, filePath, ctx.cwd);
      if (errors) {
        blocked = true;
        blockReason = `TypeScript compilation failed for **${filePath}**:\n\n\`\`\`\n${errors}\n\`\`\`\n\nFix the errors and try again.`;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
      ctx.ui.notify(`tsc linting skipped for ${filePath}: ${message}. Change allowed.`, "warning");
    } finally {
      cleanupTemp(tempPath);
    }

    if (blocked) return { block: true, reason: blockReason! };
  });
}
```

## Limitations
- Only covers TypeScript (`.ts`, `.tsx`).
- Requires `npx` and a local `typescript` installation in the project.
- Runs `tsc` only on the **affected file** (temp copy), not the entire project — this is faster but may miss errors that arise from cross-file dependencies.
- For `edit`: if `oldText` is not found in the file, the edit is silently skipped (via `continue`) but the lint check still proceeds on the existing content.
- For `edit`: each `oldText` is replaced only once (using `String.replace`), not all occurrences.
- If `tsc` times out (>30s) or throws unexpectedly, the change is allowed to proceed as a fail-safe.
- Files exceeding 10 MB are skipped with an informational notification.
- The extension creates a temp file (`~filename~`) in the same directory — if the process is killed mid-way, the temp file may be left behind (but the real file is never modified).

## Next Steps
1. Implement the extension in `.pi/extensions/pre-write-lint.ts`.
2. Test with a small quantized model on a TypeScript project.
3. Measure token usage and iteration count compared to the standard workflow.
