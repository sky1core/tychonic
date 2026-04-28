import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyConfigOrDefaultProfileToRunInput } from "../src/cli/runWorkflowInput.js";
import type { TychonicConfig } from "../src/catalog/types.js";

const BUNDLE_DEFAULT_PROFILE: TychonicConfig = {
  version: "tychonic.config.v1",
  states: {
    verify: { type: "verify", command: "echo bundle-default" }
  }
};

const CONFIG_PROFILE: TychonicConfig = {
  version: "tychonic.config.v1",
  states: {
    verify: { type: "verify", command: "echo from-config-file" }
  },
  policies: {
    loop: { auto_continue: true, max_review_iterations: 9 }
  }
};

async function writeConfigFile(format: "yaml" | "json"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tychonic-run-config-"));
  const path = join(dir, format === "yaml" ? "profile.yaml" : "profile.json");
  if (format === "yaml") {
    const yaml = [
      "version: tychonic.config.v1",
      "states:",
      "  verify:",
      "    type: verify",
      "    command: echo from-config-file",
      "policies:",
      "  loop:",
      "    auto_continue: true",
      "    max_review_iterations: 9",
      ""
    ].join("\n");
    await writeFile(path, yaml, "utf8");
  } else {
    await writeFile(path, JSON.stringify(CONFIG_PROFILE), "utf8");
  }
  return path;
}

describe("tychonic run --config resolution", () => {
  it("attaches a YAML --config file as the internal profile and skips the bundle default", async () => {
    const path = await writeConfigFile("yaml");
    let bundleLoads = 0;
    const resolved = await applyConfigOrDefaultProfileToRunInput({
      rawInput: { hasInput: true, input: { cwd: "/tmp/x", goal: "build" } },
      configPath: path,
      loadDefaultProfile: async () => {
        bundleLoads += 1;
        return BUNDLE_DEFAULT_PROFILE;
      }
    });

    expect(bundleLoads).toBe(0);
    expect(resolved.hasInput).toBe(true);
    expect(resolved.input).toEqual({
      cwd: "/tmp/x",
      goal: "build",
      profile: CONFIG_PROFILE
    });
  });

  it("attaches a JSON --config file as the internal profile and skips the bundle default", async () => {
    const path = await writeConfigFile("json");
    let bundleLoads = 0;
    const resolved = await applyConfigOrDefaultProfileToRunInput({
      rawInput: { hasInput: false },
      configPath: path,
      loadDefaultProfile: async () => {
        bundleLoads += 1;
        return BUNDLE_DEFAULT_PROFILE;
      }
    });

    expect(bundleLoads).toBe(0);
    expect(resolved.hasInput).toBe(true);
    expect(resolved.input).toEqual({ profile: CONFIG_PROFILE });
  });

  it("rejects --config + raw input.profile because profile is reserved for config injection", async () => {
    const path = await writeConfigFile("yaml");
    await expect(
      applyConfigOrDefaultProfileToRunInput({
        rawInput: {
          hasInput: true,
          input: { cwd: "/tmp/x", profile: BUNDLE_DEFAULT_PROFILE }
        },
        configPath: path,
        loadDefaultProfile: async () => BUNDLE_DEFAULT_PROFILE
      })
    ).rejects.toThrow(/input\.profile is reserved for Tychonic config injection/);
  });

  it("--config wins over the bundle defaultProfile when input has no profile field", async () => {
    const path = await writeConfigFile("yaml");
    let bundleLoads = 0;
    const resolved = await applyConfigOrDefaultProfileToRunInput({
      rawInput: { hasInput: true, input: { cwd: "/tmp/x" } },
      configPath: path,
      loadDefaultProfile: async () => {
        bundleLoads += 1;
        return BUNDLE_DEFAULT_PROFILE;
      }
    });

    expect(bundleLoads).toBe(0);
    expect((resolved.input as { profile: TychonicConfig }).profile).toEqual(CONFIG_PROFILE);
  });

  it("falls back to the bundle defaultProfile when --config is omitted and input has no profile", async () => {
    const resolved = await applyConfigOrDefaultProfileToRunInput({
      rawInput: { hasInput: true, input: { cwd: "/tmp/x" } },
      loadDefaultProfile: async () => BUNDLE_DEFAULT_PROFILE
    });

    expect(resolved.hasInput).toBe(true);
    expect(resolved.input).toEqual({
      cwd: "/tmp/x",
      profile: BUNDLE_DEFAULT_PROFILE
    });
  });

  it("rejects an unreadable --config path with a clear error", async () => {
    await expect(
      applyConfigOrDefaultProfileToRunInput({
        rawInput: { hasInput: false },
        configPath: "/does/not/exist/profile.yaml",
        loadDefaultProfile: async () => BUNDLE_DEFAULT_PROFILE
      })
    ).rejects.toThrow(/failed to read --config/);
  });

  it("rejects --config when the user input is non-object (array/null) instead of dropping it", async () => {
    const path = await writeConfigFile("json");
    await expect(
      applyConfigOrDefaultProfileToRunInput({
        rawInput: { hasInput: true, input: ["array-input"] },
        configPath: path,
        loadDefaultProfile: async () => BUNDLE_DEFAULT_PROFILE
      })
    ).rejects.toThrow(/workflow input must be a JSON object/);
  });
});
