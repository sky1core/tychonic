import { describe, expect, it } from "vitest";
import { applyWorkflowCommandTimeout } from "../src/workflows/commandTimeout.js";

describe("workflow command timeout", () => {
  it("applies only the named states when commandTimeoutMs is provided", () => {
    const profile = {
      version: "tychonic.config.v1",
      states: {
        lint: { type: "lint", command: "npm run lint", timeout: "5m" },
        semantic_review: { type: "review", agent: "codex", timeout: "20m" },
        verify: { type: "verify", command: "npm test", timeout: "30m" }
      }
    } as const;

    const result = applyWorkflowCommandTimeout(profile, 12_345, ["lint", "semantic_review"]);

    expect(result.states.lint?.timeout).toBe(12_345);
    expect(result.states.semantic_review?.timeout).toBe(12_345);
    expect(result.states.verify?.timeout).toBe("30m");
  });

  it("returns the original profile when no override is provided", () => {
    const profile = {
      version: "tychonic.config.v1",
      states: {
        verify: { type: "verify", command: "npm test", timeout: "30m" }
      }
    } as const;

    expect(applyWorkflowCommandTimeout(profile, undefined, ["verify"])).toBe(profile);
  });
});
