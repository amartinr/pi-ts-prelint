# Design: Pre-Write Linting Extension

## Context
We are working with small, quantized language models. These models are prone to syntactic and type errors, and they often struggle to interpret complex runtime error messages, leading to long loops of writing, failing, and retrying.

## The Hypothesis
Pre-write linting with `tsc` can save tokens by:
1. Catching type/syntax errors **before** the code is persisted to the project.
2. Providing structured, line-specific error messages that are easier for small models to interpret than runtime stack traces.
3. Preventing the session context from being contaminated with code that the model will then have to "unlearn" or fix in subsequent turns.

## The Proposal
A minimal pi extension that intercepts `write` and `edit` tool calls for TypeScript files (`.ts`, `.tsx`) and runs a quick type-check. If compilation fails, errors are injected into the tool result so the model can fix them. The change is **never blocked** — the model always sees the modified file.

## The Flow

1. Agent calls `write("src/foo.ts", content)` or `edit("src/foo.ts", { oldText, newText })`.
2. Extension intercepts the call via the `tool_call` event.
3. If the target is **not** a `.ts` / `.tsx` file, the extension passes through.
4. The extension builds the resulting file content:
   - For `write`: uses `event.input.content` directly.
   - For `edit`: reads the existing file, applies each `oldText` → `newText` replacement sequentially (each `oldText` is replaced only once, using `String.replace`).
5. The resulting content is **written to a temp file** (prefixed with `~`) to calculate the diff with the existing file.
6. The diff is computed to determine whether the change is large enough to justify linting cost.
7. If the change is small enough, the extension passes through without linting.
8. If the change is large enough, `npx tsc --noEmit` is run on the **real file** (already modified by the original tool) using the project's compiler options from `tsconfig.json` (passed as CLI flags, no temp tsconfig).
9. If compilation fails, the errors are stored and the change proceeds (the file is modified).
10. After the tool executes, the compilation errors are injected into the tool result so the model sees them.
11. The temp file is cleaned up.
12. If `tsc` throws unexpectedly, the change is allowed to proceed as a fail-safe and a warning notification is shown.

## Implementation Notes

- **Temp file for diff only**: The candidate content is written to a temp file in the same directory as the target (e.g. `src/~foo.a1b2c3d.ts`). The `~` prefix and hash infix prevent glob matching and avoid collisions. The temp file is used **only** to calculate the diff with the existing file — it is not passed to `tsc`. The trailing `~` is omitted because `tsc` rejects unsupported extensions (e.g. `.ts~`). The extension must remain exactly `.ts` or `.tsx`.
- **No temp tsconfig**: Instead of creating a temporary tsconfig with `extends`, the project's `tsconfig.json` is read and its `compilerOptions` are converted to `tsc` CLI flags. This avoids `extends` which would inherit the project's `include` pattern and cause `tsc` to compile transitive imports.
- **tsc on the real file**: `tsc` is run on the real file (already modified by the original tool). Since the change is non-blocking, the file is always modified regardless of compilation results.
- **Compiler options as flags**: Options like `target`, `module`, `moduleResolution`, `strict`, `jsx`, `lib`, etc. are passed as CLI flags. Options that cannot be passed as flags (`paths`, `plugins`) are skipped.
- **No error filtering needed**: Because `tsc` only receives the single file as argument, every line of `tsc` output is a relevant compilation error — no filtering is required.
- **Multiple edits**: For `edit` events, all `oldText`/`newText` pairs are applied sequentially using `String.replace()` (each `oldText` is replaced only once).
- **`oldText` not found**: If `oldText` is missing from the file, the edit is silently skipped (via `continue`) but the lint check still proceeds on the existing content.
- **Single-edit format**: In addition to the array format `{ edits: [...] }`, the extension also supports a single-edit format `{ oldText, newText }` as direct properties of `event.input`.
- **UI notifications**: A warning notification is shown when compilation errors are detected (`⚠️ ${filePath}: ${errorCount} compilation error(s) — ${action} applied, file modified`).
- **Cleanup of temp file**: Only one temp file is cleaned up in a `finally` block.
- **Hash generation**: Temp file IDs are generated using `crypto.createHash("sha256")` with the basename + ISO date, styled like a short git commit hash (7 chars).

## Limitations
- Only covers TypeScript (`.ts`, `.tsx`).
- Requires `npx` and a local `typescript` installation in the project.
- Runs `tsc` only on the **affected file**, not the entire project — this is faster but may miss errors that arise from cross-file dependencies.
- Path aliases (`paths` in tsconfig) are not supported (they cannot be passed as `tsc` CLI flags).
- For `edit`: if `oldText` is not found in the file, the edit is silently skipped (via `continue`) but the lint check still proceeds on the existing content.
- For `edit`: each `oldText` is replaced only once (using `String.replace`), not all occurrences.
- If `tsc` throws unexpectedly, the change is allowed to proceed as a fail-safe.
- The extension creates one temp file: `~filename.hash.ext` in the same directory — if the process is killed mid-way, it may be left behind.
