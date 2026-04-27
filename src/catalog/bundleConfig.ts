import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBundleConfigYaml } from "./loadProfile.js";
import type { TychonicConfig } from "./types.js";
import { inspectBundle } from "../temporal/workflowModules.js";

export type BundleConfigSource = "bundle" | { override: string };

export interface EffectiveBundleConfig {
  profile: TychonicConfig;
  source: BundleConfigSource;
}

/**
 * Load the bundle's `defaultProfile` export from its `workflow.mjs` and
 * validate it through `TychonicConfigSchema`. This is the only path
 * product code uses to read a bundle's configuration. No merge, no
 * fallback, no discovery.
 */
export async function loadBundleDefaultProfile(bundleDir: string): Promise<TychonicConfig> {
  const workflowPath = join(bundleDir, "workflow.mjs");
  const inspection = await inspectBundle({ name: bundleDirName(bundleDir), workflowPath });
  return inspection.defaultProfile;
}

/**
 * Resolve the effective `TychonicConfig` for one workflow invocation.
 *
 * - Without `overridePath`, the result is the bundle's own
 *   `defaultProfile` export.
 * - With `overridePath`, the override file replaces the bundle's profile
 *   as a single whole object for this one invocation. There is no merge.
 *
 * The returned `source` labels which file backed the profile so callers
 * can write evidence artifacts without having to track overrides out of
 * band.
 */
export async function resolveEffectiveBundleConfig(options: {
  bundleDir: string;
  overridePath?: string;
}): Promise<EffectiveBundleConfig> {
  if (options.overridePath) {
    const raw = await readFile(options.overridePath, "utf8");
    return {
      profile: parseBundleConfigYaml(raw),
      source: { override: options.overridePath }
    };
  }
  return {
    profile: await loadBundleDefaultProfile(options.bundleDir),
    source: "bundle"
  };
}

function bundleDirName(bundleDir: string): string {
  const trimmed = bundleDir.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}
