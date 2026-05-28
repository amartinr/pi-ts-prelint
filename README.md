# pi-ts-prelint

> ⚠️ **Experimental — untested hypothesis**
>
> This extension is based on an unproven idea: that blocking writes on TypeScript compilation errors improves code quality and saves tokens. **No data supports this claim yet.** It is in early development. APIs, configuration, and behavior may change without notice.

## What it does

Intercepts `write` and `edit` tool calls on `.ts`/`.tsx` files and runs `tsc --noEmit` to check for compilation errors. If compilation fails, the change **is still applied** (so the model sees the modified file), but the structured error messages are injected into the tool result so the model can fix them in the next turn.

This is an experiment. We don't yet know whether it actually helps.

## How it works

This is a bit hacky — it doesn't lint the whole project, just the single file being written or edited:

1. Intercepts `write` and `edit` tool calls for TypeScript files.
2. Writes candidate content to a temp file (prefixed with `~`).
3. Creates a temporary tsconfig that extends the project's `tsconfig.json` but **only includes that single temp file**.
4. Runs `tsc --noEmit` against the temp file.
5. If compilation fails, stores the errors and lets the change proceed (the file is modified).
6. After the tool executes, injects the compilation errors into the tool result so the model sees them.
7. Cleans up temp files.

This approach ensures the model always sees the modified file state, avoiding the confusion that arises when edits are blocked and the model tries to re-apply changes on stale file content.

Because only one file is checked, cross-file dependency errors are not caught. This is a trade-off for speed.

## Limitations

- Only covers `.ts` and `.tsx` files.
- Requires `npx` and a local `typescript` installation in the project.
- If `tsc` times out (>30s) or throws unexpectedly, the change is allowed to proceed as a fail-safe.
- Files exceeding 10 MB are skipped (linting is bypassed).
- Compilation errors are not blocking — the model must notice and fix them on its own.

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
  },
  "maxFileSizeMB": 10,
  "tscTimeoutMs": 30000
}
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `changeComplexity.minAbsoluteLines` | `15` | Lint only when modified lines >= this AND percentage >= minPercentage |
| `changeComplexity.minPercentage` | `10` | Lint only when modified lines >= minAbsoluteLines AND percentage >= this % |
| `maxFileSizeMB` | `10` | Skip linting for files exceeding this size in MB |
| `tscTimeoutMs` | `30000` | Timeout for `tsc` in milliseconds |

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

**Disable file size limit (project-level):**

```json
// .pi/pi-ts-prelint.json
{
  "maxFileSizeMB": 0
}
```

**Increase tsc timeout for large projects (global):**

```json
// ~/.pi/agent/extensions/pi-ts-prelint/config.json
{
  "tscTimeoutMs": 60000
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
  },
  "maxFileSizeMB": 10,
  "tscTimeoutMs": 30000
}
```

```json
// .pi/pi-ts-prelint.json (project overrides only)
{
  "changeComplexity": {
    "minAbsoluteLines": 3
  }
}
// Result: minAbsoluteLines=3, minPercentage=10 (unchanged from global), maxFileSizeMB=10 (unchanged)
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
