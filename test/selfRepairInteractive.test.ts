import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runSelfRepairWorkflowLoop,
  type SelfRepairWorkflowActivities
} from "../src/workflows/selfRepairWorkflowLoop.js";
import {
  __resetInteractionHookState,
  __setInteractionHookHarness,
  registerInteractionSignals,
  setInteractionPolicy
} from "../src/workflows/interactionHook.js";
import {
  interactionApproveStateSignalName,
  interactionRejectStateSignalName
} from "../src/temporal/types.js";
import type { ActivityResult, SelfRepairWorkflowInput } from "../src/temporal/types.js";
import type { ReviewFinding } from "../src/review/schema.js";

type SignalHandler = (payload: unknown) => void;

interface Harness {
  signalHandlersByName: Map<string, SignalHandler>;
  conditionCalls: { predicate: () => boolean; resolve: () => void }[];
}

function installHarness(): Harness {
  const harness: Harness = {
    signalHandlersByName: new Map(),
    conditionCalls: []
  };
  const defined = new Map<unknown, string>();
  __setInteractionHookHarness({
    defineSignal: ((name: string) => {
      const h = { __name: name };
      defined.set(h, name);
      return h;
    }) as unknown as typeof import("@temporalio/workflow").defineSignal,
    defineQuery: ((name: string) => {
      const h = { __name: name };
      return h;
    }) as unknown as typeof import("@temporalio/workflow").defineQuery,
    setHandler: ((handle: unknown, handler: (...args: unknown[]) => unknown) => {
      const signalName = defined.get(handle);
      if (signalName) {
        harness.signalHandlersByName.set(signalName, handler as SignalHandler);
      }
    }) as unknown as typeof import("@temporalio/workflow").setHandler,
    condition: ((predicate: () => boolean) =>
      new Promise<void>((resolve) => {
        if (predicate()) {
          resolve();
          return;
        }
        harness.conditionCalls.push({ predicate, resolve });
      })) as unknown as typeof import("@temporalio/workflow").condition
  });
  return harness;
}

function dispatch(harness: Harness, name: string, payload: unknown): void {
  const handler = harness.signalHandlersByName.get(name);
  if (!handler) {
    throw new Error(`no handler for signal ${name}`);
  }
  handler(payload);
  for (let i = harness.conditionCalls.length - 1; i >= 0; i--) {
    const call = harness.conditionCalls[i]!;
    if (call.predicate()) {
      harness.conditionCalls.splice(i, 1);
      call.resolve();
    }
  }
}

describe("selfRepairWorkflow interactive loop", () => {
  let harness: Harness;

  beforeEach(() => {
    __resetInteractionHookState();
    harness = installHarness();
  });

  afterEach(() => {
    __setInteractionHookHarness(undefined);
    __resetInteractionHookState();
  });

  it("auto mode baseline runs unchanged and never suspends", async () => {
    registerInteractionSignals();
    setInteractionPolicy(undefined);
    const calls: string[] = [];
    const result = await runSelfRepairWorkflowLoop(
      baseInput(),
      fakeActivities(calls, {
        detect_bugs: [reviewPass("detect_bugs", "clean")]
      })
    );
    expect(result.status).toBe("succeeded");
    expect(calls).toEqual(["startRun", "createWorktree", "review:detect_bugs", "finalize"]);
    expect(harness.conditionCalls).toHaveLength(0);
  });

  it("interactive approve flow succeeds when every state is approved", async () => {
    registerInteractionSignals();
    setInteractionPolicy({ mode: "interactive" });
    // Pre-dispatch approvals for every state name the workflow will
    // gate, in arrival order. The FIFO queue picks them up as each
    // hook call targets its own state name.
    const signalsToDispatch = [
      "create_isolated_worktree",
      "detect_bugs",
      "finalize_run"
    ];
    // Run the workflow and dispatch approvals as the gate reaches
    // each state. Use a micro-task driver.
    const promise = runSelfRepairWorkflowLoop(
      baseInputInteractive(),
      fakeActivities([], {
        detect_bugs: [reviewPass("detect_bugs", "clean")]
      })
    );
    for (const state of signalsToDispatch) {
      await flushMicrotasks();
      dispatch(harness, interactionApproveStateSignalName, { state });
    }
    const result = await promise;
    expect(result.status).toBe("succeeded");
  });

  it("reject of detect_bugs still funnels findings into the outer loop (incorporation strategy)", async () => {
    registerInteractionSignals();
    setInteractionPolicy({ mode: "interactive", max_reject_iterations: 5 });
    const input = baseInputInteractive(5);
    const activities = fakeActivities([], {
      detect_bugs: [reviewPass("detect_bugs", "looks clean")]
    });
    const promise = runSelfRepairWorkflowLoop(input, activities);
    await flushMicrotasks();
    dispatch(harness, interactionApproveStateSignalName, { state: "create_isolated_worktree" });
    await flushMicrotasks();
    dispatch(harness, interactionRejectStateSignalName, {
      state: "detect_bugs",
      feedback: "you missed a security issue"
    });
    // After the override, the loop enters the fix path using the
    // synthetic finding. Approve every subsequent state until the
    // workflow can finalize.
    for (const state of [
      "write_regression_tests",
      "review_regression_tests",
      "fix_bugs",
      "verify",
      "final_review",
      "detect_bugs",
      "finalize_run"
    ]) {
      await flushMicrotasks();
      dispatch(harness, interactionApproveStateSignalName, { state });
    }
    const result = await promise;
    const overrideFinding = result.run.findings.find(
      (f) => f.title === "Interactive reject override on detect_bugs"
    );
    expect(overrideFinding).toBeDefined();
    expect(overrideFinding?.detail).toBe("you missed a security issue");
  }, 15_000);
});

function baseInput(overrides: Partial<SelfRepairWorkflowInput> = {}): SelfRepairWorkflowInput {
  return {
    cwd: "/repo",
    profile: {
      version: "tychonic.config.v1",
      states: {
        detect_bugs: { type: "review", agent: "codex", emits: ["tychonic.review.v1"] },
        write_regression_tests: { type: "work", agent: "codex", command: "codex" },
        review_regression_tests: { type: "review", agent: "codex", emits: ["tychonic.review.v1"] },
        fix_bugs: { type: "work", agent: "codex", command: "codex" },
        verify: { type: "verify", command: "npm test" },
        final_review: { type: "review", agent: "codex", emits: ["tychonic.review.v1"] }
      }
    },
    ...overrides
  };
}

function baseInputInteractive(cap?: number): SelfRepairWorkflowInput {
  const base = baseInput();
  return {
    ...base,
    profile: {
      ...base.profile,
      policies: {
        ...(base.profile.policies ?? {}),
        interaction:
          cap === undefined ? { mode: "interactive" } : { mode: "interactive", max_reject_iterations: cap }
      }
    }
  };
}

function fakeActivities(
  calls: string[],
  reviews: Partial<Record<"detect_bugs" | "review_regression_tests" | "final_review" | "verify", ActivityResult[]>>
): SelfRepairWorkflowActivities {
  const reviewQueues = {
    detect_bugs: [...(reviews.detect_bugs ?? [reviewPass("detect_bugs", "clean")])],
    review_regression_tests: [
      ...(reviews.review_regression_tests ?? [reviewPass("review_regression_tests", "tests good")])
    ],
    final_review: [...(reviews.final_review ?? [reviewPass("final_review", "clean")])]
  };
  return {
    async startRunActivity(input) {
      calls.push("startRun");
      return {
        schema_version: "tychonic.run.v1",
        id: input.runId ?? "run_srw_int",
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
      calls.push("createWorktree");
      return {
        worktreePath: "/repo/.tychonic/worktree",
        mode: "git_worktree",
        reason: "created worktree"
      };
    },
    async runWorkerActivity(input) {
      calls.push(`work:${input.stateName}`);
      return workerResult(input.stateName);
    },
    async runReviewActivity(input) {
      calls.push(`review:${input.stateName}`);
      const queue = reviewQueues[input.stateName as keyof typeof reviewQueues];
      const next = queue.shift() ?? reviewPass(input.stateName, "clean");
      return next;
    },
    async runVerifyActivity(input) {
      calls.push(`verify:${input.stateName}`);
      return verifyResult(input.stateName);
    },
    async finalizeRunActivity(input) {
      calls.push("finalize");
      const failed = input.run.states.some(
        (state) => state.status === "failed" || state.status === "timed_out"
      );
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
      activityAttempts: []
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
          activity_attempt_ids: [],
          artifact_ids: [],
          finding_ids: [],
          started_at: "2026-04-22T00:00:00.000Z",
          finished_at: "2026-04-22T00:00:01.000Z"
        }
      ],
      activityAttempts: []
    }
  };
}

function reviewPass(stateName: string, summary: string): ActivityResult {
  return {
    delta: {
      states: [
        {
          id: `${stateName}_state`,
          name: stateName,
          status: "succeeded",
          reason: "succeeded",
          activity_attempt_ids: [],
          artifact_ids: [],
          finding_ids: [],
          started_at: "2026-04-22T00:00:00.000Z",
          finished_at: "2026-04-22T00:00:01.000Z"
        }
      ],
      activityAttempts: []
    },
    reviewOutcome: {
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
    }
  };
}

function reviewFail(stateName: string, findings: ReviewFinding[]): ActivityResult {
  return {
    delta: {
      states: [
        {
          id: `${stateName}_state`,
          name: stateName,
          status: "failed",
          reason: "failed",
          activity_attempt_ids: [],
          artifact_ids: [],
          finding_ids: [],
          started_at: "2026-04-22T00:00:00.000Z",
          finished_at: "2026-04-22T00:00:01.000Z"
        }
      ],
      activityAttempts: []
    },
    reviewOutcome: {
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
    }
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
