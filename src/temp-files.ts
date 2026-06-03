/**
 * Helpers for generating temp file paths and IDs.
 * Uses a ~ prefix so tsc won't match them in glob patterns.
 */

import path from "node:path";
import crypto from "node:crypto";

export const GIT_SHORT_HASH_LEN = 7;

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
export function lintTempId(basename: string): string {
  const dateStr = new Date()
    .toISOString()
    .replace(/[T:.]/g, "-")
    .split(".")[0];
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
export function lintTempPath(filePath: string, id: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const name = base.slice(0, base.lastIndexOf("."));
  const ext = base.slice(base.lastIndexOf("."));
  return path.join(dir, `~${name}.${id}${ext}`);
}

/**
 * Check whether a file path points to a TypeScript file (.ts or .tsx).
 * Case-insensitive for the extension.
 */
export function isTsFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".ts" || ext === ".tsx";
}
