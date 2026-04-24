import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBundleConfigYaml } from "./loadProfile.js";
import type { TychonicConfig } from "./types.js";

export type BundleConfigSource = "bundle" | { override: string };

export interface EffectiveBundleConfig {
  profile: TychonicConfig;
  source: BundleConfigSource;
}

/**
 * Load the bundle's `config.yaml` from disk and parse it with
 * `TychonicConfigSchema`. This is the only path product code uses to read
 * a bundle's configuration. No merge, no fallback, no discovery.
 */
export async function loadBundleConfig(bundleDir: string): Promise<TychonicConfig> {
  const raw = await readFile(join(bundleDir, "config.yaml"), "utf8");
  return parseBundleConfigYaml(raw);
}

/**
 * Resolve the effective `TychonicConfig` for one workflow invocation.
 *
 * - Without `overridePath`, the result is the bundle's own `config.yaml`.
 * - With `overridePath`, the override file replaces the bundle's config
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
    profile: await loadBundleConfig(options.bundleDir),
    source: "bundle"
  };
}
