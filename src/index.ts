/**
 * Pre-Write Linting Extension
 *
 * Intercepts `write` and `edit` tool calls for TypeScript files (.ts, .tsx),
 * calculates the change complexity using a temp file, and runs `tsc --noEmit`
 * on the real file with the project's compiler options (extracted from tsconfig.json,
 * no `extends`). If compilation fails, errors are injected into the tool result.
 * The change is always applied — the model sees the errors and the modified file.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { diffLines } from "diff";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const GIT_SHORT_HASH_LEN = 7;

// ─── Configuration ───────────────────────────────────────────────────────────

interface PiTsLintConfig {
  changeComplexity: {
    minAbsoluteLines: number;
    minPercentage: number;
  };
}

const DEFAULT_CONFIG: PiTsLintConfig = {
  changeComplexity: {
    minAbsoluteLines: 15,
    minPercentage: 10,
  },
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
  // Global config: ~/.pi/agent/extensions/pi-ts-prelint/config.json
  const homeDir = process.env.HOME;
  const globalConfigPath = homeDir
    ? path.join(homeDir, ".pi", "agent", "extensions", "pi-ts-prelint", "config.json")
    : null;

  // Project config: .pi/pi-ts-prelint.json (relative to cwd)
  const projectConfigPath = path.join(cwd, ".pi", "pi-ts-prelint.json");

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

function isTsFile(filePath: string): boolean {
  // .toLowerCase() ensures case-insensitive matching (Windows paths are case-insensitive)
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".ts" || ext === ".tsx";
}

/**
 * Count the number of lines that differ between two strings.
 * Uses the `diff` library's `diffLines` to compute a line-level diff,
 * then counts the total lines that are added or removed.
 * This correctly handles insertions, deletions, and moves without
 * inflating the count due to positional shifts.
 */
function countModifiedLines(oldContent: string, newContent: string): number {
  const diffs = diffLines(oldContent, newContent);
  let modified = 0;
  for (const part of diffs) {
    if (part.added || part.removed) {
      modified += part.count;
    }
  }
  return modified;
}

/**
 * Determine whether linting should be performed based on change complexity.
 * Linting is performed only when the change is large enough to justify the cost.
 * A change is considered "large" only when BOTH conditions are met:
 *   1. Modified lines >= MIN_ABSOLUTE_LINES
 *   2. Modified lines / total lines >= MIN_PERCENTAGE
 *
 * This allows the agent to make small or localized changes without friction,
 * while ensuring that significant changes (many lines AND high percentage)
 * are validated. Errors are injected into the tool result so the model can fix them.
 */
function shouldLint(existingContent: string, newContent: string, changeComplexity: PiTsLintConfig["changeComplexity"]): boolean {
  const modifiedLines = countModifiedLines(existingContent, newContent);
  const totalLines = existingContent.split("\n").length;

  if (totalLines === 0) return true; // new file — always lint

  const percentage = (modifiedLines / totalLines) * 100;

  return modifiedLines >= changeComplexity.minAbsoluteLines && percentage >= changeComplexity.minPercentage;
}

/**
 * Result of running tsc on the real file.
 * tsc only produces errors, never warnings (warnings are editor-only).
 */
interface TscResult {
  /** Compilation errors (null if compilation succeeded) */
  errors: string | null;
}

/**
 * Extract compilerOptions from the project's tsconfig.json and convert them
 * to tsc CLI flags. This avoids creating a temporary tsconfig with `extends`.
 *
 * Options that cannot be passed as flags (paths, plugins) are skipped.
 */
function tsconfigToTscFlags(compilerOptions: Record<string, unknown>, filePath: string): string[] {
  const flags: string[] = ["--noEmit", "--pretty", "false"];

  const flagMap: Record<string, string> = {
    target: "--target",
    module: "--module",
    moduleResolution: "--moduleResolution",
    jsx: "--jsx",
    lib: "--lib",
    strict: "--strict",
    declaration: "--declaration",
    sourceMap: "--sourceMap",
    inlineSourceMap: "--inlineSourceMap",
    outDir: "--outDir",
    rootDir: "--rootDir",
    baseUrl: "--baseUrl",
    esModuleInterop: "--esModuleInterop",
    allowSyntheticDefaultImports: "--allowSyntheticDefaultImports",
    resolveJsonModule: "--resolveJsonModule",
    skipLibCheck: "--skipLibCheck",
    noEmit: "--noEmit",
    isolatedModules: "--isolatedModules",
    verbatimModuleSyntax: "--verbatimModuleSyntax",
  };

  for (const [key, flag] of Object.entries(flagMap)) {
    const value = compilerOptions[key];
    if (value === undefined || value === null) continue;

    if (typeof value === "boolean") {
      if (value) {
        flags.push(flag);
      }
      // If false, don't pass the flag (tsc default is fine)
    } else if (typeof value === "string") {
      flags.push(flag, value);
    } else if (Array.isArray(value)) {
      flags.push(flag, value.join(","));
    }
  }

  // Add the file path as the last argument
  flags.push(filePath);

  return flags;
}

/**
 * Read and parse the project's tsconfig.json, extracting compilerOptions.
 * Returns null if tsconfig.json doesn't exist or can't be parsed.
 */
function readProjectTsconfig(cwd: string): { compilerOptions: Record<string, unknown> } | null {
  const tsconfigPath = path.join(cwd, "tsconfig.json");
  try {
    const raw = fs.readFileSync(tsconfigPath, "utf-8");
    const config = JSON.parse(raw) as { compilerOptions?: Record<string, unknown> };
    return { compilerOptions: config.compilerOptions ?? {} };
  } catch {
    return null;
  }
}

/**
 * Run `tsc --noEmit` on the real file using compiler options from the project's tsconfig.json.
 * No temporary tsconfig is created — options are passed as CLI flags.
 */
function runTsc(filePath: string, cwd: string): TscResult {
  const projectConfig = readProjectTsconfig(cwd);

  const flags = projectConfig
    ? tsconfigToTscFlags(projectConfig.compilerOptions, filePath)
    : ["--noEmit", "--pretty", "false", "--skipLibCheck", filePath];

  try {
    execFileSync("npx", ["tsc", ...flags], {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024 * 1024 * 10,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { errors: null }; // Success
  } catch (err: unknown) {
    const nodeErr = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const output =
      (nodeErr.stdout && typeof nodeErr.stdout.toString === "function" ? nodeErr.stdout.toString() : "") +
      "\n" +
      (nodeErr.stderr && typeof nodeErr.stderr.toString === "function" ? nodeErr.stderr.toString() : "");

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
 * Store lint errors keyed by toolCallId so they can be injected
 * into the tool_result by the tool_result handler.
 */
const lintErrorsByToolCallId = new Map<string, string>();

/**
 * Clean up the stored lint errors for a given toolCallId.
 */
function clearLintErrors(toolCallId: string): void {
  lintErrorsByToolCallId.delete(toolCallId);
}

export default function (pi: ExtensionAPI) {
  // ─── tool_result: inject lint errors into the model's view ────────────────
  // Cast to any to bypass TypeScript overload resolution (tool_result is
  // available in pi >= 0.75 but the overload union can be tricky)
  ;(pi as any).on("tool_result", (event: { toolName: string; toolCallId: string; input: { path?: string }; content: unknown }) => {
    const toolCallId = event.toolCallId;
    const storedErrors = lintErrorsByToolCallId.get(toolCallId);

    if (!storedErrors) return;

    // Only inject for write/edit on .ts/.tsx files
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const filePath = (event.input as { path?: string })?.path;
    if (!filePath || !isTsFile(filePath)) return;

    // Remove from map to prevent double-injection
    lintErrorsByToolCallId.delete(toolCallId);

    // Inject lint errors into the result content
    const existingContent = typeof event.content === "string" ? event.content : "";
    return {
      content: `${existingContent}\n\n${storedErrors}`,
    };
  });

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

    // Track which action was attempted so we can report it in error messages
    const actionType = isToolCallEventType("write", event) ? "write" : "edit";

    const config = resolveConfig(ctx.cwd);
    const absPath = path.resolve(ctx.cwd, filePath);
    const tempId = lintTempId(path.basename(filePath));
    const tempPath = path.resolve(ctx.cwd, lintTempPath(filePath, tempId));

    // Build the content that would result from this write/edit
    let newContent: string;

    if (isToolCallEventType("write", event)) {
      newContent = event.input.content;
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

    // Write candidate content to a temp file for diff calculation
    fs.writeFileSync(tempPath, newContent, "utf-8");

    let lintError: string | undefined;

    try {
      // Read original content for diff
      let existingContent: string;
      try {
        existingContent = fs.readFileSync(absPath, "utf-8");
      } catch {
        // File doesn't exist yet — always lint new files
        existingContent = "";
      }

      // Only lint changes that are large enough to justify the cost
      if (shouldLint(existingContent, newContent, config.changeComplexity)) {
        // Run tsc on the REAL file (already modified by the original tool)
        // using compiler options from the project's tsconfig.json (no extends)
        const { errors } = runTsc(absPath, ctx.cwd);

        if (errors) {
          lintError = `[pi-ts-prelint] ${actionType.toUpperCase()} applied, but there are compilation errors. Fix them and try again.\n${errors}`;
        }
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
      // Always clean up the temp file.
      cleanupTemp(tempPath);
    }

    // Store lint errors for injection into tool_result
    if (lintError) {
      lintErrorsByToolCallId.set(event.toolCallId, lintError);
      // Notify user about lint errors (warning level — visible, attention-grabbing)
      const errorCount = lintError.split("\n").filter(l => l.startsWith("error TS")).length || 1;
      ctx.ui.notify(
        `⚠️ ${filePath}: ${errorCount} compilation error(s) — ${actionType.toUpperCase()} applied, file modified`,
        "warning"
      );
    }
  });
}
