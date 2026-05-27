import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunRecord } from "../src/domain/types.js";
import type { ActivityResult } from "../src/temporal/types.js";

type SignalHandler = (payload: unknown) => void;
type QueryHandler = () => unknown;

interface Harness {
  signalHandlersByName: Map<string, SignalHandler>;
  queryHandlersByName: Map<string, QueryHandler>;
  conditionCalls: { predicate: () => boolean; resolve: () => void }[];
}

const temporalHarness = vi.hoisted(() => {
  const harness: Harness = {
    signalHandlersByName: new Map(),
    queryHandlersByName: new Map(),
    conditionCalls: []
  };
  const definedSignals = new Map<unknown, string>();
  const definedQueries = new Map<unknown, string>();
  return { harness, definedSignals, definedQueries };
});

vi.mock("@temporalio/workflow", () => ({
  ActivityFailure: class ActivityFailure extends Error {
    constructor(
      message: string | undefined,
      readonly activityType: string,
      readonly activityId: string | undefined,
      readonly retryState: unknown,
      readonly identity: string | undefined,
      cause?: Error
    ) {
      super(message);
      this.name = "ActivityFailure";
      this.cause = cause;
    }
  },
  ApplicationFailure: class ApplicationFailure extends Error {
    readonly type?: string | undefined | null;
    readonly nonRetryable?: boolean | undefined | null;

    constructor(message?: string | undefined | null, type?: string | undefined | null, nonRetryable?: boolean | undefined | null) {
      super(message ?? undefined);
      this.name = "ApplicationFailure";
      this.type = type;
      this.nonRetryable = nonRetryable;
    }

    static create(options: { message?: string; type?: string; nonRetryable?: boolean }) {
      return new this(options.message, options.type, options.nonRetryable);
    }
  },
  defineSignal: (name: string) => {
    const handle = { __name: name, __kind: "signal" };
    temporalHarness.definedSignals.set(handle, name);
    return handle;
  },
  defineQuery: (name: string) => {
    const handle = { __name: name, __kind: "query" };
    temporalHarness.definedQueries.set(handle, name);
    return handle;
  },
  setHandler: (handle: unknown, handler: (...args: unknown[]) => unknown) => {
    const signalName = temporalHarness.definedSignals.get(handle);
    if (signalName) {
      temporalHarness.harness.signalHandlersByName.set(signalName, handler as SignalHandler);
      return;
    }
    const queryName = temporalHarness.definedQueries.get(handle);
    if (queryName) {
      temporalHarness.harness.queryHandlersByName.set(queryName, handler as QueryHandler);
      return;
    }
    throw new Error("unknown signal/query handle");
  },
  isCancellation: (error: unknown) => Boolean(error && typeof error === "object" && "isCancellation" in error),
  workflowInfo: () => ({ workflowId: "wf_context_test" }),
  condition: (predicate: () => boolean) =>
    new Promise<void>((resolve) => {
      if (predicate()) {
        resolve();
        return;
      }
      temporalHarness.harness.conditionCalls.push({ predicate, resolve });
    })
}));

const { createTychonicWorkflowContext } = await import("../src/workflow.js");
const { AGENT_EXECUTABLE_MISSING_FAILURE_TYPE } = await import("../src/adapters/failureTypes.js");
const { ActivityFailure, ApplicationFailure } = await import("@temporalio/workflow");
const { __resetInteractionHookState } = await import("../src/workflows/interactionHook.js");
const {
  interactionApproveStateSignalName,
  interactionRejectStateSignalName,
  interactionModifyStateSignalName,
  interactionPendingStateQueryName,
  interactionRerunStateSignalName,
  tychonicWorkflowStateQueryName
} = await import("../src/temporal/types.js");

describe("Tychonic workflow context recoverable state rerun", () => {
  beforeEach(() => {
    __resetInteractionHookState();
    temporalHarness.harness.signalHandlersByName.clear();
    temporalHarness.harness.queryHandlersByName.clear();
    temporalHarness.harness.conditionCalls.length = 0;
    temporalHarness.definedSignals.clear();
    temporalHarness.definedQueries.clear();
  });

  it("records a thrown verify activity failure and reruns the same state after rerun signal", async () => {
    const runVerifyActivity = vi
      .fn()
      .mockRejectedValueOnce(new Error("network timed out"))
      .mockImplementationOnce(async (input: { stateName: string; cwd: string }): Promise<ActivityResult> => ({
        delta: {
          states: [
            {
              id: "state_verify_success",
              name: input.stateName,
              status: "succeeded",
              reason: "rerun succeeded",
              activity_attempt_ids: ["attempt_verify_success"],
              artifact_ids: [],
              finding_ids: [],
              started_at: "2026-01-01T00:00:01.000Z",
              finished_at: "2026-01-01T00:00:02.000Z"
            }
          ],
          activityAttempts: [
            {
              id: "attempt_verify_success",
              state_id: "state_verify_success",
              kind: "deterministic_command",
              status: "succeeded",
              reason: "rerun succeeded",
              cwd: input.cwd,
              started_at: "2026-01-01T00:00:01.000Z",
              finished_at: "2026-01-01T00:00:02.000Z"
            }
          ]
        }
      }));

    const ctx = createTychonicWorkflowContext({
      input: {
        cwd: "/repo",
        profile: {
          version: "tychonic.config.v1",
          states: {
            verify: { type: "verify", command: "npm test" }
          },
          policies: {}
        }
      },
      template: "recovery_test",
      activities: {
        startRunActivity: async () => ({
          schema_version: "tychonic.run.v1",
          id: "run_recovery",
          template: "recovery_test",
          status: "created",
          cwd: "/repo",
          artifact_root: "/tmp/tychonic-test-runs/run_recovery",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          states: [],
          activity_attempts: [],
          agent_sessions: [],
          artifacts: [],
          findings: [],
          inbox: []
        }),
        runVerifyActivity,
        finalizeRunActivity: async () => ({ delta: { status: "succeeded" } })
      }
    });

    await ctx.start();
    const pending = ctx.verify("verify");
    await flushMicrotasks();

    expect(runVerifyActivity).toHaveBeenCalledTimes(1);
    expect(ctx.run().status).toBe("waiting_user");
    expect(ctx.latestState("verify")?.status).toBe("timed_out");
    expect(runQuery(interactionPendingStateQueryName)).toBe("verify");

    dispatchSignal(interactionRerunStateSignalName, { state: "verify", reason: "network recovered" });

    await expect(pending).resolves.toMatchObject({
      halted: false,
      passed: true,
      state: { id: "state_verify_success", status: "succeeded" }
    });
    expect(runVerifyActivity).toHaveBeenCalledTimes(2);
    expect(ctx.run().states.map((state) => state.status)).toEqual(["timed_out", "succeeded"]);
    expect(ctx.run().activity_attempts.map((attempt) => attempt.status)).toEqual(["timed_out", "succeeded"]);
  });

  it("validates the standard workflow input contract when the context is created", () => {
    expect(() =>
      createTychonicWorkflowContext({
        input: {
          goal: "missing cwd",
          profile: {
            version: "tychonic.config.v1",
            states: {},
            policies: {}
          }
        } as never,
        template: "validation_test",
        activities: {
          startRunActivity: async () => baseRun(),
          finalizeRunActivity: async () => ({ delta: { status: "succeeded" } })
        }
      })
    ).toThrow(/cwd must be a non-empty string/);
  });

  it("does not publish terminal status before worktree patch extract finishes", async () => {
    let releaseExtract!: () => void;
    let extractStarted = false;
    const extractWorktreePatchActivity = vi.fn(async (): Promise<ActivityResult & { extracted: true }> => {
      extractStarted = true;
      await new Promise<void>((resolve) => {
        releaseExtract = resolve;
      });
      return { extracted: true, delta: {}, cleanupOutcome: { artifacts: [] } };
    });
    const worktreePath = "/tmp/tychonic-worktree-run_recovery-test/worktree";
    const ctx = createTychonicWorkflowContext({
      input: {
        cwd: "/repo",
        profile: {
          version: "tychonic.config.v1",
          states: {},
          policies: {}
        }
      },
      template: "extract_publish_test",
      activities: {
        startRunActivity: async () => baseRun(),
        createWorktreeActivity: async () => ({
          worktreePath,
          worktreeParentDir: "/tmp/tychonic-worktree-run_recovery-test",
          baseHead: "0123456789abcdef0123456789abcdef01234567"
        }),
        extractWorktreePatchActivity,
        finalizeRunActivity: async () => ({ delta: { status: "succeeded" } })
      }
    });

    await ctx.start();
    await ctx.createWorktree();
    const pending = ctx.finish();
    await flushMicrotasks();

    expect(extractStarted).toBe(true);
    expect((runQuery(tychonicWorkflowStateQueryName) as any).status).toBe("running");

    releaseExtract();
    await expect(pending).resolves.toMatchObject({ status: "succeeded", worktreePath });
    const published = runQuery(tychonicWorkflowStateQueryName) as any;
    expect(published.status).toBe("succeeded");
    expect(published.worktreePath).toBe(worktreePath);
  });

  it("publishes cancelled run evidence without dropping prior state records", async () => {
    const finalizeRunActivity = vi.fn(async (): Promise<ActivityResult> => ({ delta: { status: "succeeded" } }));
    const ctx = createTychonicWorkflowContext({
      input: {
        cwd: "/repo",
        profile: {
          version: "tychonic.config.v1",
          states: {
            verify: { type: "verify", command: "npm test" }
          },
          policies: {}
        }
      },
      template: "cancel_test",
      activities: {
        startRunActivity: async () => baseRun(),
        finalizeRunActivity
      }
    });

    await ctx.start();
    ctx.apply({
      delta: {
        states: [
          {
            id: "state_verify_done",
            name: "verify",
            status: "succeeded",
            reason: "checks passed before cancellation",
            activity_attempt_ids: [],
            artifact_ids: [],
            finding_ids: [],
            started_at: "2026-01-01T00:00:01.000Z",
            finished_at: "2026-01-01T00:00:02.000Z"
          }
        ]
      }
    });

    const result = await ctx.cancel("operator cancelled workflow");

    expect(result).toMatchObject({
      status: "cancelled",
      summary: "operator cancelled workflow",
      run: {
        status: "cancelled",
        summary: "operator cancelled workflow",
        states: [{ id: "state_verify_done", name: "verify", status: "succeeded" }]
      }
    });
    expect((runQuery(tychonicWorkflowStateQueryName) as any).run.states).toHaveLength(1);
    expect(finalizeRunActivity).not.toHaveBeenCalled();
  });

  it("publishes cancelled evidence immediately and adds the worktree patch when extraction completes", async () => {
    let releaseExtract!: () => void;
    let extractStarted = false;
    const patchArtifact = {
      id: "artifact_1",
      kind: "worktree_patch" as const,
      path: "artifacts/worktree_patch-artifact_1.patch",
      created_at: "2026-01-01T00:00:03.000Z"
    };
    const extractWorktreePatchActivity = vi.fn(async (): Promise<ActivityResult & { extracted: true }> => {
      extractStarted = true;
      await new Promise<void>((resolve) => {
        releaseExtract = resolve;
      });
      return { extracted: true, delta: {}, cleanupOutcome: { artifacts: [patchArtifact] } };
    });
    const finalizeRunActivity = vi.fn(async (): Promise<ActivityResult> => ({ delta: { status: "succeeded" } }));
    const worktreePath = "/tmp/tychonic-worktree-run_recovery-test/worktree";
    const ctx = createTychonicWorkflowContext({
      input: {
        cwd: "/repo",
        profile: {
          version: "tychonic.config.v1",
          states: {},
          policies: {}
        }
      },
      template: "cancel_extract_test",
      activities: {
        startRunActivity: async () => baseRun(),
        createWorktreeActivity: async () => ({
          worktreePath,
          worktreeParentDir: "/tmp/tychonic-worktree-run_recovery-test",
          baseHead: "0123456789abcdef0123456789abcdef01234567"
        }),
        extractWorktreePatchActivity,
        finalizeRunActivity
      }
    });

    await ctx.start();
    await ctx.createWorktree();
    const pending = ctx.cancel("operator cancelled workflow");
    await flushMicrotasks();

    expect(extractStarted).toBe(true);
    expect((runQuery(tychonicWorkflowStateQueryName) as any).status).toBe("cancelled");
    expect((runQuery(tychonicWorkflowStateQueryName) as any).run.artifacts).toEqual([]);

    releaseExtract();
    await expect(pending).resolves.toMatchObject({
      status: "cancelled",
      worktreePath,
      run: {
        status: "cancelled",
        artifacts: [patchArtifact]
      }
    });
    const published = runQuery(tychonicWorkflowStateQueryName) as any;
    expect(published.status).toBe("cancelled");
    expect(published.worktreePath).toBe(worktreePath);
    expect(published.run.artifacts).toEqual([patchArtifact]);
    expect(extractWorktreePatchActivity).toHaveBeenCalledWith({
      run: expect.objectContaining({ status: "cancelled", summary: "operator cancelled workflow" }),
      cwd: "/repo",
      worktreePath,
      worktreeParentDir: "/tmp/tychonic-worktree-run_recovery-test",
      baseHead: "0123456789abcdef0123456789abcdef01234567"
    });
    expect(finalizeRunActivity).not.toHaveBeenCalled();
  });

  it("keeps cancelled evidence when worktree patch extraction fails during cancellation", async () => {
    const extractWorktreePatchActivity = vi.fn(async () => {
      throw new Error("patch extract failed");
    });
    const finalizeRunActivity = vi.fn(async (): Promise<ActivityResult> => ({ delta: { status: "succeeded" } }));
    const worktreePath = "/tmp/tychonic-worktree-run_recovery-test/worktree";
    const ctx = createTychonicWorkflowContext({
      input: {
        cwd: "/repo",
        profile: {
          version: "tychonic.config.v1",
          states: {},
          policies: {}
        }
      },
      template: "cancel_extract_failure_test",
      activities: {
        startRunActivity: async () => baseRun(),
        createWorktreeActivity: async () => ({
          worktreePath,
          worktreeParentDir: "/tmp/tychonic-worktree-run_recovery-test",
          baseHead: "0123456789abcdef0123456789abcdef01234567"
        }),
        extractWorktreePatchActivity,
        finalizeRunActivity
      }
    });

    await ctx.start();
    await ctx.createWorktree();

    await expect(ctx.cancel("operator cancelled workflow")).resolves.toMatchObject({
      status: "cancelled",
      worktreePath,
      run: {
        status: "cancelled",
        summary: "operator cancelled workflow; worktree patch capture failed: patch extract failed",
        artifacts: []
      }
    });
    expect((runQuery(tychonicWorkflowStateQueryName) as any).status).toBe("cancelled");
    expect((runQuery(tychonicWorkflowStateQueryName) as any).summary).toBe(
      "operator cancelled workflow; worktree patch capture failed: patch extract failed"
    );
    expect(extractWorktreePatchActivity).toHaveBeenCalledTimes(1);
    expect(finalizeRunActivity).not.toHaveBeenCalled();
  });

  it("rethrows Temporal cancellation instead of recording it as a recoverable activity failure", async () => {
    const cancellation = Object.assign(new Error("workflow cancelled"), { isCancellation: true });
    const ctx = createTychonicWorkflowContext({
      input: {
        cwd: "/repo",
        profile: {
          version: "tychonic.config.v1",
          states: {
            verify: { type: "verify", command: "npm test" }
          },
          policies: {}
        }
      },
      template: "cancel_test",
      activities: {
        startRunActivity: async () => baseRun(),
        runVerifyActivity: vi.fn(async () => {
          throw cancellation;
        }),
        finalizeRunActivity: async () => ({ delta: { status: "succeeded" } })
      }
    });

    await ctx.start();
    await expect(ctx.verify("verify")).rejects.toBe(cancellation);
    expect(ctx.run().states).toHaveLength(0);
    expect(ctx.run().status).toBe("running");
  });

  it("rethrows Temporal cancellation from work and review activities", async () => {
    for (const kind of ["work", "review"] as const) {
      __resetInteractionHookState();
      temporalHarness.harness.signalHandlersByName.clear();
      temporalHarness.harness.queryHandlersByName.clear();
      temporalHarness.harness.conditionCalls.length = 0;
      temporalHarness.definedSignals.clear();
      temporalHarness.definedQueries.clear();
      const cancellation = Object.assign(new Error(`${kind} cancelled`), { isCancellation: true });
      const activity = vi.fn(async () => {
        throw cancellation;
      });
      const ctx = createTychonicWorkflowContext({
        input: {
          cwd: "/repo",
          profile: {
            version: "tychonic.config.v1",
            states: kind === "work"
              ? { work: { type: "work", agent: "claude" } }
              : {
                  work: { type: "work", agent: "claude" },
                  review: { type: "review", on_fail_return_to: "work", agent: "claude" }
                },
            policies: {}
          }
        },
        template: `${kind}_cancel_test`,
        activities: {
          startRunActivity: async () => baseRun(),
          ...(kind === "work" ? { runWorkerActivity: activity } : { runReviewActivity: activity }),
          finalizeRunActivity: async () => ({ delta: { status: "succeeded" } })
        }
      });

      await ctx.start();
      if (kind === "work") {
        await expect(ctx.work("work", "implement")).rejects.toBe(cancellation);
      } else {
        await expect(ctx.review("review", "review")).rejects.toBe(cancellation);
      }
      expect(ctx.run().states).toHaveLength(0);
      expect(ctx.run().status).toBe("running");
      expect(activity).toHaveBeenCalledTimes(1);
    }
  });

  it("does not offer rerun recovery for an ordinary failed verify result", async () => {
    const runVerifyActivity = vi
      .fn()
      .mockImplementationOnce(async (input: { stateName: string; cwd: string }): Promise<ActivityResult> => ({
        delta: {
          states: [
            {
              id: "state_verify_failed",
              name: input.stateName,
              status: "failed",
              reason: "command failed",
              activity_attempt_ids: ["attempt_verify_failed"],
              artifact_ids: [],
              finding_ids: [],
              started_at: "2026-01-01T00:00:01.000Z",
              finished_at: "2026-01-01T00:00:02.000Z"
            }
          ],
          activityAttempts: [
            {
              id: "attempt_verify_failed",
              state_id: "state_verify_failed",
              kind: "deterministic_command",
              status: "failed",
              reason: "command failed",
              cwd: input.cwd,
              started_at: "2026-01-01T00:00:01.000Z",
              finished_at: "2026-01-01T00:00:02.000Z"
            }
          ]
        }
      }));

    const ctx = createTychonicWorkflowContext({
      input: {
        cwd: "/repo",
        profile: {
          version: "tychonic.config.v1",
          states: {
            verify: { type: "verify", command: "npm test" }
          },
          policies: {}
        }
      },
      template: "recovery_test",
      activities: {
        startRunActivity: async () => ({
          schema_version: "tychonic.run.v1",
          id: "run_recovery",
          template: "recovery_test",
          status: "created",
          cwd: "/repo",
          artifact_root: "/tmp/tychonic-test-runs/run_recovery",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          states: [],
          activity_attempts: [],
          agent_sessions: [],
          artifacts: [],
          findings: [],
          inbox: []
        }),
        runVerifyActivity,
        finalizeRunActivity: async () => ({ delta: { status: "succeeded" } })
      }
    });

    await ctx.start();
    await expect(ctx.verify("verify")).resolves.toMatchObject({
      halted: false,
      passed: false,
      state: { id: "state_verify_failed", status: "failed" }
    });
    expect(runVerifyActivity).toHaveBeenCalledTimes(1);
    expect(ctx.run().status).not.toBe("waiting_user");
    expect(runQuery(interactionPendingStateQueryName)).toBeUndefined();
  });

  it("closes state execution instead of offering rerun when an agent executable is missing", async () => {
    const missingExecutable = ApplicationFailure.create({
      message: "work activity 'work' run: required agent executable not found. openp required by states.work.agent=claude",
      type: AGENT_EXECUTABLE_MISSING_FAILURE_TYPE,
      nonRetryable: true
    });
    const runWorkerActivity = vi.fn(async () => {
      throw new ActivityFailure(
        "Activity failure",
        "runWorkerActivity",
        "activity-1",
        0,
        "worker",
        missingExecutable
      );
    });
    const ctx = createTychonicWorkflowContext({
      input: {
        cwd: "/repo",
        profile: {
          version: "tychonic.config.v1",
          states: {
            work: { type: "work", agent: "claude" }
          },
          policies: {}
        }
      },
      template: "terminal_missing_cli_test",
      activities: {
        startRunActivity: async () => baseRun(),
        runWorkerActivity,
        finalizeRunActivity: async () => ({ delta: { status: "succeeded" } })
      }
    });

    await ctx.start();
    await expect(ctx.work("work", "implement")).resolves.toMatchObject({
      halted: true,
      passed: false,
      state: {
        name: "work",
        status: "failed",
        reason: "activity 'work' failed before returning a Tychonic result; this failure is not rerunnable"
      }
    });
    expect(ctx.run().status).toBe("running");
    expect(ctx.run().activity_attempts[0]?.error).toContain("required agent executable not found");
    expect(runQuery(interactionPendingStateQueryName)).toBeUndefined();
    expect(temporalHarness.harness.conditionCalls).toEqual([]);
  });

  it("clears waiting_user when recovery receives approve", async () => {
    const runVerifyActivity = vi.fn().mockRejectedValueOnce(new Error("network timed out"));
    const ctx = createTychonicWorkflowContext({
      input: {
        cwd: "/repo",
        profile: {
          version: "tychonic.config.v1",
          states: {
            verify: { type: "verify", command: "npm test" }
          },
          policies: {}
        }
      },
      template: "recovery_test",
      activities: {
        startRunActivity: async () => baseRun(),
        runVerifyActivity,
        finalizeRunActivity: async () => ({ delta: { status: "succeeded" } })
      }
    });

    await ctx.start();
    const pending = ctx.verify("verify");
    await flushMicrotasks();

    expect(ctx.run().status).toBe("waiting_user");
    dispatchSignal(interactionApproveStateSignalName, { state: "verify" });

    await expect(pending).resolves.toMatchObject({
      halted: false,
      passed: false,
      state: { name: "verify", status: "timed_out" }
    });
    expect(ctx.run().status).toBe("running");
  });

  it("clears waiting_user when recovery receives modify", async () => {
    const runVerifyActivity = vi.fn().mockRejectedValueOnce(new Error("network timed out"));
    const ctx = createTychonicWorkflowContext({
      input: {
        cwd: "/repo",
        profile: {
          version: "tychonic.config.v1",
          states: {
            verify: { type: "verify", command: "npm test" }
          },
          policies: {}
        }
      },
      template: "recovery_test",
      activities: {
        startRunActivity: async () => baseRun(),
        runVerifyActivity,
        finalizeRunActivity: async () => ({ delta: { status: "succeeded" } })
      }
    });

    await ctx.start();
    const pending = ctx.verify("verify");
    await flushMicrotasks();

    expect(ctx.run().status).toBe("waiting_user");
    dispatchSignal(interactionModifyStateSignalName, {
      state: "verify",
      patch: { status: "failed", note: "operator accepted the failed attempt" }
    });

    await expect(pending).resolves.toMatchObject({
      halted: false,
      passed: false,
      state: { name: "verify", status: "failed" }
    });
    expect(ctx.run().status).toBe("running");
  });
});

describe("Tychonic workflow context interactive approval status", () => {
  beforeEach(() => {
    __resetInteractionHookState();
    temporalHarness.harness.signalHandlersByName.clear();
    temporalHarness.harness.queryHandlersByName.clear();
    temporalHarness.harness.conditionCalls.length = 0;
    temporalHarness.definedSignals.clear();
    temporalHarness.definedQueries.clear();
  });

  it("marks an interactive approval wait as waiting_user and clears it after approve", async () => {
    const runWorkerActivity = vi
      .fn()
      .mockResolvedValueOnce(successfulWorkResult("work", "state_work_success", "attempt_work_success"));
    const ctx = createInteractiveWorkContext(runWorkerActivity);

    await ctx.start();
    const pending = ctx.work("work", "implement the task");
    await flushMicrotasks();

    expect(runWorkerActivity).toHaveBeenCalledTimes(1);
    expect(ctx.run().status).toBe("waiting_user");
    expect(runQuery(interactionPendingStateQueryName)).toBe("work");

    dispatchSignal(interactionApproveStateSignalName, { state: "work" });

    await expect(pending).resolves.toMatchObject({
      halted: false,
      passed: true,
      state: { name: "work", status: "succeeded" }
    });
    expect(ctx.run().status).toBe("running");
    expect(runQuery(interactionPendingStateQueryName)).toBeUndefined();
  });

  it("appends promptAdditions to work prompts inside the context helper", async () => {
    const runWorkerActivity = vi
      .fn()
      .mockResolvedValueOnce(successfulWorkResult("work", "state_work_success", "attempt_work_success"));
    const ctx = createTychonicWorkflowContext({
      input: {
        cwd: "/repo",
        promptAdditions: { work: "include the migration test" },
        profile: {
          version: "tychonic.config.v1",
          states: {
            work: { type: "work", agent: "claude" }
          },
          policies: {}
        }
      },
      template: "prompt_addition_test",
      activities: {
        startRunActivity: async () => baseRun(),
        runWorkerActivity,
        finalizeRunActivity: async () => ({ delta: { status: "succeeded" } })
      }
    });

    await ctx.start();
    await ctx.work("work", "implement the task");

    expect(runWorkerActivity).toHaveBeenCalledTimes(1);
    expect(runWorkerActivity.mock.calls[0]?.[0].prompt).toBe(
      [
        "implement the task",
        "",
        "[operator additional instructions for work]",
        "include the migration test",
        "[/operator additional instructions]"
      ].join("\n")
    );
  });

  it("returns halted when a review activity produces a blocked state", async () => {
    const runReviewActivity = vi.fn().mockResolvedValueOnce({
      delta: {
        states: [
          {
            id: "state_review_blocked",
            name: "review",
            status: "blocked",
            reason: "reviewer output did not match tychonic.review.v1",
            activity_attempt_ids: ["attempt_review_blocked"],
            artifact_ids: [],
            finding_ids: [],
            started_at: "2026-01-01T00:00:01.000Z",
            finished_at: "2026-01-01T00:00:02.000Z"
          }
        ],
        activityAttempts: [
          {
            id: "attempt_review_blocked",
            state_id: "state_review_blocked",
            kind: "semantic_review",
            status: "succeeded",
            reason: "succeeded",
            cwd: "/repo",
            started_at: "2026-01-01T00:00:01.000Z",
            finished_at: "2026-01-01T00:00:02.000Z"
          }
        ]
      },
      reviewOutcome: {
        kind: "unparseable",
        detail: "reviewer output did not match tychonic.review.v1",
        artifacts: [],
        agentSessions: []
      }
    } satisfies ActivityResult);
    const ctx = createTychonicWorkflowContext({
      input: {
        cwd: "/repo",
        profile: {
          version: "tychonic.config.v1",
          states: {
            work: { type: "work", agent: "claude" },
            review: { type: "review", on_fail_return_to: "work", agent: "claude" }
          },
          policies: {}
        }
      },
      template: "blocked_review_test",
      activities: {
        startRunActivity: async () => baseRun(),
        runReviewActivity,
        finalizeRunActivity: async () => ({ delta: { status: "succeeded" } })
      }
    });

    await ctx.start();
    await expect(ctx.review("review", "review this")).resolves.toMatchObject({
      halted: true,
      passed: false,
      summary: "reviewer output did not match tychonic.review.v1",
      state: { name: "review", status: "blocked" }
    });
    expect(runReviewActivity).toHaveBeenCalledTimes(1);
    expect(ctx.run().status).not.toBe("waiting_user");
    expect(runQuery(interactionPendingStateQueryName)).toBeUndefined();
  });

  it("clears waiting_user while a rejected interactive work state reruns", async () => {
    let resolveSecondAttempt!: (result: ActivityResult) => void;
    const secondAttempt = new Promise<ActivityResult>((resolve) => {
      resolveSecondAttempt = resolve;
    });
    const runWorkerActivity = vi
      .fn()
      .mockResolvedValueOnce(successfulWorkResult("work", "state_work_first", "attempt_work_first"))
      .mockReturnValueOnce(secondAttempt);
    const ctx = createInteractiveWorkContext(runWorkerActivity);

    await ctx.start();
    const pending = ctx.work("work", "implement the task");
    await flushMicrotasks();

    expect(ctx.run().status).toBe("waiting_user");
    dispatchSignal(interactionRejectStateSignalName, { state: "work", feedback: "retry with fix" });
    await flushMicrotasks();

    expect(runWorkerActivity).toHaveBeenCalledTimes(2);
    expect(ctx.run().status).toBe("running");

    resolveSecondAttempt(successfulWorkResult("work", "state_work_second", "attempt_work_second"));
    await flushMicrotasks();

    expect(ctx.run().status).toBe("waiting_user");
    dispatchSignal(interactionApproveStateSignalName, { state: "work" });

    await expect(pending).resolves.toMatchObject({
      halted: false,
      passed: true,
      state: { name: "work", status: "succeeded" }
    });
    expect(ctx.run().status).toBe("running");
  });
});

function baseRun(): WorkflowRunRecord {
  return {
    schema_version: "tychonic.run.v1",
    id: "run_recovery",
    template: "recovery_test",
    status: "created",
    cwd: "/repo",
    artifact_root: "/tmp/tychonic-test-runs/run_recovery",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    states: [],
    activity_attempts: [],
    agent_sessions: [],
    artifacts: [],
    findings: [],
    inbox: []
  };
}

function createInteractiveWorkContext(runWorkerActivity: ReturnType<typeof vi.fn>) {
  return createTychonicWorkflowContext({
    input: {
      cwd: "/repo",
      profile: {
        version: "tychonic.config.v1",
        states: {
          work: { type: "work", agent: "claude" }
        },
        policies: {
          interaction: { mode: "interactive" }
        }
      }
    },
    template: "approval_test",
    activities: {
      startRunActivity: async () => baseRun(),
      runWorkerActivity,
      finalizeRunActivity: async () => ({ delta: { status: "succeeded" } })
    }
  });
}

function successfulWorkResult(stateName: string, stateId: string, attemptId: string): ActivityResult {
  return {
    delta: {
      states: [
        {
          id: stateId,
          name: stateName,
          status: "succeeded",
          reason: "work succeeded",
          activity_attempt_ids: [attemptId],
          artifact_ids: [],
          finding_ids: [],
          started_at: "2026-01-01T00:00:01.000Z",
          finished_at: "2026-01-01T00:00:02.000Z"
        }
      ],
      activityAttempts: [
        {
          id: attemptId,
          state_id: stateId,
          kind: "agent_run",
          status: "succeeded",
          reason: "work succeeded",
          cwd: "/repo",
          started_at: "2026-01-01T00:00:01.000Z",
          finished_at: "2026-01-01T00:00:02.000Z"
        }
      ]
    }
  };
}

function dispatchSignal(signalName: string, payload: unknown): void {
  const handler = temporalHarness.harness.signalHandlersByName.get(signalName);
  if (!handler) {
    throw new Error(`no handler registered for signal ${signalName}`);
  }
  handler(payload);
  for (let i = temporalHarness.harness.conditionCalls.length - 1; i >= 0; i--) {
    const call = temporalHarness.harness.conditionCalls[i]!;
    if (call.predicate()) {
      temporalHarness.harness.conditionCalls.splice(i, 1);
      call.resolve();
    }
  }
}

function runQuery(queryName: string): unknown {
  const handler = temporalHarness.harness.queryHandlersByName.get(queryName);
  if (!handler) {
    throw new Error(`no handler registered for query ${queryName}`);
  }
  return handler();
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
