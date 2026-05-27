/**
 * Pre-Write Linting Extension
 *
 * Intercepts `write` and `edit` tool calls for TypeScript files (.ts, .tsx),
 * writes the candidate content to a temp file (prefixed with ~),
 * runs `tsc --noEmit` on the temp file, and blocks the change if compilation
 * fails. The real file is never modified during linting.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// tsconfig.json target is ES2022, so numeric separators (30_000) are supported
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
  // .toLowerCase() ensures case-insensitive matching (Windows paths are case-insensitive)
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".ts" || ext === ".tsx";
}

/**
 * Result of running tsc on the temp file.
 * tsc only produces errors, never warnings (warnings are editor-only).
 */
interface TscResult {
  /** Compilation errors (null if compilation succeeded) */
  errors: string | null;
}

/**
 * Run `tsc --noEmit` on the temp file using a temporary tsconfig.
 * The temp tsconfig extends the project's tsconfig.json (loading correct
 * moduleResolution, lib, etc.) but only includes the single temp file.
 */
async function runTsc(tempPath: string, tempTsconfigPath: string, cwd: string): Promise<TscResult> {
  try {
    await execFileAsync("npx", ["tsc", "--noEmit", "--pretty", "false", "-p", tempTsconfigPath], {
      cwd,
      timeout: TSC_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 10,
    });
    return { errors: null }; // Success
  } catch (err: unknown) {
    const nodeErr = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const output =
      (nodeErr.stdout && typeof nodeErr.stdout.toString === "function" ? nodeErr.stdout.toString() : "") +
      "\n" +
      (nodeErr.stderr && typeof nodeErr.stderr.toString === "function" ? nodeErr.stderr.toString() : "");

    // tsc output format (with --pretty false, loaded via temp tsconfig):
    //   src/~file.a1b2c3d.ts:10:5 - error TS1234: Some error message
    //
    // With these flags, tsc produces ONLY compilation errors — no summaries,
    // no diagnostics, no warnings. Every line of output is relevant.
    const errors = output.trim();

    return {
      errors: errors || null,
    };
  }
}

/**
 * Clean up the temp file, ignoring errors.
 */
function cleanupTemp(tempPath: string): void {
  try {
    fs.rmSync(tempPath, { force: true });
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Clean up the temporary tsconfig, ignoring errors.
 */
function cleanupTempTsconfig(tempTsconfigPath: string): void {
  try {
    fs.rmSync(tempTsconfigPath, { force: true });
  } catch {
    // Best-effort cleanup
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    // Only intercept write and edit tool calls
    if (
      !isToolCallEventType("write", event) &&
      !isToolCallEventType("edit", event)
    ) {
      return;
    }

    const filePath = event.input.path;
    if (!filePath || !isTsFile(filePath)) {
      return;
    }

    const absPath = path.resolve(ctx.cwd, filePath);
    const tempPath = path.resolve(ctx.cwd, lintTempPath(filePath));

    // Skip files that are too large to lint (avoids memory issues)
    let existingSize = 0;
    try {
      existingSize = fs.statSync(absPath).size;
    } catch {
      // File doesn't exist yet
    }
    if (existingSize > MAX_FILE_SIZE) {
      ctx.ui.notify(
        `Skipping lint for ${filePath}: file exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit.`,
        "info"
      );
      return;
    }

    // Build the content that would result from this write/edit
    let newContent: string;

    if (isToolCallEventType("write", event)) {
      newContent = event.input.content;
      // Check size of new content for write events
      if (newContent.length > MAX_FILE_SIZE) {
        ctx.ui.notify(
          `Skipping lint for ${filePath}: new content exceeds ${MAX_FILE_SIZE / 1024 / 1024} MB limit.`,
          "info"
        );
        return;
      }
    } else {
      // For `edit`: apply the replacement to the existing file to get
      // the content that would result from this edit
      let existingContent: string;
      try {
        existingContent = fs.readFileSync(absPath, "utf-8");
      } catch {
        // File doesn't exist yet — skip linting to avoid false negatives
        return;
      }

      // Support both formats:
      // - Array of edits: { edits: [{ oldText, newText }, ...] }
      // - Single edit: { oldText, newText }
      const edits = event.input.edits;
      const inputWithSingleEdit = event.input as {
        oldText?: string;
        newText?: string;
      };
      const singleEdit =
        inputWithSingleEdit.oldText != null && inputWithSingleEdit.newText != null;

      if (!edits && !singleEdit) {
        return;
      }

      newContent = existingContent;

      // Apply array edits first
      if (edits && edits.length > 0) {
        for (const edit of edits) {
          if (!edit.oldText) continue;
          if (!newContent.includes(edit.oldText)) continue;
          // newText ?? "" means undefined → delete oldText (replacement with empty string)
          newContent = newContent.replace(edit.oldText, edit.newText ?? "");
        }
      }

      // Apply single edit (alternative format)
      if (singleEdit) {
        const { oldText, newText } = inputWithSingleEdit;
        if (newContent.includes(oldText!)) {
          newContent = newContent.replace(oldText!, newText ?? "");
        }
      }
    }

    // Write candidate content to a temp file so tsc can lint it
    // without touching the real file (safe for multi-agent scenarios).
    fs.writeFileSync(tempPath, newContent, "utf-8");

    // Create a temporary tsconfig in the project root that extends the
    // main tsconfig.json (preserving moduleResolution, lib, etc.) but only
    // includes the single temp file. This avoids --ignoreConfig which would
    // load tsc without the project's module resolution settings.
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
      // Unexpected error (e.g., npx not found) — allow the change as a fail-safe
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Unknown error";
      ctx.ui.notify(
        `tsc linting skipped for ${filePath}: ${message}. Change allowed.`,
        "warning"
      );
    } finally {
      // Always clean up both temp files.
      cleanupTemp(tempPath);
      cleanupTempTsconfig(tempTsconfigPath);
    }

    if (blocked) {
      // Notify about blocking errors (warning level — visible, attention-grabbing)
      const errorCount = blockReason!.split("\n").filter(l => l.startsWith("error TS")).length || 1;
      ctx.ui.notify(
        `❌ ${filePath}: ${errorCount} compilation error(s) — change blocked`,
        "warning"
      );
      return { block: true, reason: blockReason! };
    }
  });
}
