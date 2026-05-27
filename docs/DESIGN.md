# Design: Pre-Write Linting Extension

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

## Limitations
- Only covers TypeScript (`.ts`, `.tsx`).
- Requires `npx` and a local `typescript` installation in the project.
- Runs `tsc` only on the **affected file** (temp copy), not the entire project — this is faster but may miss errors that arise from cross-file dependencies.
- For `edit`: if `oldText` is not found in the file, the edit is silently skipped (via `continue`) but the lint check still proceeds on the existing content.
- For `edit`: each `oldText` is replaced only once (using `String.replace`), not all occurrences.
- If `tsc` times out (>30s) or throws unexpectedly, the change is allowed to proceed as a fail-safe.
- Files exceeding 10 MB are skipped with an informational notification.
- The extension creates two temp files: `~filename.hash.ext` in the same directory and `~tsconfig.hash.json` in the project root — if the process is killed mid-way, both may be left behind (but the real file is never modified).

.
