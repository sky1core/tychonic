import { describe, expect, it } from "vitest";

// Bundle-side policy validators. The host `TychonicConfigSchema` treats
// `policies` as an opaque record; each example workflow validates the
// policy keys it actually consumes at workflow start. These tests cover
// those bundle-local validators directly.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bundle modules export plain JS, no TS types.
import { validateLoopPolicy } from "../examples/workflows/simpleWorkflow/reviewLoop.mjs";
import { validateIntegrationPolicy } from "../examples/workflows/checkpointWorkflow/integrationPolicy.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {
  validateInteractionPolicy as validateAbqInteractionPolicy,
  validateLoopPolicy as validateAbqLoopPolicy
} from "../examples/workflows/architectBuilderQaWorkflow/workflowPolicies.mjs";

describe("simpleWorkflow validateLoopPolicy", () => {
  it("accepts an absent policies block", () => {
    expect(() => validateLoopPolicy(undefined)).not.toThrow();
    expect(() => validateLoopPolicy({})).not.toThrow();
  });

  it("accepts auto_continue: true with a valid max_review_iterations cap", () => {
    expect(() =>
      validateLoopPolicy({
        loop: {
          auto_continue: true,
          max_review_iterations: 5
        }
      })
    ).not.toThrow();
  });

  it("rejects unknown keys under policies.loop", () => {
    expect(() =>
      validateLoopPolicy({ loop: { auto_continue: true, bogus: 1 } })
    ).toThrow(/policies\.loop\.bogus is not a recognised key/);
  });

  it("rejects max_resume_iterations as a removed policies.loop key", () => {
    // The same-session resume cap is now the per-state numeric
    // `states.work.resume` (host schema-validated). The bundle no longer
    // accepts a `max_resume_iterations` knob under policies.
    expect(() =>
      validateLoopPolicy({ loop: { auto_continue: true, max_resume_iterations: 3 } })
    ).toThrow(/policies\.loop\.max_resume_iterations is not a recognised key/);
  });

  it("rejects max_review_iterations without auto_continue", () => {
    expect(() =>
      validateLoopPolicy({ loop: { max_review_iterations: 5 } })
    ).toThrow(/max_review_iterations requires policies\.loop\.auto_continue/);
  });

  it("rejects non-positive cap values", () => {
    expect(() =>
      validateLoopPolicy({ loop: { auto_continue: true, max_review_iterations: 0 } })
    ).toThrow(/must be a positive integer/);
    expect(() =>
      validateLoopPolicy({ loop: { auto_continue: true, max_review_iterations: -1 } })
    ).toThrow(/must be a positive integer/);
  });

  it("rejects a non-object loop block", () => {
    expect(() => validateLoopPolicy({ loop: "nope" })).toThrow(/must be an object/);
    expect(() => validateLoopPolicy({ loop: [] })).toThrow(/must be an object/);
  });

  it("rejects non-boolean auto_continue", () => {
    expect(() =>
      validateLoopPolicy({ loop: { auto_continue: "yes" } })
    ).toThrow(/auto_continue must be a boolean/);
  });
});

describe("checkpointWorkflow validateIntegrationPolicy", () => {
  it("accepts an absent block", () => {
    expect(() => validateIntegrationPolicy(undefined)).not.toThrow();
    expect(() => validateIntegrationPolicy({})).not.toThrow();
  });

  it("accepts each documented position", () => {
    for (const position of ["before_ai_review", "after_ai_review", "final_gate"]) {
      expect(() =>
        validateIntegrationPolicy({ integration: { position } })
      ).not.toThrow();
    }
  });

  it("rejects unknown position values", () => {
    expect(() =>
      validateIntegrationPolicy({
        integration: { position: "first_gate" }
      })
    ).toThrow(/policies\.integration\.position/);
  });

  it("rejects unknown keys", () => {
    expect(() =>
      validateIntegrationPolicy({
        integration: { position: "final_gate", bogus: 1 }
      })
    ).toThrow(/is not a recognised key/);
  });

  it("requires position when the block is present", () => {
    expect(() => validateIntegrationPolicy({ integration: {} })).toThrow();
  });
});

describe("architectBuilderQaWorkflow validateInteractionPolicy", () => {
  it("accepts an absent block", () => {
    expect(() => validateAbqInteractionPolicy(undefined)).not.toThrow();
    expect(() => validateAbqInteractionPolicy({})).not.toThrow();
  });

  it("accepts mode: auto without a cap", () => {
    expect(() =>
      validateAbqInteractionPolicy({ interaction: { mode: "auto" } })
    ).not.toThrow();
  });

  it("accepts mode: interactive with or without a cap", () => {
    expect(() =>
      validateAbqInteractionPolicy({ interaction: { mode: "interactive" } })
    ).not.toThrow();
    expect(() =>
      validateAbqInteractionPolicy({
        interaction: { mode: "interactive", max_reject_iterations: 3 }
      })
    ).not.toThrow();
  });

  it("rejects unknown mode", () => {
    expect(() =>
      validateAbqInteractionPolicy({ interaction: { mode: "bogus" } })
    ).toThrow(/policies\.interaction\.mode/);
  });

  it("rejects max_reject_iterations under mode: auto", () => {
    expect(() =>
      validateAbqInteractionPolicy({
        interaction: { mode: "auto", max_reject_iterations: 3 }
      })
    ).toThrow(/only allowed when mode is 'interactive'/);
  });

  it("rejects non-positive max_reject_iterations under mode: interactive", () => {
    expect(() =>
      validateAbqInteractionPolicy({
        interaction: { mode: "interactive", max_reject_iterations: 0 }
      })
    ).toThrow(/positive integer/);
    expect(() =>
      validateAbqInteractionPolicy({
        interaction: { mode: "interactive", max_reject_iterations: -1 }
      })
    ).toThrow(/positive integer/);
  });

  it("rejects unknown keys", () => {
    expect(() =>
      validateAbqInteractionPolicy({
        interaction: { mode: "interactive", bogus: 1 }
      })
    ).toThrow(/is not a recognised key/);
  });
});

describe("architectBuilderQaWorkflow validateLoopPolicy", () => {
  it("accepts an absent block and a single max_review_iterations cap", () => {
    expect(() => validateAbqLoopPolicy(undefined)).not.toThrow();
    expect(() => validateAbqLoopPolicy({})).not.toThrow();
    expect(() =>
      validateAbqLoopPolicy({ loop: { max_review_iterations: 3 } })
    ).not.toThrow();
  });

  it("rejects unknown keys", () => {
    expect(() =>
      validateAbqLoopPolicy({ loop: { max_review_iterations: 3, bogus: 1 } })
    ).toThrow(/is not a recognised key/);
  });

  it("rejects non-positive max_review_iterations", () => {
    expect(() =>
      validateAbqLoopPolicy({ loop: { max_review_iterations: 0 } })
    ).toThrow(/positive integer/);
    expect(() =>
      validateAbqLoopPolicy({ loop: { max_review_iterations: -1 } })
    ).toThrow(/positive integer/);
  });
});
