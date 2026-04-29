import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadBundleDefaultProfile,
  resolveEffectiveBundleConfig
} from "../src/catalog/bundleConfig.js";

const VALID_BUNDLE_WORKFLOW = `
export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    verify: { type: "verify", command: "echo ok" }
  }
};
export async function bundle() { return "ok"; }
`;

const OVERRIDE_CONFIG = `version: tychonic.config.v1
states:
  verify:
    type: verify
    command: npm run verify:worker
policies:
  integration:
    position: final_gate
`;

describe("bundleConfig loader", () => {
  it("loadBundleDefaultProfile reads the bundle's defaultProfile export", async () => {
    const bundleDir = await makeBundleDir(VALID_BUNDLE_WORKFLOW);
    const config = await loadBundleDefaultProfile(bundleDir);
    expect(config.states?.verify).toMatchObject({ type: "verify", command: "echo ok" });
  });

  it("resolveEffectiveBundleConfig returns the bundle's defaultProfile when no override is passed", async () => {
    const bundleDir = await makeBundleDir(VALID_BUNDLE_WORKFLOW);
    const resolved = await resolveEffectiveBundleConfig({ bundleDir });
    expect(resolved.source).toBe("bundle");
    expect(resolved.profile.states?.verify?.command).toBe("echo ok");
  });

  it("resolveEffectiveBundleConfig replaces the whole config with the override", async () => {
    const bundleDir = await makeBundleDir(VALID_BUNDLE_WORKFLOW);
    const overridePath = await writeTempFile("override.yaml", OVERRIDE_CONFIG);
    const resolved = await resolveEffectiveBundleConfig({ bundleDir, overridePath });
    expect(resolved.source).toEqual({ override: overridePath });
    expect(resolved.profile.states?.verify?.command).toBe("npm run verify:worker");
    expect(resolved.profile.policies?.integration).toMatchObject({ position: "final_gate" });
  });

  it("accepts a bundle defaultProfile that declares supported agent settings", async () => {
    const bundleDir = await makeBundleDir(`
export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    review: {
      type: "review",
      agent: "claude",
      model: "opus",
      reasoning_effort: "max"
    }
  }
};
export async function bundle() { return "ok"; }
`);
    const profile = await loadBundleDefaultProfile(bundleDir);
    expect(profile.states?.review).toMatchObject({
      model: "opus",
      reasoning_effort: "max"
    });
  });

  it("rejects a bundle defaultProfile that declares an unsupported vendor field", async () => {
    const bundleDir = await makeBundleDir(`
export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    review: {
      type: "review",
      agent: "claude",
      thinking_budget: "2000"
    }
  }
};
export async function bundle() { return "ok"; }
`);
    await expect(loadBundleDefaultProfile(bundleDir)).rejects.toThrow();
  });
});

async function makeBundleDir(workflowSource: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "tychonic-bundle-config-"));
  const bundleDir = join(parent, "bundle");
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, "workflow.mjs"), workflowSource, "utf8");
  return bundleDir;
}

async function writeTempFile(name: string, content: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "tychonic-bundle-override-"));
  const p = join(parent, name);
  await writeFile(p, content, "utf8");
  return p;
}
