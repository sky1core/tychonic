import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadBundleConfig,
  resolveEffectiveBundleConfig
} from "../src/catalog/bundleConfig.js";

const VALID_BUNDLE_CONFIG = `version: tychonic.config.v1
states:
  verify:
    type: verify
    command: echo ok
`;

const OVERRIDE_CONFIG = `version: tychonic.config.v1
states:
  verify:
    type: verify
    command: npm test
policies:
  integration:
    mode: disabled
    position: final_gate
`;

describe("bundleConfig loader", () => {
  it("loadBundleConfig reads and parses the bundle's config.yaml", async () => {
    const bundleDir = await makeBundleDir(VALID_BUNDLE_CONFIG);
    const config = await loadBundleConfig(bundleDir);
    expect(config.states?.verify).toMatchObject({ type: "verify", command: "echo ok" });
  });

  it("resolveEffectiveBundleConfig returns the bundle file when no override is passed", async () => {
    const bundleDir = await makeBundleDir(VALID_BUNDLE_CONFIG);
    const resolved = await resolveEffectiveBundleConfig({ bundleDir });
    expect(resolved.source).toBe("bundle");
    expect(resolved.profile.states?.verify?.command).toBe("echo ok");
  });

  it("resolveEffectiveBundleConfig replaces the whole config with the override", async () => {
    const bundleDir = await makeBundleDir(VALID_BUNDLE_CONFIG);
    const overridePath = await writeTempFile("override.yaml", OVERRIDE_CONFIG);
    const resolved = await resolveEffectiveBundleConfig({ bundleDir, overridePath });
    expect(resolved.source).toEqual({ override: overridePath });
    expect(resolved.profile.states?.verify?.command).toBe("npm test");
    expect(resolved.profile.policies?.integration).toMatchObject({ mode: "disabled" });
  });

  it("rejects a bundle config that declares a pass-through vendor field", async () => {
    const bundleDir = await makeBundleDir(
      "version: tychonic.config.v1\nstates:\n  review:\n    type: review\n    agent: claude\n    command: claude --print\n    model: claude-opus-4\n    emits:\n      - tychonic.review.v1\n"
    );
    await expect(loadBundleConfig(bundleDir)).rejects.toThrow();
  });
});

async function makeBundleDir(configContent: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "tychonic-bundle-config-"));
  const bundleDir = join(parent, "bundle");
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, "config.yaml"), configContent, "utf8");
  return bundleDir;
}

async function writeTempFile(name: string, content: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "tychonic-bundle-override-"));
  const p = join(parent, name);
  await writeFile(p, content, "utf8");
  return p;
}
