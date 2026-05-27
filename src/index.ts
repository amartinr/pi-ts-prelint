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

const GIT_SHORT_HASH_LEN = 7;

// ─── Configuration ───────────────────────────────────────────────────────────

interface PiTsLintConfig {
  changeComplexity: {
    minAbsoluteLines: number;
    minPercentage: number;
  };
  maxFileSizeMB: number;
  tscTimeoutMs: number;
}

const DEFAULT_CONFIG: PiTsLintConfig = {
  changeComplexity: {
    minAbsoluteLines: 5,
    minPercentage: 5,
  },
  maxFileSizeMB: 10,
  tscTimeoutMs: 30_000,
};

function deepMerge<T>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const val = override[key];
    if (val != null && typeof val === "object" && !Array.isArray(val) && result[key] != null && typeof result[key] === "object" && !Array.isArray(result[key])) {
      (result[key] as any) = deepMerge(result[key], val as any);
    } else {
      (result as any)[key] = val;
    }
  }
  return result;
}

function loadConfigFile<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function resolveConfig(cwd: string): PiTsLintConfig {
  // Global config: ~/.pi/agent/extensions/pi-ts-lint/config.json
  const homeDir = process.env.HOME;
  const globalConfigPath = homeDir
    ? path.join(homeDir, ".pi", "agent", "extensions", "pi-ts-lint", "config.json")
    : null;

  // Project config: .pi/pi-ts-lint.json (relative to cwd)
  const projectConfigPath = path.join(cwd, ".pi", "pi-ts-lint.json");

  const globalConfig = globalConfigPath ? loadConfigFile<PiTsLintConfig>(globalConfigPath) : null;
  const projectConfig = loadConfigFile<PiTsLintConfig>(projectConfigPath);

  return deepMerge(
    deepMerge(DEFAULT_CONFIG, globalConfig ?? {}),
    projectConfig ?? {}
  );
}

// ─── End configuration ───────────────────────────────────────────────────────

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
function lintTempPath(filePath: string, id: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const name = base.slice(0, base.lastIndexOf("."));
  const ext = base.slice(base.lastIndexOf("."));
  return path.join(dir, `~${name}.${id}${ext}`);
}

/**
 * Generate a temporary tsconfig path for linting.
 * Placed in the project root (cwd) so it can extend the main tsconfig.json.
 * Uses the same hash as the temp TS file to link them, and ~ prefix so it
 * won't be picked up by other tsconfig discovery patterns.
 * e.g. project root → ~tsconfig.a1b2c3d.json
 */
function lintTempTsconfigPath(id: string): string {
  return path.join(`~tsconfig.${id}.json`);
}

function isTsFile(filePath: string): boolean {
  // .toLowerCase() ensures case-insensitive matching (Windows paths are case-insensitive)
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".ts" || ext === ".tsx";
}

/**
 * Count the number of lines that differ between two strings.
 * Uses a simple line-by-line comparison (O(n) where n = min lines of both files).
 * Returns the count of lines that are different in at least one of the two strings.
 */
function countModifiedLines(oldContent: string, newContent: string): number {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLen = Math.max(oldLines.length, newLines.length);
  let modified = 0;
  for (let i = 0; i < maxLen; i++) {
    if (oldLines[i] !== newLines[i]) {
      modified++;
    }
  }
  return modified;
}

/**
 * Determine whether linting should be skipped based on change complexity.
 * Linting is skipped when the change is too small to justify the cost.
 * Both conditions must be met:
 *   1. Modified lines < MIN_ABSOLUTE_LINES
 *   2. Modified lines / total lines < MIN_PERCENTAGE
 */
function shouldSkipLint(existingContent: string, newContent: string, changeComplexity: PiTsLintConfig["changeComplexity"]): boolean {
  const modifiedLines = countModifiedLines(existingContent, newContent);
  const totalLines = existingContent.split("\n").length;

  if (totalLines === 0) return false; // new file — always lint

  const percentage = (modifiedLines / totalLines) * 100;

  return modifiedLines < changeComplexity.minAbsoluteLines && percentage < changeComplexity.minPercentage;
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
async function runTsc(tempPath: string, tempTsconfigPath: string, cwd: string, timeoutMs: number): Promise<TscResult> {
  try {
    await execFileAsync("npx", ["tsc", "--noEmit", "--pretty", "false", "-p", tempTsconfigPath], {
      cwd,
      timeout: timeoutMs,
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

    const config = resolveConfig(ctx.cwd);
    const absPath = path.resolve(ctx.cwd, filePath);
    const tempId = lintTempId(path.basename(filePath));
    const tempPath = path.resolve(ctx.cwd, lintTempPath(filePath, tempId));

    const maxFileSize = config.maxFileSizeMB * 1024 * 1024;

    // Skip files that are too large to lint (avoids memory issues)
    let existingSize = 0;
    try {
      existingSize = fs.statSync(absPath).size;
    } catch {
      // File doesn't exist yet
    }
    if (existingSize > maxFileSize) {
      ctx.ui.notify(
        `Skipping lint for ${filePath}: file exceeds ${config.maxFileSizeMB} MB limit.`,
        "info"
      );
      return;
    }

    // Build the content that would result from this write/edit
    let newContent: string;

    if (isToolCallEventType("write", event)) {
      newContent = event.input.content;
      // Check size of new content for write events
      if (newContent.length > maxFileSize) {
        ctx.ui.notify(
          `Skipping lint for ${filePath}: new content exceeds ${config.maxFileSizeMB} MB limit.`,
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

      // Skip linting for small changes that don't justify the cost
      if (shouldSkipLint(existingContent, newContent, config.changeComplexity)) {
        return;
      }
    }

    // Write candidate content to a temp file so tsc can lint it
    // without touching the real file (safe for multi-agent scenarios).
    fs.writeFileSync(tempPath, newContent, "utf-8");

    // Create a temporary tsconfig in the project root that extends the
    // main tsconfig.json (preserving moduleResolution, lib, etc.) but only
    // includes the single temp file. This avoids --ignoreConfig which would
    // load tsc without the project's module resolution settings.
    const tempTsconfigPath = path.resolve(ctx.cwd, lintTempTsconfigPath(tempId));
    const tempTsconfigContent = JSON.stringify({
      extends: "./tsconfig.json",
      include: [path.relative(ctx.cwd, tempPath)],
    }, null, 2);
    fs.writeFileSync(tempTsconfigPath, tempTsconfigContent, "utf-8");

    let blocked = false;
    let blockReason: string | undefined;

    try {
      const { errors } = await runTsc(tempPath, tempTsconfigPath, ctx.cwd, config.tscTimeoutMs);

      if (errors) {
        blocked = true;
        // Replace temp file paths with the real file path so the agent
        // can directly fix the errors without mapping temp → real.
        const formattedErrors = errors.replaceAll(tempPath, filePath);
        blockReason = `[pi-ts-lint] Fix linting errors and try again.\n${formattedErrors}`;
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
