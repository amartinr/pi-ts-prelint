# TODO

## Current Status
The extension has been refactored to use a simplified flow:
- Temp file only for diff calculation (not for linting)
- No temp tsconfig — compiler options passed as CLI flags
- tsc runs on the real file (non-blocking)

## Next Steps
1. Test with a small quantized model on a TypeScript project.
2. Measure token usage and iteration count compared to the standard workflow.
3. Consider extending support to other statically-typed languages (e.g., `.js` with JSDoc, `.jsx`).
4. Consider supporting `paths` via `tsconfig-paths` or similar.
