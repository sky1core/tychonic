import { describe, expect, it } from "vitest";
import { resolveSimpleWorkflowCliOptions } from "../src/cli/simpleWorkflowCliOptions.js";
import type { TychonicConfig } from "../src/catalog/types.js";

describe("resolveSimpleWorkflowCliOptions", () => {
  it("resolves simple_workflow from explicitly named states", () => {
    const resolved = resolveSimpleWorkflowCliOptions({
      cwd: "/repo",
      goal: "make the change",
      profile: config({
        work: { type: "work", agent: "codex", command: "codex exec --json" },
        verify: { type: "verify", command: "npm test" },
        review: { type: "review", agent: "claude", command: "claude review", emits: ["tychonic.review.v1"] }
      })
    });

    expect(resolved).toMatchObject({
      cwd: "/repo",
      goal: "make the change",
      verifyCommand: "npm test",
      agent: "codex",
      command: "codex exec --json",
      reviewAgent: "claude"
    });
    expect(resolved.reviewCommand).toBe("claude review");
    expect(resolved.autoContinue).toBeUndefined();
  });

  it("lets CLI worker and reviewer selection override configured states", () => {
    const resolved = resolveSimpleWorkflowCliOptions({
      cwd: "/repo",
      command: "node worker.js",
      reviewCommand: "node review.js",
      verifyCommand: "npm run verify",
      profile: config({
        work: { type: "work", agent: "codex" },
        verify: { type: "verify", command: "npm test" },
        review: { type: "review", agent: "codex" }
      })
    });

    expect(resolved.command).toBe("node worker.js");
    expect(resolved.reviewCommand).toBe("node review.js");
    expect(resolved.verifyCommand).toBe("npm run verify");
    expect(resolved.agent).toBeUndefined();
  });

  it("requires the named verify activity unless CLI supplies the command", () => {
    expect(() =>
      resolveSimpleWorkflowCliOptions({
        cwd: "/repo",
        profile: config({
          work: { type: "work", agent: "codex" }
        })
      })
    ).toThrow(/activity 'verify'/);
  });

  it("uses loop policy values from policies.loop", () => {
    const resolved = resolveSimpleWorkflowCliOptions({
      cwd: "/repo",
      profile: {
        ...config({
          work: { type: "work", agent: "codex" },
          verify: { type: "verify", command: "npm test" }
        }),
        policies: {
          loop: { auto_continue: true, max_review_iterations: 4 }
        }
      }
    });

    expect(resolved.autoContinue).toBe(true);
    expect(resolved.maxIterations).toBe(4);
  });

  it("does not enable autoContinue implicitly just because review is configured", () => {
    const resolved = resolveSimpleWorkflowCliOptions({
      cwd: "/repo",
      profile: config({
        work: { type: "work", agent: "codex" },
        verify: { type: "verify", command: "npm test" },
        review: { type: "review", agent: "codex" }
      })
    });

    expect(resolved.autoContinue).toBeUndefined();
    expect(resolved.maxIterations).toBeUndefined();
  });
});

function config(states: NonNullable<TychonicConfig["states"]>): TychonicConfig {
  return { version: "tychonic.config.v1", states };
}
