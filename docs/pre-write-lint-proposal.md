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
5. The resulting content is **written to a temp file** in the same directory as the target, with a `~` prefix and a short hash infix (e.g. `src/foo.ts` → `src/~foo.a1b2c3d.ts`). This keeps the real file untouched during linting and avoids collisions when multiple agents lint the same file.
6. A **temporary tsconfig** is created in the project root (e.g. `~tsconfig.a1b2c3d.json`) that extends the project's `tsconfig.json` but only includes the single temp file.
7. `npx tsc --noEmit --pretty false -p <tempTsconfig>` is run using the temporary tsconfig. This preserves `moduleResolution`, `lib`, and other project settings that `--ignoreConfig` would lose.
8. Because the tsconfig only includes the temp file, **every line of `tsc` output is a relevant compilation error** — no filtering is needed.
9. If there are errors: the change is **blocked**, the error output is returned to the agent, and a UI notification (`❌ ${filePath}: ${errorCount} compilation error(s) — change blocked`) is shown.
10. If compilation succeeds: the extension cleans up **both** the temp file and the temp tsconfig in a `finally` block (the actual `write`/`edit` tool will apply the change).
11. If `tsc` times out or throws unexpectedly, the change is allowed to proceed as a fail-safe and a warning notification is shown.

## Implementation Notes

The actual implementation diverges from the original sketch in several ways:

- **Temp file with `~` prefix and hash infix**: The candidate content is written to a temp file in the same directory as the target (e.g. `src/~foo.a1b2c3d.ts`). The `~` prefix and hash infix prevent glob matching and avoid collisions when multiple agents lint the same file. The trailing `~` is omitted because `tsc` rejects unsupported extensions (e.g. `.ts~`). The extension must remain exactly `.ts` or `.tsx`.
- **Temporary tsconfig for `tsc`**: Instead of running `tsc` directly on the temp file, a temporary tsconfig is created in the project root that extends the project's `tsconfig.json` (preserving `moduleResolution`, `lib`, `target`, etc.) but only includes the single temp file. This is invoked via `tsc -p <tempTsconfig>`.
- **No error filtering needed**: Because the temp tsconfig only includes the temp file, `tsc` produces only errors for that file. Every line of output is relevant — no regex filtering is required.
- **Multiple edits**: For `edit` events, all `oldText`/`newText` pairs are applied sequentially using `String.replace()` (each `oldText` is replaced only once).
- **`oldText` not found**: If `oldText` is missing from the file, the edit is silently skipped (via `continue`) but the lint check still proceeds on the existing content.
- **Single-edit format**: In addition to the array format `{ edits: [...] }`, the extension also supports a single-edit format `{ oldText, newText }` as direct properties of `event.input`.
- **File size limit**: Files exceeding 10 MB are skipped with an informational notification (both for existing file size and for new content on `write` events).
- **UI notifications**: When blocking, a UI notification shows the file path and error count (`❌ ${filePath}: ${errorCount} compilation error(s) — change blocked`).
- **Cleanup of both temp files**: In the `finally` block, both the temp TS file and the temp tsconfig are cleaned up.
- **Hash generation**: Temp file IDs are generated using `crypto.createHash("sha256")` with the basename + ISO date, styled like a short git commit hash (7 chars).

```typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TSC_TIMEOUT_MS = 30_000;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const GIT_SHORT_HASH_LEN = 7;

/**
 * Generate a short, git-like hash from a string.
 * Returns the first `len` hex characters of the SHA-256 digest.
 * e.g. "foo" → "a1b2c3d"
 */
function gitShortHash(input: string, len = GIT_SHORT_HASH_LEN): string {
  return crypto
    .createHash("sha256")
    .update(input)
    .digest("hex")
    .slice(0, len);
}

/**
 * Generate a unique ID for a temp lint file.
 * Based on the file basename + current date, styled like a short git commit hash.
 * e.g. "foo.ts" → "a1b2c3d"
 */
function lintTempId(basename: string): string {
  const dateStr = new Date().toISOString().replace(/[T:.]/g, "-").split(".")[0];
  return gitShortHash(`${basename}-${dateStr}`);
}

/**
 * Generate a temp file path for linting.
 * Uses a ~ prefix with a short hash infix so tsc won't match it in glob
 * patterns, and avoids collisions when multiple agents lint the same file.
 * The trailing ~ is omitted because tsc rejects unsupported extensions
 * (e.g. ".ts~"). The extension must remain exactly ".ts" or ".tsx".
 * e.g. src/foo.ts → src/~foo.a1b2c3d.ts
 */
function lintTempPath(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const name = base.slice(0, base.lastIndexOf("."));
  const ext = base.slice(base.lastIndexOf("."));
  const id = lintTempId(base);
  return path.join(dir, `~${name}.${id}${ext}`);
}

/**
 * Generate a temporary tsconfig path for linting.
 * Placed in the project root (cwd) so it can extend the main tsconfig.json.
 * Uses the same hash as the temp TS file to link them, and ~ prefix so it
 * won't be picked up by other tsconfig discovery patterns.
 * e.g. project root → ~tsconfig.a1b2c3d.json
 */
function lintTempTsconfigPath(filePath: string): string {
  const id = lintTempId(path.basename(filePath));
  return path.join("~tsconfig.${id}.json");
}

function isTsFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".ts" || ext === ".tsx";
}

interface TscResult {
  errors: string | null;
}

async function runTsc(tempPath: string, tempTsconfigPath: string, cwd: string): Promise<TscResult> {
  try {
    await execFileAsync("npx", ["tsc", "--noEmit", "--pretty", "false", "-p", tempTsconfigPath], {
      cwd,
      timeout: TSC_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 10,
    });
    return { errors: null };
  } catch (err: unknown) {
    const nodeErr = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const output =
      (nodeErr.stdout && typeof nodeErr.stdout.toString === "function" ? nodeErr.stdout.toString() : "") +
      "\n" +
      (nodeErr.stderr && typeof nodeErr.stderr.toString === "function" ? nodeErr.stderr.toString() : "");
    // With these flags, tsc produces ONLY compilation errors — no summaries,
    // no diagnostics, no warnings. Every line of output is relevant.
    const errors = output.trim();
    return { errors: errors || null };
  }
}

function cleanupTemp(tempPath: string): void {
  try { fs.rmSync(tempPath, { force: true }); } catch {}
}

function cleanupTempTsconfig(tempTsconfigPath: string): void {
  try { fs.rmSync(tempTsconfigPath, { force: true }); } catch {}
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

    // Create a temporary tsconfig that extends the project's tsconfig.json
    // but only includes the single temp file.
    const tempTsconfigPath = path.resolve(ctx.cwd, lintTempTsconfigPath(filePath));
    const tempTsconfigContent = JSON.stringify({
      extends: "./tsconfig.json",
      include: [path.relative(ctx.cwd, tempPath)],
    }, null, 2);
    fs.writeFileSync(tempTsconfigPath, tempTsconfigContent, "utf-8");

    let blocked = false;
    let blockReason: string | undefined;

    try {
      const { errors } = await runTsc(tempPath, tempTsconfigPath, ctx.cwd);

      if (errors) {
        blocked = true;
        blockReason = `TypeScript compilation failed for **${filePath}**:\n\n\`\`\`\n${errors}\n\`\`\`\n\nFix the errors and try again.`;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
      ctx.ui.notify(`tsc linting skipped for ${filePath}: ${message}. Change allowed.`, "warning");
    } finally {
      cleanupTemp(tempPath);
      cleanupTempTsconfig(tempTsconfigPath);
    }

    if (blocked) {
      const errorCount = blockReason!.split("\n").filter(l => l.startsWith("error TS")).length || 1;
      ctx.ui.notify(
        `❌ ${filePath}: ${errorCount} compilation error(s) — change blocked`,
        "warning"
      );
      return { block: true, reason: blockReason! };
    }
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
- The extension creates two temp files: `~filename.hash.ext` in the same directory and `~tsconfig.hash.json` in the project root — if the process is killed mid-way, both may be left behind (but the real file is never modified).

## Current Status
The extension has been implemented and is ready for testing.

## Next Steps
1. Test with a small quantized model on a TypeScript project.
2. Measure token usage and iteration count compared to the standard workflow.
3. Consider extending support to other statically-typed languages (e.g., `.js` with JSDoc, `.jsx`).
