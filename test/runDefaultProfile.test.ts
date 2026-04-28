import { describe, expect, it } from "vitest";
import { applyDefaultProfileToRunInput } from "../src/cli/runWorkflowInput.js";
import type { TychonicConfig } from "../src/catalog/types.js";

const BUNDLE_DEFAULT_PROFILE: TychonicConfig = {
  version: "tychonic.config.v1",
  states: {
    verify: { type: "verify", command: "echo bundle-default" }
  },
  policies: {
    loop: { auto_continue: true, max_review_iterations: 7 }
  }
};

describe("tychonic run defaultProfile auto-load", () => {
  it("injects the bundle defaultProfile when user input has no profile field", async () => {
    let calls = 0;
    const resolved = await applyDefaultProfileToRunInput({
      rawInput: {
        hasInput: true,
        input: { cwd: "/tmp/x", goal: "fix bug" }
      },
      loadDefaultProfile: async () => {
        calls += 1;
        return BUNDLE_DEFAULT_PROFILE;
      }
    });

    expect(calls).toBe(1);
    expect(resolved.hasInput).toBe(true);
    expect(resolved.input).toEqual({
      cwd: "/tmp/x",
      goal: "fix bug",
      profile: BUNDLE_DEFAULT_PROFILE
    });
  });

  it("rejects user-supplied input.profile instead of treating it as a config source", async () => {
    let calls = 0;
    await expect(
      applyDefaultProfileToRunInput({
        rawInput: {
          hasInput: true,
          input: { cwd: "/tmp/x", profile: BUNDLE_DEFAULT_PROFILE }
        },
        loadDefaultProfile: async () => {
          calls += 1;
          return BUNDLE_DEFAULT_PROFILE;
        }
      })
    ).rejects.toThrow(/input\.profile is reserved for Tychonic config injection/);
    expect(calls).toBe(0);
  });

  it("rejects invalid-looking input.profile by the reserved-field contract before schema parsing", async () => {
    await expect(
      applyDefaultProfileToRunInput({
        rawInput: {
          hasInput: true,
          input: {
            cwd: "/tmp/x",
            profile: {
              version: "tychonic.config.v1",
              states: {
                work: { type: "work", agent: "claude", command: "node worker.js" }
              }
            }
          }
        },
        loadDefaultProfile: async () => BUNDLE_DEFAULT_PROFILE
      })
    ).rejects.toThrow(/input\.profile is reserved for Tychonic config injection/);
  });

  it("synthesizes { profile: defaultProfile } when no --input/--input-file was passed", async () => {
    const resolved = await applyDefaultProfileToRunInput({
      rawInput: { hasInput: false },
      loadDefaultProfile: async () => BUNDLE_DEFAULT_PROFILE
    });

    expect(resolved.hasInput).toBe(true);
    expect(resolved.input).toEqual({ profile: BUNDLE_DEFAULT_PROFILE });
  });

  it("rejects non-object user inputs because the effective profile needs an object carrier", async () => {
    let calls = 0;
    await expect(
      applyDefaultProfileToRunInput({
        rawInput: { hasInput: true, input: ["item"] },
        loadDefaultProfile: async () => {
          calls += 1;
          return BUNDLE_DEFAULT_PROFILE;
        }
      })
    ).rejects.toThrow(/workflow input must be a JSON object/);

    await expect(
      applyDefaultProfileToRunInput({
        rawInput: { hasInput: true, input: null },
        loadDefaultProfile: async () => {
          calls += 1;
          return BUNDLE_DEFAULT_PROFILE;
        }
      })
    ).rejects.toThrow(/workflow input must be a JSON object/);

    expect(calls).toBe(0);
  });
});
