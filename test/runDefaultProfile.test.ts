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

const USER_PROFILE: TychonicConfig = {
  version: "tychonic.config.v1",
  states: {
    verify: { type: "verify", command: "echo user-supplied" }
  },
  policies: {
    loop: { auto_continue: false, max_review_iterations: 1 }
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

  it("validates the user profile when one is provided and never loads the bundle", async () => {
    let calls = 0;
    const resolved = await applyDefaultProfileToRunInput({
      rawInput: {
        hasInput: true,
        input: { cwd: "/tmp/x", profile: USER_PROFILE }
      },
      loadDefaultProfile: async () => {
        calls += 1;
        return BUNDLE_DEFAULT_PROFILE;
      }
    });

    expect(calls).toBe(0);
    expect(resolved.hasInput).toBe(true);
    expect(resolved.input).toEqual({ cwd: "/tmp/x", profile: USER_PROFILE });
  });

  it("rejects an invalid user-supplied input.profile before workflow start", async () => {
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
    ).rejects.toThrow(/input\.profile is not a valid tychonic\.config\.v1 profile/);
  });

  it("synthesizes { profile: defaultProfile } when no --input/--input-file was passed", async () => {
    const resolved = await applyDefaultProfileToRunInput({
      rawInput: { hasInput: false },
      loadDefaultProfile: async () => BUNDLE_DEFAULT_PROFILE
    });

    expect(resolved.hasInput).toBe(true);
    expect(resolved.input).toEqual({ profile: BUNDLE_DEFAULT_PROFILE });
  });

  it("leaves non-object user inputs (array, null, primitive) untouched", async () => {
    let calls = 0;
    const arrayInput = await applyDefaultProfileToRunInput({
      rawInput: { hasInput: true, input: ["item"] },
      loadDefaultProfile: async () => {
        calls += 1;
        return BUNDLE_DEFAULT_PROFILE;
      }
    });
    expect(arrayInput).toEqual({ hasInput: true, input: ["item"] });

    const nullInput = await applyDefaultProfileToRunInput({
      rawInput: { hasInput: true, input: null },
      loadDefaultProfile: async () => {
        calls += 1;
        return BUNDLE_DEFAULT_PROFILE;
      }
    });
    expect(nullInput).toEqual({ hasInput: true, input: null });

    expect(calls).toBe(0);
  });
});
