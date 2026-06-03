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
import fs from "node:fs";
import path from "node:path";

import { resolveConfig } from "./config.js";
import type { PiTsLintConfig } from "./config.js";
import { lintTempId, lintTempPath, isTsFile } from "./temp-files.js";
import {
  countModifiedLines,
  getDiffString,
  shouldIncludeDiff,
  shouldLint,
} from "./diff-utils.js";
import { runTsc } from "./tsc-runner.js";

// ─── Shared state ────────────────────────────────────────────────────────────

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

// ─── Temp cleanup ────────────────────────────────────────────────────────────

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

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ─── tool_result: run tsc (file now exists) and inject lint errors ──────
  // Cast to any to bypass TypeScript overload resolution (tool_result is
  // available in pi >= 0.75 but the overload union can be tricky)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pi as any).on(
    "tool_result",
    async (
      event: {
        toolName: string;
        toolCallId: string;
        input: { path?: string };
        content: unknown;
      },
      ctx: ExtensionContext,
    ) => {
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
        const { errors } = runTsc(
          decision.absPath,
          decision.cwd,
          decision.tempId,
        );
        if (errors) {
          // Count compilation errors
          errorCount =
            errors.split("\n").filter((l) => l.includes("error TS")).length ||
            1;

          // Determine if diff should be included
          const includeDiff = shouldIncludeDiff(
            errorCount,
            decision.diffLines,
            decision.totalLinesNewFile,
            decision.diffThreshold,
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

      // Notify user about lint errors (warning level)
      ctx.ui.notify(
        `⚠️ ${decision.filePath}: ${errorCount} compilation error(s) — ${decision.actionType.toUpperCase()} applied, file modified`,
        "warning",
      );

      // Inject lint errors into the result content
      const parts = Array.isArray(event.content)
        ? event.content.filter(
            (p): p is { type: "text"; text: string } => p.type === "text",
          )
        : [];
      return {
        content: [
          ...parts,
          { type: "text" as const, text: lintError },
        ],
      };
    },
  );

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

    // Track which action was attempted
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
      // For `edit`: apply the replacement to the existing file
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
        inputWithSingleEdit.oldText != null &&
        inputWithSingleEdit.newText != null;

      if (!edits && !singleEdit) {
        return;
      }

      newContent = existingContent;

      // Apply array edits first
      if (edits && edits.length > 0) {
        for (const edit of edits) {
          if (!edit.oldText) continue;
          if (!newContent.includes(edit.oldText)) continue;
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
      const shouldLintChange = shouldLint(
        existingContent,
        newContent,
        config.changeComplexity,
      );
      const modifiedLines = countModifiedLines(existingContent, newContent);
      const totalLinesNewFile = newContent.split("\n").length;

      // Generate diff text if linting is needed
      let diffText = "";
      if (shouldLintChange) {
        diffText = getDiffString(existingContent, newContent);
      }

      // Store decision for tool_result handler
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
      // Always clean up the temp file
      cleanupTemp(tempPath);
    }
  });
}
