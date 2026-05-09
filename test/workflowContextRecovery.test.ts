import { beforeEach, describe, expect, it, vi } from "vitest";
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
const { __resetInteractionHookState } = await import("../src/workflows/interactionHook.js");
const { interactionPendingStateQueryName, interactionRerunStateSignalName } = await import("../src/temporal/types.js");

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
});

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
