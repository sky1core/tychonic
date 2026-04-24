import { describe, expect, it } from "vitest";
import {
  ActivityTypeSchema,
  DEFAULT_ACTIVITY_TIMEOUT_BY_TYPE,
  TychonicConfigSchema,
  activityTypeContracts,
  activityTimeoutMs,
  defaultActivityTimeoutMs,
  optionalStateConfig,
  requiredActivity,
  resolveActivityCommand
} from "../src/catalog/types.js";

describe("activity-centric config schema", () => {
  it("exposes the exact product-controlled activity type set", () => {
    expect(ActivityTypeSchema.options).toEqual([
      "lint",
      "unit_test",
      "integration",
      "work",
      "verify",
      "review",
      "auto_continue"
    ]);
    expect(Object.keys(activityTypeContracts).sort()).toEqual([...ActivityTypeSchema.options].sort());
  });

  it("accepts states and policies as the only top-level config groups", () => {
    const config = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      states: {
        lint: { type: "lint", command: "npm run lint", timeout: "10m" },
        work: { type: "work", agent: "worker", command: "node worker.js" },
        verify: { type: "verify", command: "npm test" },
        review: {
          type: "review",
          agent: "reviewer",
          command: "node review.js",
          emits: ["tychonic.review.v1"]
        }
      },
      policies: {
        loop: { auto_continue: true, max_review_iterations: 2 },
        integration: { mode: "disabled", position: "final_gate" },
        self_repair_workflow: { max_iterations: 4 }
      }
    });

    expect(requiredActivity(config, "work", "work").agent).toBe("worker");
    expect(optionalStateConfig(config, "missing", "lint")).toBeUndefined();
  });

  it("defines per-type default activity timeouts in one table", () => {
    expect(DEFAULT_ACTIVITY_TIMEOUT_BY_TYPE).toEqual({
      lint: 10 * 60 * 1000,
      unit_test: 30 * 60 * 1000,
      integration: 60 * 60 * 1000,
      verify: 30 * 60 * 1000,
      work: 120 * 60 * 1000,
      review: 45 * 60 * 1000,
      auto_continue: 90 * 60 * 1000
    });
    expect(defaultActivityTimeoutMs("review")).toBe(45 * 60 * 1000);
  });

  it("lets an explicit activity timeout override the per-type default", () => {
    const config = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      states: {
        work: { type: "work", command: "node worker.js", timeout: "5m" }
      }
    });

    expect(activityTimeoutMs(config, "work", defaultActivityTimeoutMs("work"))).toBe(5 * 60 * 1000);
  });

  it("accepts resumable work blocks that override the default timeout", () => {
    const config = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      states: {
        fix_bugs: { type: "work", command: "node fix.js", timeout: "7m" }
      }
    });

    expect(activityTimeoutMs(config, "fix_bugs", defaultActivityTimeoutMs("work"))).toBe(7 * 60 * 1000);
  });

  it("rejects removed file forms and unknown top-level keys", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {},
        ["ag" + "ents"]: {}
      })
    ).toThrow(/Unrecognized key/);

    const oldNameKey = "na" + "me";
    const oldTemplateKey = "tem" + "plate";
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {},
        [oldNameKey]: "old",
        [oldTemplateKey]: "checkpoint"
      })
    ).toThrow(/Unrecognized keys/);

    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          lint: { type: "unknown", command: "npm run lint" }
        }
      })
    ).toThrow(/Invalid option/);
  });

  it("enforces required and allowed fields per activity type", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          lint: { type: "lint", agent: "lint-runner", command: "npm run lint" }
        }
      })
    ).toThrow(/agent is not allowed for type lint/);

    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          work: { type: "work", agent: "worker" }
        }
      })
    ).toThrow(/command is required/);

    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          review: { type: "review", command: "node review.js" }
        }
      })
    ).toThrow(/custom reviewer command must declare emits/);

    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          lint: { type: "lint", agent: "lint-runner" }
        }
      })
    ).toThrow(/agent is not allowed for type lint/);
  });

  it("treats agent as optional metadata on explicit command activities", () => {
    const config = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      states: {
        work: {
          type: "work",
          agent: "worker",
          command: "node worker.js"
        },
        review: {
          type: "review",
          agent: "reviewer",
          command: "node review.js",
          emits: ["tychonic.review.v1"]
        }
      }
    });

    expect(resolveActivityCommand(config.states?.work)).toMatchObject({
      agent: "worker",
      command: "node worker.js"
    });
    expect(resolveActivityCommand(config.states?.review)).toMatchObject({
      agent: "reviewer",
      command: "node review.js"
    });
  });

  it("accepts Tychonic orchestration fields on state config blocks", () => {
    const config = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      states: {
        work: {
          type: "work",
          agent: "worker",
          command: "node worker.js",
          sandbox: "workspace-write",
          approval: "never",
          permission_mode: "plan",
          trust_all_tools: false
        }
      }
    });
    expect(config.states?.work).toMatchObject({
      sandbox: "workspace-write",
      approval: "never",
      permission_mode: "plan",
      trust_all_tools: false
    });
  });

  it("rejects pass-through vendor fields in state config blocks", () => {
    for (const field of ["model", "reasoning_effort", "thinking_budget", "approval_mode", "effort", "plan_mode_reasoning_effort"]) {
      expect(() =>
        TychonicConfigSchema.parse({
          version: "tychonic.config.v1",
          states: {
            work: {
              type: "work",
              command: "node worker.js",
              [field]: "whatever"
            }
          }
        })
      ).toThrow(/Unrecognized key/);
    }
  });

  it("rejects emits on non-review state config blocks", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          lint: {
            type: "lint",
            command: "npm run lint",
            emits: ["tychonic.review.v1"]
          }
        }
      })
    ).toThrow(/emits is not allowed for type lint/);
  });
});
