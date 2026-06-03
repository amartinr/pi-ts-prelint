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
  diffThreshold: {
    minErrorsToShow: number;
    maxAbsoluteLines: number;
    maxPercentage: number;
  };
}

const DEFAULT_CONFIG: PiTsLintConfig = {
  changeComplexity: {
    minAbsoluteLines: 15,
    minPercentage: 10,
  },
  diffThreshold: {
    minErrorsToShow: 3,
    maxAbsoluteLines: 50,
    maxPercentage: 50,
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
 * Generate a unified diff string between two file contents.
 * Uses the `diff` library's `diffLines` and formats the output
 * in a simple, readable format that the model can easily correlate
 * with compilation error line numbers.
 */
function getDiffString(oldContent: string, newContent: string): string {
  const diffs = diffLines(oldContent, newContent);
  const lines: string[] = [];

  for (const part of diffs) {
    if (part.added) {
      const addedLines = part.value.split("\n");
      // Remove trailing empty string from split
      if (addedLines.length > 0 && addedLines[addedLines.length - 1] === "") {
        addedLines.pop();
      }
      for (const line of addedLines) {
        lines.push(`+ ${line}`);
      }
    } else if (part.removed) {
      const removedLines = part.value.split("\n");
      if (removedLines.length > 0 && removedLines[removedLines.length - 1] === "") {
        removedLines.pop();
      }
      for (const line of removedLines) {
        lines.push(`- ${line}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Determine whether the diff should be included in the error message.
 * The diff is included only when the change is large enough to need context
 * AND small enough to be useful.
 * All three conditions must be met:
 *   1. Error count >= MIN_ERRORS_TO_SHOW (need correlation)
 *   2. Modified lines <= MAX_ABSOLUTE_LINES (diff fits)
 *   3. Modified lines / total lines of new file <= MAX_PERCENTAGE (diff is readable)
 *
 * This ensures the model gets useful context only when it actually needs it,
 * without wasting tokens on diffs for small changes or overwhelming with
 * diffs that are too large to correlate.
 */
function shouldIncludeDiff(
  errorCount: number,
  modifiedLines: number,
  totalLinesNewFile: number,
  diffThreshold: PiTsLintConfig["diffThreshold"]
): boolean {
  if (errorCount < diffThreshold.minErrorsToShow) return false;
  if (totalLinesNewFile === 0) return false; // new file — no "diff" to show

  const percentage = (modifiedLines / totalLinesNewFile) * 100;

  return modifiedLines <= diffThreshold.maxAbsoluteLines && percentage <= diffThreshold.maxPercentage;
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
 * Create a minimal tsconfig.json for linting a single file.
 * Copies compilerOptions from the project tsconfig but omits `include`
 * (which would pull in the whole project) and `extends`.
 * The temp file is placed next to the target so relative paths resolve.
 */
function createTempTsconfig(filePath: string, compilerOptions: Record<string, unknown>, id: string): string | null {
  const dir = path.dirname(filePath);
  const tsconfigPath = path.join(dir, `~tsconfig.${id}.lint.json`);

  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(compilerOptions)) {
    if (key === "include" || key === "exclude" || key === "extends" || key === "rootDir") continue;
    filtered[key] = compilerOptions[key];
  }

  const config = {
    compilerOptions: filtered,
    files: [path.basename(filePath)],
  };

  try {
    fs.writeFileSync(tsconfigPath, JSON.stringify(config, null, 2), "utf-8");
    return tsconfigPath;
  } catch {
    return null;
  }
}

/**
 * Run `tsc --noEmit` on the real file using a minimal temp tsconfig
 * that copies compilerOptions from the project tsconfig but only
 * includes the target file (no `include`/`exclude`/`extends`).
 *
 * Executed from the file's own directory so relative paths resolve.
 */
function runTsc(filePath: string, cwd: string, tempId: string): TscResult {
  const projectConfig = readProjectTsconfig(cwd);
  // filePath is already absolute (passed from tool_call handler), use as-is
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

  // Run from the file's directory so relative paths and temp tsconfig resolve
  const fileDir = path.dirname(absPath);

  if (!projectConfig) {
    // No tsconfig — compile with minimal flags
    try {
      execFileSync("npx", ["tsc", "--noEmit", "--pretty", "false", "--skipLibCheck", "--ignoreConfig", absPath], {
        cwd: fileDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024 * 10,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { errors: null };
    } catch (err: unknown) {
      const nodeErr = err as { stdout?: Buffer | string; stderr?: Buffer | string };
      const output =
        (nodeErr.stdout && typeof nodeErr.stdout.toString === "function" ? nodeErr.stdout.toString() : "") +
        "\n" +
        (nodeErr.stderr && typeof nodeErr.stderr.toString === "function" ? nodeErr.stderr.toString() : "");
      return { errors: output.trim() || null };
    }
  }

  // Create a minimal tsconfig that only includes the target file
  const tempTsconfig = createTempTsconfig(absPath, projectConfig.compilerOptions, tempId);

  try {
    execFileSync("npx", ["tsc", "--project", tempTsconfig ?? ""], {
      cwd: fileDir,
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

    return { errors: output.trim() || null };
  } finally {
    try {
      if (tempTsconfig) {
        fs.rmSync(tempTsconfig, { force: true });
      }
    } catch {
      // Best-effort cleanup
    }
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
 * Store lint decisions keyed by toolCallId so they can be processed
 * in the tool_result handler (where the file already exists).
 */
interface LintDecision {
  filePath: string;
  absPath: string;
  actionType: string;
  cwd: string;
  shouldLint: boolean;
  tempId: string;
  diffLines: number;
  totalLinesNewFile: number;
  diffText: string;
  diffThreshold: PiTsLintConfig["diffThreshold"];
}

const lintDecisionsByToolCallId = new Map<string, LintDecision>();


export default function (pi: ExtensionAPI) {
  // ─── tool_result: run tsc (file now exists) and inject lint errors ───────
  // Cast to any to bypass TypeScript overload resolution (tool_result is
  // available in pi >= 0.75 but the overload union can be tricky)
  ;(pi as any).on("tool_result", async (event: { toolName: string; toolCallId: string; input: { path?: string }; content: unknown }, ctx: ExtensionContext) => {
    const toolCallId = event.toolCallId;
    const decision = lintDecisionsByToolCallId.get(toolCallId);

    if (!decision) return;
    lintDecisionsByToolCallId.delete(toolCallId);

    // If linting was not needed, just return without modification
    if (!decision.shouldLint) return;

    // Run tsc on the now-existing file
    let lintError: string | undefined;
    let errorCount = 0;

    try {
      const { errors } = runTsc(decision.absPath, decision.cwd, decision.tempId);
      if (errors) {
        // Count compilation errors
        errorCount = errors.split("\n").filter((l) => l.includes("error TS")).length || 1;

        // Determine if diff should be included
        const includeDiff = shouldIncludeDiff(
          errorCount,
          decision.diffLines,
          decision.totalLinesNewFile,
          decision.diffThreshold
        );

        let diffBlock = "";
        if (includeDiff && decision.diffText) {
          diffBlock = `\n--- Diff ---\n${decision.diffText}\n`;
        }

        lintError = `[pi-ts-prelint] ${decision.actionType.toUpperCase()} applied, but there are compilation errors. Fix them and try again.${diffBlock}${errors}`;
      }
    } catch (err: unknown) {
      // Unexpected error — allow the change as a fail-safe
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Unknown error";
      console.warn(`tsc linting failed for ${decision.filePath}: ${message}`);
    }

    if (!lintError) return;

    // Notify user about lint errors (warning level — visible, attention-grabbing)
    ctx.ui.notify(
      `⚠️ ${decision.filePath}: ${errorCount} compilation error(s) — ${decision.actionType.toUpperCase()} applied, file modified`,
      "warning"
    );

    // Inject lint errors into the result content.
    // event.content is (TextContent | ImageContent)[]; build a replacement array.
    const parts = Array.isArray(event.content)
      ? event.content.filter((p): p is { type: "text"; text: string } => p.type === "text")
      : [];
    return {
      content: [
        ...parts,
        { type: "text" as const, text: lintError },
      ],
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

    try {
      // Read original content for diff
      let existingContent: string;
      try {
        existingContent = fs.readFileSync(absPath, "utf-8");
      } catch {
        // File doesn't exist yet — always lint new files
        existingContent = "";
      }

      // Determine if linting is needed
      const shouldLintChange = shouldLint(existingContent, newContent, config.changeComplexity);
      const modifiedLines = countModifiedLines(existingContent, newContent);
      const totalLinesNewFile = newContent.split("\n").length;

      // Generate diff text if linting is needed
      let diffText = "";
      if (shouldLintChange) {
        diffText = getDiffString(existingContent, newContent);
      }

      // Store decision for tool_result handler (where file will exist)
      if (shouldLintChange) {
        lintDecisionsByToolCallId.set(event.toolCallId, {
          filePath,
          absPath,
          actionType,
          cwd: ctx.cwd,
          shouldLint: true,
          tempId,
          diffLines: modifiedLines,
          totalLinesNewFile,
          diffText,
          diffThreshold: config.diffThreshold,
        });
      }
    } finally {
      // Always clean up the temp file.
      cleanupTemp(tempPath);
    }
  });
}
