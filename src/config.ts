/**
 * Configuration types, defaults, loading and merging.
 */

import fs from "node:fs";
import path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PiTsLintConfig {
  changeComplexity: {
    minAbsoluteLines: number;
    minPercentage: number;
  };
  diffThreshold: {
    minErrorsToShow: number;
    maxAbsoluteLines: number;
    maxPercentage: number;
  };
}

// ─── Defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: PiTsLintConfig = {
  changeComplexity: {
    minAbsoluteLines: 15,
    minPercentage: 10,
  },
  diffThreshold: {
    minErrorsToShow: 3,
    maxAbsoluteLines: 50,
    maxPercentage: 50,
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deepMerge<T>(base: T, override: Partial<T>): T {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(override)) {
    const val = (override as Record<string, unknown>)[key];
    if (
      val != null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      result[key] != null &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], val);
    } else {
      result[key] = val;
    }
  }
  return result as unknown as T;
}

function loadConfigFile<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ─── Resolver ────────────────────────────────────────────────────────────────

export function resolveConfig(cwd: string): PiTsLintConfig {
  const homeDir = process.env.HOME;
  const globalConfigPath = homeDir
    ? path.join(homeDir, ".pi", "agent", "extensions", "pi-ts-prelint", "config.json")
    : null;

  const projectConfigPath = path.join(cwd, ".pi", "pi-ts-prelint.json");

  const globalConfig = globalConfigPath
    ? loadConfigFile<PiTsLintConfig>(globalConfigPath)
    : null;
  const projectConfig = loadConfigFile<PiTsLintConfig>(projectConfigPath);

  return deepMerge(
    deepMerge(DEFAULT_CONFIG, globalConfig ?? {}),
    projectConfig ?? {},
  );
}
