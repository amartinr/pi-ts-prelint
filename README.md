# pi-ts-prelint

> ⚠️ **Experimental — untested hypothesis**
>
> This extension is based on an unproven idea: that catching TypeScript compilation errors early improves code quality and saves tokens. **No data supports this claim yet.** It is in early development. APIs, configuration, and behavior may change without notice.

## What it does

Intercepts `write` and `edit` tool calls on `.ts`/`.tsx` files and runs `tsc --noEmit` to check for compilation errors. If compilation fails, the change **is still applied** (so the model sees the modified file), but the structured error messages are injected into the tool result so the model can fix them in the next turn.

This is an experiment. We don't yet know whether it actually helps.

## How it works

The extension intercepts `write` and `edit` tool calls for TypeScript files:

1. Intercepts `write` and `edit` tool calls for TypeScript files.
2. Writes the candidate content to a temp file (prefixed with `~`) to calculate the diff with the existing file.
3. Computes the change complexity (modified lines / total lines) to decide whether linting is worth the cost.
4. If the change is large enough, runs `tsc --noEmit` on the **real file** (already modified by the original tool) using the project's compiler options from `tsconfig.json` (passed as CLI flags, no temp tsconfig).
5. If compilation fails, stores the errors and lets the change proceed (the file is modified).
6. After the tool executes, injects the compilation errors into the tool result so the model sees them.
7. Cleans up the temp file.

The model always sees the modified file state, avoiding the confusion that arises when edits are blocked and the model tries to re-apply changes on stale file content.

## Limitations

- Only covers `.ts` and `.tsx` files.
- Requires `npx` and a local `typescript` installation in the project.
- If `tsc` throws unexpectedly, the change is allowed to proceed as a fail-safe.
- Compilation errors are not blocking — the model must notice and fix them on its own.
- Path aliases (`paths` in tsconfig) are not supported (they cannot be passed as `tsc` CLI flags).

## Configuration

Configuration is loaded from two sources, merged with project-level taking priority:

| Scope | Path |
|-------|------|
| Global | `~/.pi/agent/extensions/pi-ts-prelint/config.json` |
| Project | `.pi/pi-ts-prelint.json` |

### Config file format

```json
{
  "changeComplexity": {
    "minAbsoluteLines": 15,
    "minPercentage": 10
  }
}
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `changeComplexity.minAbsoluteLines` | `15` | Lint only when modified lines >= this AND percentage >= minPercentage |
| `changeComplexity.minPercentage` | `10` | Lint only when modified lines >= minAbsoluteLines AND percentage >= this % |

### Examples

**Skip linting on smaller edits (project-level):**

```json
// .pi/pi-ts-prelint.json
{
  "changeComplexity": {
    "minAbsoluteLines": 3,
    "minPercentage": 2
  }
}
```

### Merging behavior

Global config is loaded first, then project config is deep-merged on top. You only need to specify the keys you want to override:

```json
// ~/.pi/agent/extensions/pi-ts-prelint/config.json (global defaults)
{
  "changeComplexity": {
    "minAbsoluteLines": 15,
    "minPercentage": 10
  }
}
```

```json
// .pi/pi-ts-prelint.json (project overrides only)
{
  "changeComplexity": {
    "minAbsoluteLines": 3
  }
}
// Result: minAbsoluteLines=3, minPercentage=10 (unchanged from global)
```

## Installation

> ⚠️ This is an experimental extension based on an untested hypothesis. Use at your own discretion.

### Global (all projects)

Copy the extension to your global extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions/pi-ts-prelint
# The extension is loaded automatically as a pi package
```

### Project-local

Add to your `.pi/settings.json`:

```json
{
  "packages": ["npm:pi-ts-prelint"]
}
```

Or place a `.pi/pi-ts-prelint.json` in your project root to customize thresholds.

## Design

The full design document, including the hypothesis and implementation details, is available in [docs/DESIGN.md](docs/DESIGN.md).

## License

MIT
