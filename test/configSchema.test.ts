import { describe, expect, it } from "vitest";
import {
  ActivityTypeSchema,
  DEFAULT_ACTIVITY_TIMEOUT_BY_TYPE,
  TychonicConfigSchema,
  activityTypeContracts,
  activityTimeoutMs,
  defaultActivityTimeoutMs,
  optionalStateConfig,
  requiredActivity
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
        work: { type: "work", agent: "claude" },
        verify: { type: "verify", command: "npm run verify:worker" },
        review: {
          type: "review",
          command: "node review.js"
        }
      },
      policies: {
        loop: { auto_continue: true, max_review_iterations: 2 },
        integration: { mode: "disabled", position: "final_gate" },
        self_repair_workflow: { max_iterations: 4 }
      }
    });

    expect(requiredActivity(config, "work", "work").agent).toBe("claude");
    expect(optionalStateConfig(config, "missing", "lint")).toBeUndefined();
  });

  it("treats policies as an opaque record so workflow-defined keys round-trip unchanged", () => {
    const config = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      policies: {
        bogus_key: { foo: 1 },
        loop: {
          auto_continue: false,
          max_resume_iterations: 9,
          max_review_iterations: 3
        }
      }
    });
    expect(config.policies).toEqual({
      bogus_key: { foo: 1 },
      loop: {
        auto_continue: false,
        max_resume_iterations: 9,
        max_review_iterations: 3
      }
    });
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

    // work activity requires at least one of command/agent. A block with
    // neither must be rejected; a block with only `agent` (built-in or
    // operator-supplied) is accepted at the schema layer because the
    // adapter dispatch path resolves the actual command at run time.
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          work: { type: "work" }
        }
      })
    ).toThrow(/requires one of: command, agent/);

    expect(
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          review: { type: "review", command: "node review.js" }
        }
      }).states?.review?.command
    ).toBe("node review.js");

    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          lint: { type: "lint", agent: "lint-runner" }
        }
      })
    ).toThrow(/agent is not allowed for type lint/);
  });

  it("rejects agent and command together", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          work: {
            type: "work",
            agent: "claude",
            command: "node worker.js"
          }
        }
      })
    ).toThrow(/must set only one execution selector: agent or command/);
  });

  it("accepts Tychonic orchestration fields on state config blocks", () => {
    const config = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      states: {
        work: {
          type: "work",
          agent: "claude",
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

  it("rejects emits anywhere in state config blocks", () => {
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
    ).toThrow(/Unrecognized key/);
  });

});

// Step 6: schema tighten. The state block's `resume_command` slot is gone;
// `agent` must be a built-in adapter; `resume` is a plain numeric workflow
// budget with no TYPE/NAME/command-path inference.
describe("Step 6 schema tighten", () => {
  it("rejects resume_command anywhere in a state block", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          work: {
            type: "work",
            agent: "claude",
            resume_command: "claude --continue"
          }
        }
      })
    ).toThrow(/Unrecognized key/);
  });

  it("rejects an unknown agent name on a work state", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          work: {
            type: "work",
            agent: "fakebot"
          }
        }
      })
    ).toThrow(/'fakebot' is not a built-in adapter; must be one of: claude, codex, gemini, kiro/);
  });

  it("rejects an unknown agent name on a review state", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          review: {
            type: "review",
            agent: "claud"
          }
        }
      })
    ).toThrow(/'claud' is not a built-in adapter/);
  });

  it("rejects an unknown agent name on an auto_continue state", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          loop: {
            type: "auto_continue",
            agent: "geminii"
          }
        }
      })
    ).toThrow(/'geminii' is not a built-in adapter/);
  });

  it("accepts each of the four built-in adapter names", () => {
    for (const name of ["claude", "codex", "gemini", "kiro"]) {
      const config = TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          work: { type: "work", agent: name }
        }
      });
      expect(config.states?.work?.agent).toBe(name);
    }
  });

  it("accepts resume on a command block", () => {
    const config = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      states: {
        work: {
          type: "work",
          command: "node worker.js",
          resume: 3
        }
      }
    });
    expect(config.states?.work?.resume).toBe(3);
  });

  it("rejects resume blocks that set both command and agent", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          work: {
            type: "work",
            agent: "claude",
            command: "node worker.js",
            resume: 2
          }
        }
      })
    ).toThrow(/must set only one execution selector: agent or command/);
  });

  it("accepts resume on deterministic command activity blocks", () => {
    const config = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      states: {
        verify: {
          type: "verify",
          command: "npm run verify:worker",
          resume: 2
        }
      }
    });
    expect(config.states?.verify?.resume).toBe(2);
  });

  it("accepts resume: 0 (disables in-session resume) on adapter blocks", () => {
    const config = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      states: {
        work: { type: "work", agent: "claude", resume: 0 }
      }
    });
    expect(config.states?.work?.resume).toBe(0);
  });

  it("rejects negative resume", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          work: { type: "work", agent: "claude", resume: -1 }
        }
      })
    ).toThrow();
  });

  it("rejects non-integer resume", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          work: { type: "work", agent: "claude", resume: 1.5 }
        }
      })
    ).toThrow();
  });

  it("rejects a work state with neither agent nor command", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          work: { type: "work" }
        }
      })
    ).toThrow(/requires one of: command, agent/);
  });

  it("rejects an auto_continue state with neither agent nor command", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          loop: { type: "auto_continue" }
        }
      })
    ).toThrow(/requires one of: command, agent/);
  });

  it("rejects a review state with neither agent nor command", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          review: { type: "review" }
        }
      })
    ).toThrow(/requires one of: command, agent/);
  });

});

// Reviewer role coverage. `gemini` and `kiro` lack the structured
// `tychonic.review.v1` output the host requires from a reviewer, so the
// host schema rejects them on `type: "review"` at install time. The
// runtime adapter throw is the second line of defense.
describe("review-state agent restrictions", () => {
  it("rejects agent: \"gemini\" on a review state", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          review: {
            type: "review",
            agent: "gemini"
          }
        }
      })
    ).toThrow(
      /agent gemini does not support the reviewer role; only claude or codex may serve as a review-state agent/
    );
  });

  it("rejects agent: \"kiro\" on a review state", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          review: {
            type: "review",
            agent: "kiro"
          }
        }
      })
    ).toThrow(
      /agent kiro does not support the reviewer role; only claude or codex may serve as a review-state agent/
    );
  });

  it("accepts agent: \"claude\" on a review state", () => {
    const config = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      states: {
        review: {
          type: "review",
          agent: "claude"
        }
      }
    });
    expect(config.states?.review?.agent).toBe("claude");
  });

  it("accepts agent: \"codex\" on a review state", () => {
    const config = TychonicConfigSchema.parse({
      version: "tychonic.config.v1",
      states: {
        review: {
          type: "review",
          agent: "codex"
        }
      }
    });
    expect(config.states?.review?.agent).toBe("codex");
  });

  it("still accepts gemini and kiro on work and auto_continue states", () => {
    for (const name of ["gemini", "kiro"]) {
      const config = TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          work: { type: "work", agent: name },
          loop: { type: "auto_continue", agent: name }
        }
      });
      expect(config.states?.work?.agent).toBe(name);
      expect(config.states?.loop?.agent).toBe(name);
    }
  });
});
