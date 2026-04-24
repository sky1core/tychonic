import { describe, expect, it } from "vitest";
import type { ActivityResult, SelfRepairWorkflowInput } from "../src/temporal/types.js";
import {
  DEFAULT_SELF_REPAIR_WORKFLOW_MAX_ITERATIONS,
  runSelfRepairWorkflowLoop,
  type SelfRepairWorkflowActivities
} from "../src/workflows/selfRepairWorkflowLoop.js";
import type { ReviewFinding } from "../src/review/schema.js";

describe("self_repair_workflow workflow loop", () => {
  it("succeeds immediately when detect_bugs passes on the first iteration", async () => {
    const calls: string[] = [];
    const result = await runSelfRepairWorkflowLoop(
      baseInput(),
      fakeActivities(calls, {
        detect_bugs: [reviewPass("detect_bugs", "clean")]
      })
    );

    expect(result.status).toBe("succeeded");
    expect(result.run.states.map((state) => state.name)).toEqual([
      "create_isolated_worktree",
      "detect_bugs"
    ]);
    expect(calls).toEqual(["startRun", "createWorktree", "review:detect_bugs", "finalize"]);
  });

  it("runs the full detect -> tests -> review -> fix -> verify -> final_review cycle before re-scanning", async () => {
    const calls: string[] = [];
    const result = await runSelfRepairWorkflowLoop(
      baseInput(),
      fakeActivities(calls, {
        detect_bugs: [
          reviewFail("detect_bugs", [
            finding("Multiply returns the wrong value", "math.ts")
          ]),
          reviewPass("detect_bugs", "no more bugs")
        ],
        review_regression_tests: [reviewPass("review_regression_tests", "tests look good")],
        final_review: [reviewPass("final_review", "fix looks good")]
      })
    );

    expect(result.status).toBe("succeeded");
    expect(result.run.states.map((state) => state.name)).toEqual([
      "create_isolated_worktree",
      "detect_bugs",
      "write_regression_tests",
      "review_regression_tests",
      "fix_bugs",
      "verify",
      "final_review",
      "detect_bugs"
    ]);
    expect(calls).toEqual([
      "startRun",
      "createWorktree",
      "review:detect_bugs",
      "work:write_regression_tests",
      "review:review_regression_tests",
      "work:fix_bugs",
      "verify:verify",
      "review:final_review",
      "review:detect_bugs",
      "finalize"
    ]);
  });

  it("retries from fix_bugs when final_review still finds issues", async () => {
    const calls: string[] = [];
    const result = await runSelfRepairWorkflowLoop(
      baseInput({
        profile: {
          ...baseInput().profile,
          policies: {
            self_repair_workflow: { max_iterations: 2 }
          }
        }
      }),
      fakeActivities(calls, {
        detect_bugs: [
          reviewFail("detect_bugs", [finding("First bug", "math.ts")]),
          reviewFail("detect_bugs", [finding("Second bug", "math.ts")])
        ],
        review_regression_tests: [
          reviewPass("review_regression_tests", "tests good"),
          reviewPass("review_regression_tests", "tests good")
        ],
        final_review: [
          reviewFail("final_review", [finding("Fix still incorrect", "math.ts")]),
          reviewFail("final_review", [finding("Fix still incorrect", "math.ts")])
        ]
      })
    );

    expect(result.status).toBe("failed");
    expect(calls.filter((call) => call === "review:detect_bugs")).toHaveLength(1);
    expect(calls.filter((call) => call === "work:fix_bugs")).toHaveLength(2);
    expect(calls.filter((call) => call === "review:final_review")).toHaveLength(2);
  });

  it("routes unparseable detect_bugs output to waiting_user triage", async () => {
    const result = await runSelfRepairWorkflowLoop(
      baseInput(),
      fakeActivities({}, {
        detect_bugs: [reviewUnparseable("detect_bugs", "reviewer output did not match tychonic.review.v1")]
      })
    );

    expect(result.status).toBe("waiting_user");
    expect(result.run.inbox[0]).toMatchObject({
      title: "detect_bugs requires triage",
      action: { kind: "triage" }
    });
  });

  it("uses the explicit default iteration budget when profile omits one", async () => {
    const calls: string[] = [];
    const result = await runSelfRepairWorkflowLoop(
      baseInput(),
      fakeActivities(calls, {
        detect_bugs: [reviewFail("detect_bugs", [finding("Still broken", "math.ts")])],
        review_regression_tests: Array.from({ length: DEFAULT_SELF_REPAIR_WORKFLOW_MAX_ITERATIONS }, () =>
          reviewPass("review_regression_tests", "tests good")
        ),
        final_review: Array.from({ length: DEFAULT_SELF_REPAIR_WORKFLOW_MAX_ITERATIONS }, () =>
          reviewFail("final_review", [finding("Still broken", "math.ts")])
        )
      })
    );

    expect(result.status).toBe("failed");
    expect(calls.filter((call) => call === "review:detect_bugs")).toHaveLength(1);
    expect(calls.filter((call) => call === "work:fix_bugs")).toHaveLength(DEFAULT_SELF_REPAIR_WORKFLOW_MAX_ITERATIONS);
  });

  it("persists unresolved findings and opens triage inbox items when the loop exhausts its budget", async () => {
    const result = await runSelfRepairWorkflowLoop(
      baseInput({
        profile: {
          ...baseInput().profile,
          policies: {
            self_repair_workflow: { max_iterations: 1 }
          }
        }
      }),
      fakeActivities([], {
        detect_bugs: [reviewFail("detect_bugs", [finding("Structural bug", "src/workflows/selfRepairWorkflowLoop.ts")])],
        review_regression_tests: [reviewPass("review_regression_tests", "tests look good")],
        final_review: [reviewFail("final_review", [finding("Fix still broken", "src/workflows/selfRepairWorkflowLoop.ts")])]
      })
    );

    expect(result.status).toBe("failed");
    expect(result.run.findings.map((item) => item.title)).toEqual([
      "Structural bug",
      "Fix still broken"
    ]);
    expect(result.run.findings.every((item) => item.status === "new")).toBe(true);
    expect(result.run.inbox.map((item) => item.title)).toEqual([
      "Triage finding: Structural bug",
      "Triage finding: Fix still broken"
    ]);
    expect(result.run.inbox.every((item) => item.status === "open")).toBe(true);
  });

  it("marks persisted bootstrap findings fixed after a later pass clears the loop", async () => {
    const result = await runSelfRepairWorkflowLoop(
      baseInput({
        profile: {
          ...baseInput().profile,
          policies: {
            self_repair_workflow: { max_iterations: 2 }
          }
        }
      }),
      fakeActivities([], {
        detect_bugs: [
          reviewFail("detect_bugs", [finding("Structural bug", "src/workflows/selfRepairWorkflowLoop.ts")]),
          reviewPass("detect_bugs", "clean")
        ],
        review_regression_tests: [reviewPass("review_regression_tests", "tests look good")],
        final_review: [reviewPass("final_review", "fix looks good")]
      })
    );

    expect(result.status).toBe("succeeded");
    expect(result.run.findings).toHaveLength(1);
    expect(result.run.findings[0]?.status).toBe("fixed");
    expect(result.run.inbox).toHaveLength(0);
  });

  it("does not re-run detect_bugs until the current bug set passes final_review", async () => {
    const calls: string[] = [];
    const result = await runSelfRepairWorkflowLoop(
      baseInput({
        profile: {
          ...baseInput().profile,
          policies: {
            self_repair_workflow: { max_iterations: 2 }
          }
        }
      }),
      fakeActivities(calls, {
        detect_bugs: [
          reviewFail("detect_bugs", [finding("Carryover bug", "src/workflows/selfRepairWorkflowLoop.ts")]),
          reviewPass("detect_bugs", "did not rediscover the old bug")
        ],
        review_regression_tests: [
          reviewPass("review_regression_tests", "tests good"),
          reviewPass("review_regression_tests", "tests still good")
        ],
        final_review: [
          reviewFail("final_review", [finding("Carryover bug still open", "src/workflows/selfRepairWorkflowLoop.ts")]),
          reviewPass("final_review", "now fixed")
        ]
      })
    );

    expect(result.status).toBe("succeeded");
    expect(calls).toEqual([
      "startRun",
      "createWorktree",
      "review:detect_bugs",
      "work:write_regression_tests",
      "review:review_regression_tests",
      "work:fix_bugs",
      "verify:verify",
      "review:final_review",
      "work:fix_bugs",
      "verify:verify",
      "review:final_review",
      "review:detect_bugs",
      "finalize"
    ]);
  });

  it("retries fix_bugs directly when verify fails instead of re-running detect_bugs first", async () => {
    const calls: string[] = [];
    const result = await runSelfRepairWorkflowLoop(
      baseInput({
        profile: {
          ...baseInput().profile,
          policies: {
            self_repair_workflow: { max_iterations: 3 }
          }
        }
      }),
      fakeActivities(calls, {
        detect_bugs: [
          reviewFail("detect_bugs", [finding("Carryover bug", "src/workflows/selfRepairWorkflowLoop.ts")]),
          reviewPass("detect_bugs", "clean")
        ],
        review_regression_tests: [reviewPass("review_regression_tests", "tests good")],
        final_review: [reviewPass("final_review", "fix looks good")],
        verify: [verifyFailResult("verify"), verifyResult("verify")]
      })
    );

    expect(result.status).toBe("succeeded");
    expect(calls).toEqual([
      "startRun",
      "createWorktree",
      "review:detect_bugs",
      "work:write_regression_tests",
      "review:review_regression_tests",
      "work:fix_bugs",
      "verify:verify",
      "work:fix_bugs",
      "verify:verify",
      "review:final_review",
      "review:detect_bugs",
      "finalize"
    ]);
  });

  it("returns to write_regression_tests when review_regression_tests fails", async () => {
    const calls: string[] = [];
    const result = await runSelfRepairWorkflowLoop(
      baseInput({
        profile: {
          ...baseInput().profile,
          policies: {
            self_repair_workflow: { max_iterations: 2 }
          }
        }
      }),
      fakeActivities(calls, {
        detect_bugs: [
          reviewFail("detect_bugs", [finding("Need sharper regression", "src/workflows/selfRepairWorkflowLoop.ts")]),
          reviewPass("detect_bugs", "clean")
        ],
        review_regression_tests: [
          reviewFail("review_regression_tests", [finding("Regression still weak", "test/selfRepairWorkflowLoop.test.ts")]),
          reviewPass("review_regression_tests", "tests good")
        ],
        final_review: [reviewPass("final_review", "fixed")]
      })
    );

    expect(result.status).toBe("succeeded");
    expect(calls).toEqual([
      "startRun",
      "createWorktree",
      "review:detect_bugs",
      "work:write_regression_tests",
      "review:review_regression_tests",
      "work:write_regression_tests",
      "review:review_regression_tests",
      "work:fix_bugs",
      "verify:verify",
      "review:final_review",
      "review:detect_bugs",
      "finalize"
    ]);
  });

  it("applies commandTimeoutMs to every self_repair_workflow state block before activity dispatch", async () => {
    const seenTimeouts: Array<number | string | undefined> = [];
    const activities = fakeActivities([], {
      detect_bugs: [reviewPass("detect_bugs", "clean")]
    });
    const originalStartRunActivity = activities.startRunActivity;
    const originalRunReviewActivity = activities.runReviewActivity;
    activities.startRunActivity = async (input) => {
      seenTimeouts.push(input.profile?.states?.detect_bugs?.timeout);
      seenTimeouts.push(input.profile?.states?.verify?.timeout);
      return await originalStartRunActivity(input);
    };
    activities.runReviewActivity = async (input) => {
      seenTimeouts.push(input.profile.states?.[input.stateName]?.timeout);
      return await originalRunReviewActivity(input);
    };

    const result = await runSelfRepairWorkflowLoop(
      baseInput({ commandTimeoutMs: 12_345 }),
      activities
    );

    expect(result.status).toBe("succeeded");
    expect(seenTimeouts).toEqual([12_345, 12_345, 12_345]);
  });

  it("tells detect_bugs to prioritize structural root causes before local symptoms", async () => {
    const prompts: string[] = [];
    const activities = fakeActivities([], {
      detect_bugs: [reviewPass("detect_bugs", "clean")]
    });
    const originalRunReviewActivity = activities.runReviewActivity;
    activities.runReviewActivity = async (input) => {
      if (input.stateName === "detect_bugs" && input.extras.prompt) {
        prompts.push(input.extras.prompt);
      }
      return await originalRunReviewActivity(input);
    };

    const result = await runSelfRepairWorkflowLoop(baseInput(), activities);

    expect(result.status).toBe("succeeded");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Prioritize structural problems first");
    expect(prompts[0]).toContain("Prefer the underlying structural defect over listing several local symptoms");
    expect(prompts[0]).toContain("Only report local one-off defects after structural issues are exhausted.");
  });
});

function baseInput(
  overrides: Partial<SelfRepairWorkflowInput> = {}
): SelfRepairWorkflowInput {
  return {
    cwd: "/repo",
    profile: {
      version: "tychonic.config.v1",
      states: {
        detect_bugs: { type: "review", agent: "codex" },
        write_regression_tests: { type: "work", agent: "codex" },
        review_regression_tests: { type: "review", agent: "codex" },
        fix_bugs: { type: "work", agent: "codex" },
        verify: { type: "verify", command: "npm test" },
        final_review: { type: "review", agent: "codex" }
      }
    },
    ...overrides
  };
}

function fakeActivities(
  calls: string[] | Record<string, never>,
  reviews: Partial<
    Record<"detect_bugs" | "review_regression_tests" | "final_review" | "verify", ActivityResult[]>
  >
): SelfRepairWorkflowActivities {
  const callLog = Array.isArray(calls) ? calls : [];
  const reviewQueues = {
    detect_bugs: [...(reviews.detect_bugs ?? [reviewPass("detect_bugs", "clean")])],
    review_regression_tests: [...(reviews.review_regression_tests ?? [reviewPass("review_regression_tests", "tests good")])],
    final_review: [...(reviews.final_review ?? [reviewPass("final_review", "clean")])]
  };
  const verifyQueue = [...(reviews.verify ?? [])];

  return {
    async startRunActivity(input) {
      callLog.push("startRun");
      return {
        schema_version: "tychonic.run.v1",
        id: input.runId ?? "self_repair_workflow_test_run",
        template: input.template,
        status: "created",
        cwd: input.cwd,
        created_at: "2026-04-22T00:00:00.000Z",
        updated_at: "2026-04-22T00:00:00.000Z",
        states: [],
        activity_attempts: [],
        agent_sessions: [],
        artifacts: [],
        findings: [],
        inbox: []
      };
    },
    async createWorktreeActivity() {
      callLog.push("createWorktree");
      return {
        worktreePath: "/repo/.tychonic/worktree",
        mode: "git_worktree",
        reason: "created worktree"
      };
    },
    async runWorkerActivity(input) {
      callLog.push(`work:${input.stateName}`);
      return workerResult(input.stateName);
    },
    async runReviewActivity(input) {
      callLog.push(`review:${input.stateName}`);
      const queue = reviewQueues[input.stateName as keyof typeof reviewQueues];
      const next = queue.shift();
      if (!next) {
        throw new Error(`no canned review result for ${input.stateName}`);
      }
      return next;
    },
    async runVerifyActivity(input) {
      callLog.push(`verify:${input.stateName}`);
      return verifyQueue.shift() ?? verifyResult(input.stateName);
    },
    async finalizeRunActivity(input) {
      callLog.push("finalize");
      const failed = latestStates(input.run).some((state) => state.status === "failed" || state.status === "timed_out");
      const waiting = input.run.inbox.some((item) => item.status === "open");
      return {
        delta: {
          status: failed ? "failed" : waiting ? "waiting_user" : "succeeded",
          ...(input.summary ? { summary: input.summary } : {})
        }
      };
    }
  };
}

function workerResult(stateName: string): ActivityResult {
  const stateId = `${stateName}_state`;
  return {
    delta: {
      states: [
        {
          id: stateId,
          name: stateName,
          status: "succeeded",
          reason: "succeeded",
          activity_attempt_ids: [`${stateName}_attempt`],
          artifact_ids: [],
          finding_ids: [],
          started_at: "2026-04-22T00:00:00.000Z",
          finished_at: "2026-04-22T00:00:01.000Z"
        }
      ],
      activityAttempts: [
        {
          id: `${stateName}_attempt`,
          state_id: stateId,
          kind: "work",
          status: "succeeded",
          reason: "succeeded",
          cwd: "/repo/.tychonic/worktree",
          command: "codex exec",
          started_at: "2026-04-22T00:00:00.000Z",
          finished_at: "2026-04-22T00:00:01.000Z"
        }
      ]
    }
  };
}

function verifyResult(stateName: string): ActivityResult {
  const stateId = `${stateName}_state`;
  return {
    delta: {
      states: [
        {
          id: stateId,
          name: stateName,
          status: "succeeded",
          reason: "succeeded",
          activity_attempt_ids: [`${stateName}_attempt`],
          artifact_ids: [],
          finding_ids: [],
          started_at: "2026-04-22T00:00:00.000Z",
          finished_at: "2026-04-22T00:00:01.000Z"
        }
      ],
      activityAttempts: [
        {
          id: `${stateName}_attempt`,
          state_id: stateId,
          kind: "deterministic_command",
          status: "succeeded",
          reason: "succeeded",
          cwd: "/repo/.tychonic/worktree",
          command: "npm test",
          started_at: "2026-04-22T00:00:00.000Z",
          finished_at: "2026-04-22T00:00:01.000Z"
        }
      ]
    }
  };
}

function verifyFailResult(stateName: string): ActivityResult {
  const stateId = `${stateName}_state_${Math.random().toString(36).slice(2, 6)}`;
  return {
    delta: {
      states: [
        {
          id: stateId,
          name: stateName,
          status: "failed",
          reason: "failed",
          activity_attempt_ids: [`${stateName}_attempt`],
          artifact_ids: [],
          finding_ids: [],
          started_at: "2026-04-22T00:00:00.000Z",
          finished_at: "2026-04-22T00:00:01.000Z"
        }
      ],
      activityAttempts: [
        {
          id: `${stateName}_attempt`,
          state_id: stateId,
          kind: "deterministic_command",
          status: "failed",
          reason: "failed",
          cwd: "/repo/.tychonic/worktree",
          command: "npm test",
          started_at: "2026-04-22T00:00:00.000Z",
          finished_at: "2026-04-22T00:00:01.000Z",
          exit_code: 1
        }
      ]
    }
  };
}

function reviewPass(stateName: string, summary: string): ActivityResult {
  return reviewResult(stateName, "succeeded", {
    kind: "parsed",
    result: {
      schema_version: "tychonic.review.v1",
      status: "pass",
      summary,
      findings: []
    },
    reviewerSessionId: `${stateName}_session`,
    artifacts: [],
    agentSessions: []
  });
}

function reviewFail(stateName: string, findings: ReviewFinding[]): ActivityResult {
  return reviewResult(stateName, "failed", {
    kind: "parsed",
    result: {
      schema_version: "tychonic.review.v1",
      status: "fail",
      summary: findings[0]?.title ?? "fail",
      findings
    },
    reviewerSessionId: `${stateName}_session`,
    artifacts: [],
    agentSessions: []
  });
}

function reviewUnparseable(stateName: string, detail: string): ActivityResult {
  return reviewResult(stateName, "blocked", {
    kind: "unparseable",
    detail,
    reviewerSessionId: `${stateName}_session`,
    artifacts: [],
    agentSessions: []
  });
}

function reviewResult(
  stateName: string,
  status: "succeeded" | "failed" | "blocked",
  reviewOutcome: NonNullable<ActivityResult["reviewOutcome"]>
): ActivityResult {
  const stateId = `${stateName}_state_${Math.random().toString(36).slice(2, 6)}`;
  return {
    delta: {
      states: [
        {
          id: stateId,
          name: stateName,
          status,
          reason: stateName,
          activity_attempt_ids: [`${stateId}_attempt`],
          artifact_ids: [],
          finding_ids: [],
          started_at: "2026-04-22T00:00:00.000Z",
          finished_at: "2026-04-22T00:00:01.000Z"
        }
      ],
      activityAttempts: [
        {
          id: `${stateId}_attempt`,
          state_id: stateId,
          kind: "semantic_review",
          status: status === "blocked" ? "succeeded" : status,
          reason: status,
          cwd: "/repo/.tychonic/worktree",
          command: "codex exec",
          started_at: "2026-04-22T00:00:00.000Z",
          finished_at: "2026-04-22T00:00:01.000Z"
        }
      ]
    },
    reviewOutcome
  };
}

function finding(title: string, target: string): ReviewFinding {
  return {
    severity: "high",
    title,
    detail: `${title} detail`,
    target
  };
}

function latestStates(run: { states: Array<{ name: string; status: string }> }): Array<{ name: string; status: string }> {
  const latest = new Map<string, { name: string; status: string }>();
  for (const state of run.states) {
    latest.set(state.name, state);
  }
  return [...latest.values()];
}
