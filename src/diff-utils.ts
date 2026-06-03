/**
 * Diff computation, line counting, and threshold decisions.
 */

import { diffLines } from "diff";
import type { PiTsLintConfig } from "./config.js";

/**
 * Count the number of lines that differ between two strings.
 * Uses the `diff` library's `diffLines` to compute a line-level diff,
 * then counts the total lines that are added or removed.
 * This correctly handles insertions, deletions, and moves without
 * inflating the count due to positional shifts.
 */
export function countModifiedLines(
  oldContent: string,
  newContent: string,
): number {
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
export function getDiffString(
  oldContent: string,
  newContent: string,
): string {
  const diffs = diffLines(oldContent, newContent);
  const lines: string[] = [];

  for (const part of diffs) {
    if (part.added) {
      const addedLines = part.value.split("\n");
      // Remove trailing empty string from split
      if (
        addedLines.length > 0 &&
        addedLines[addedLines.length - 1] === ""
      ) {
        addedLines.pop();
      }
      for (const line of addedLines) {
        lines.push(`+ ${line}`);
      }
    } else if (part.removed) {
      const removedLines = part.value.split("\n");
      if (
        removedLines.length > 0 &&
        removedLines[removedLines.length - 1] === ""
      ) {
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
 */
export function shouldIncludeDiff(
  errorCount: number,
  modifiedLines: number,
  totalLinesNewFile: number,
  diffThreshold: PiTsLintConfig["diffThreshold"],
): boolean {
  if (errorCount < diffThreshold.minErrorsToShow) return false;
  if (totalLinesNewFile === 0) return false; // new file — no "diff" to show

  const percentage = (modifiedLines / totalLinesNewFile) * 100;

  return (
    modifiedLines <= diffThreshold.maxAbsoluteLines &&
    percentage <= diffThreshold.maxPercentage
  );
}

/**
 * Determine whether linting should be performed based on change complexity.
 * Linting is performed only when the change is large enough to justify the cost.
 * A change is considered "large" when EITHER condition is met:
 *   1. Modified lines >= MIN_ABSOLUTE_LINES
 *   2. Modified lines / total lines >= MIN_PERCENTAGE
 */
export function shouldLint(
  existingContent: string,
  newContent: string,
  changeComplexity: PiTsLintConfig["changeComplexity"],
): boolean {
  const modifiedLines = countModifiedLines(existingContent, newContent);
  const totalLines = existingContent.split("\n").length;

  if (totalLines === 0) return true; // new file — always lint

  const percentage = (modifiedLines / totalLines) * 100;

  return (
    modifiedLines >= changeComplexity.minAbsoluteLines ||
    percentage >= changeComplexity.minPercentage
  );
}
