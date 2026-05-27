# pi-ts-lint

Pre-write TypeScript linting for pi — blocks `write`/`edit` on `.ts`/`.tsx` files if `tsc` compilation fails.

## How it works

1. Intercepts `write` and `edit` tool calls for TypeScript files.
2. Writes candidate content to a temp file (prefixed with `~`).
3. Runs `tsc --noEmit` via a temporary tsconfig that extends the project's `tsconfig.json`.
4. Blocks the change if compilation fails, returning structured error messages.
5. If compilation succeeds, cleans up and lets the change proceed.

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

### Global (all projects)

Copy the config file and extension to your global extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions/pi-ts-lint
# Copy config.json from this repo or create your own
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

## License

MIT
