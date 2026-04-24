import { describe, expect, it } from "vitest";
import {
  INTERACTION_DEFAULT_MAX_REJECT_ITERATIONS,
  PolicyInteractionSchema,
  TychonicConfigSchema
} from "../src/catalog/types.js";

describe("PolicyInteractionSchema", () => {
  it("accepts { mode: 'auto' }", () => {
    expect(() => PolicyInteractionSchema.parse({ mode: "auto" })).not.toThrow();
  });

  it("accepts { mode: 'interactive' } with no cap", () => {
    expect(() => PolicyInteractionSchema.parse({ mode: "interactive" })).not.toThrow();
  });

  it("accepts { mode: 'interactive', max_reject_iterations: 3 }", () => {
    const parsed = PolicyInteractionSchema.parse({
      mode: "interactive",
      max_reject_iterations: 3
    });
    expect(parsed).toEqual({ mode: "interactive", max_reject_iterations: 3 });
  });

  it("rejects { mode: 'auto', max_reject_iterations: 3 } with the documented message", () => {
    const result = PolicyInteractionSchema.safeParse({
      mode: "auto",
      max_reject_iterations: 3
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message).join("\n");
      expect(messages).toContain(
        "policies.interaction.max_reject_iterations is only allowed when mode is 'interactive'"
      );
    }
  });

  it("rejects { mode: 'unknown' }", () => {
    expect(() => PolicyInteractionSchema.parse({ mode: "unknown" })).toThrow();
  });

  it("rejects an empty object (mode is required)", () => {
    expect(() => PolicyInteractionSchema.parse({})).toThrow();
  });

  it("rejects zero or negative max_reject_iterations under interactive mode", () => {
    expect(() =>
      PolicyInteractionSchema.parse({ mode: "interactive", max_reject_iterations: 0 })
    ).toThrow();
    expect(() =>
      PolicyInteractionSchema.parse({ mode: "interactive", max_reject_iterations: -1 })
    ).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      PolicyInteractionSchema.parse({ mode: "auto", unknown: true } as unknown)
    ).toThrow();
  });

  it("exposes INTERACTION_DEFAULT_MAX_REJECT_ITERATIONS as 5", () => {
    expect(INTERACTION_DEFAULT_MAX_REJECT_ITERATIONS).toBe(5);
  });
});

describe("TychonicConfigSchema with policies.interaction", () => {
  it("accepts a config without policies.interaction", () => {
    const parsed = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      policies: {
        loop: { auto_continue: true, max_review_iterations: 2 }
      }
    });
    expect(parsed.policies?.interaction).toBeUndefined();
  });

  it("accepts a config with policies.interaction in combination with other policies", () => {
    const parsed = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      policies: {
        loop: { auto_continue: true, max_review_iterations: 2 },
        integration: { mode: "disabled", position: "final_gate" },
        self_repair_workflow: { max_iterations: 4 },
        interaction: { mode: "interactive", max_reject_iterations: 2 }
      }
    });
    expect(parsed.policies?.interaction).toEqual({
      mode: "interactive",
      max_reject_iterations: 2
    });
  });

  it("rejects invalid policies.interaction inside TychonicConfigSchema", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        policies: { interaction: { mode: "auto", max_reject_iterations: 1 } }
      })
    ).toThrow();
  });
});
