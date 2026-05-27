# pi-ts-lint

> ⚠️ **Experimental — untested hypothesis**
>
> This extension is based on an unproven idea: that blocking writes on TypeScript compilation errors improves code quality and saves tokens. **No data supports this claim yet.** It is in early development. APIs, configuration, and behavior may change without notice.

## What it does

Intercepts `write` and `edit` tool calls on `.ts`/`.tsx` files and runs `tsc --noEmit` before allowing the change to proceed. If compilation fails, the change is blocked with structured error messages.

This is an experiment. We don't yet know whether it actually helps.

## How it works

This is a bit hacky — it doesn't lint the whole project, just the single file being written or edited:

1. Intercepts `write` and `edit` tool calls for TypeScript files.
2. Writes candidate content to a temp file (prefixed with `~`).
3. Creates a temporary tsconfig that extends the project's `tsconfig.json` but **only includes that single temp file**.
4. Runs `tsc --noEmit` against the temp file.
5. Blocks the change if compilation fails, returning structured error messages.
6. If compilation succeeds, cleans up and lets the change proceed.

Because only one file is checked, cross-file dependency errors are not caught. This is a trade-off for speed.

## Limitations

- Only covers `.ts` and `.tsx` files.
- Requires `npx` and a local `typescript` installation in the project.
- If `tsc` times out (>30s) or throws unexpectedly, the change is allowed to proceed as a fail-safe.
- Files exceeding 10 MB are skipped.

## Configuration

Configuration is loaded from two sources, merged with project-level taking priority:

| Scope | Path |
|-------|------|
| Global | `~/.pi/agent/extensions/pi-ts-lint/config.json` |
| Project | `.pi/pi-ts-lint.json` |

### Config file format

```json
{
  "changeComplexity": {
    "minAbsoluteLines": 5,
    "minPercentage": 5
  },
  "maxFileSizeMB": 10,
  "tscTimeoutMs": 30000
}
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `changeComplexity.minAbsoluteLines` | `5` | Skip linting if modified lines < this value (and percentage is also below threshold) |
| `changeComplexity.minPercentage` | `5` | Skip linting if modified lines / total lines < this % (and absolute count is also below threshold) |
| `maxFileSizeMB` | `10` | Skip linting for files exceeding this size in MB |
| `tscTimeoutMs` | `30000` | Timeout for `tsc` in milliseconds |

### Examples

**Skip linting on smaller edits (project-level):**

```json
// .pi/pi-ts-lint.json
{
  "changeComplexity": {
    "minAbsoluteLines": 3,
    "minPercentage": 2
  }
}
```

**Disable file size limit (project-level):**

```json
// .pi/pi-ts-lint.json
{
  "maxFileSizeMB": 0
}
```

**Increase tsc timeout for large projects (global):**

```json
// ~/.pi/agent/extensions/pi-ts-lint/config.json
{
  "tscTimeoutMs": 60000
}
```

### Merging behavior

Global config is loaded first, then project config is deep-merged on top. You only need to specify the keys you want to override:

```json
// ~/.pi/agent/extensions/pi-ts-lint/config.json (global defaults)
{
  "changeComplexity": {
    "minAbsoluteLines": 5,
    "minPercentage": 5
  },
  "maxFileSizeMB": 10,
  "tscTimeoutMs": 30000
}
```

```json
// .pi/pi-ts-lint.json (project overrides only)
{
  "changeComplexity": {
    "minAbsoluteLines": 3
  }
}
// Result: minAbsoluteLines=3, minPercentage=5 (unchanged from global), maxFileSizeMB=10 (unchanged)
```

## Installation

> ⚠️ This is an experimental extension based on an untested hypothesis. Use at your own discretion.

### Global (all projects)

Copy the extension to your global extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions/pi-ts-lint
# The extension is loaded automatically as a pi package
```

### Project-local

Add to your `.pi/settings.json`:

```json
{
  "packages": ["npm:pi-ts-lint"]
}
```

Or place a `.pi/pi-ts-lint.json` in your project root to customize thresholds.

## Design

The full design document, including the hypothesis and implementation details, is available in [docs/DESIGN.md](docs/DESIGN.md).

## License

MIT
