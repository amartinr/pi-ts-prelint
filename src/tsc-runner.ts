/**
 * tsc runner: reads project tsconfig, creates a minimal temp tsconfig,
 * and runs `tsc --noEmit` on a single file.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Result of running tsc on the real file. */
export interface TscResult {
  /** Compilation errors (null if compilation succeeded) */
  errors: string | null;
}

// ─── tsconfig helpers ────────────────────────────────────────────────────────

/**
 * Read and parse the project's tsconfig.json, extracting compilerOptions.
 * Returns null if tsconfig.json doesn't exist or can't be parsed.
 */
function readProjectTsconfig(
  cwd: string,
): { compilerOptions: Record<string, unknown> } | null {
  const tsconfigPath = path.join(cwd, "tsconfig.json");
  try {
    const raw = fs.readFileSync(tsconfigPath, "utf-8");
    const config = JSON.parse(raw) as {
      compilerOptions?: Record<string, unknown>;
    };
    return { compilerOptions: config.compilerOptions ?? {} };
  } catch {
    return null;
  }
}

/**
 * Create a minimal tsconfig.json for linting a single file.
 * Copies compilerOptions from the project tsconfig but omits `include`,
 * `exclude`, `extends`, and `rootDir`. The temp file is placed next to
 * the target so relative paths resolve.
 */
function createTempTsconfig(
  filePath: string,
  compilerOptions: Record<string, unknown>,
  id: string,
): string | null {
  const dir = path.dirname(filePath);
  const tsconfigPath = path.join(dir, `~tsconfig.${id}.lint.json`);

  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(compilerOptions)) {
    if (
      key === "include" ||
      key === "exclude" ||
      key === "extends" ||
      key === "rootDir"
    )
      continue;
    filtered[key] = compilerOptions[key];
  }

  const config = {
    compilerOptions: filtered,
    files: [path.basename(filePath)],
  };

  try {
    fs.writeFileSync(tsconfigPath, JSON.stringify(config, null, 2), "utf-8");
    return tsconfigPath;
  } catch {
    return null;
  }
}

// ─── Main runner ─────────────────────────────────────────────────────────────

/**
 * Run `tsc --noEmit` on a single file.
 *
 * If the project has a tsconfig.json, creates a minimal temp tsconfig that
 * copies compilerOptions but only includes the target file, then runs
 * `tsc --project <temp>`. Otherwise runs `tsc` with minimal CLI flags.
 *
 * The temp tsconfig is cleaned up in a `finally` block.
 */
export function runTsc(
  filePath: string,
  cwd: string,
  tempId: string,
): TscResult {
  const projectConfig = readProjectTsconfig(cwd);
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(cwd, filePath);

  // Run from the file's directory so relative paths and temp tsconfig resolve
  const fileDir = path.dirname(absPath);

  if (!projectConfig) {
    // No tsconfig — compile with minimal flags
    try {
      execFileSync(
        "npx",
        [
          "tsc",
          "--noEmit",
          "--pretty",
          "false",
          "--skipLibCheck",
          "--ignoreConfig",
          absPath,
        ],
        {
          cwd: fileDir,
          timeout: 30_000,
          maxBuffer: 1024 * 1024 * 10,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      return { errors: null };
    } catch (err: unknown) {
      const nodeErr = err as {
        stdout?: Buffer | string;
        stderr?: Buffer | string;
      };
      const output =
        (nodeErr.stdout &&
        typeof nodeErr.stdout.toString === "function"
          ? nodeErr.stdout.toString()
          : "") +
        "\n" +
        (nodeErr.stderr &&
        typeof nodeErr.stderr.toString === "function"
          ? nodeErr.stderr.toString()
          : "");
      return { errors: output.trim() || null };
    }
  }

  // Create a minimal tsconfig that only includes the target file
  const tempTsconfig = createTempTsconfig(
    absPath,
    projectConfig.compilerOptions,
    tempId,
  );

  try {
    execFileSync("npx", ["tsc", "--project", tempTsconfig ?? ""], {
      cwd: fileDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024 * 10,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { errors: null };
  } catch (err: unknown) {
    const nodeErr = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    const output =
      (nodeErr.stdout &&
      typeof nodeErr.stdout.toString === "function"
        ? nodeErr.stdout.toString()
        : "") +
      "\n" +
      (nodeErr.stderr && typeof nodeErr.stderr.toString === "function"
        ? nodeErr.stderr.toString()
        : "");

    return { errors: output.trim() || null };
  } finally {
    try {
      if (tempTsconfig) {
        fs.rmSync(tempTsconfig, { force: true });
      }
    } catch {
      // Best-effort cleanup
    }
  }
}
