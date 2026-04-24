import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gateDecisionForCheckpoint } from "../src/workflows/checkpoint.js";
import {
  __resetInteractionHookState,
  __setInteractionHookHarness,
  registerInteractionSignals,
  setInteractionPolicy,
  effectiveInteractionMode
} from "../src/workflows/interactionHook.js";
import {
  interactionApproveStateSignalName,
  interactionModifyStateSignalName,
  interactionRejectStateSignalName
} from "../src/temporal/types.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";
import type { TychonicConfig } from "../src/catalog/types.js";

type SignalHandler = (payload: unknown) => void;
type QueryHandler = () => unknown;

interface Harness {
  signalHandlersByName: Map<string, SignalHandler>;
  queryHandlersByName: Map<string, QueryHandler>;
  conditionCalls: { predicate: () => boolean; resolve: () => void }[];
}

function installHarness(): Harness {
  const harness: Harness = {
    signalHandlersByName: new Map(),
    queryHandlersByName: new Map(),
    conditionCalls: []
  };
  const definedSignals = new Map<unknown, string>();
  const definedQueries = new Map<unknown, string>();
  __setInteractionHookHarness({
    defineSignal: ((name: string) => {
      const h = { __name: name };
      definedSignals.set(h, name);
      return h;
    }) as unknown as typeof import("@temporalio/workflow").defineSignal,
    defineQuery: ((name: string) => {
      const h = { __name: name };
      definedQueries.set(h, name);
      return h;
    }) as unknown as typeof import("@temporalio/workflow").defineQuery,
    setHandler: ((handle: unknown, handler: (...args: unknown[]) => unknown) => {
      const signalName = definedSignals.get(handle);
      if (signalName) {
        harness.signalHandlersByName.set(signalName, handler as SignalHandler);
        return;
      }
      const queryName = definedQueries.get(handle);
      if (queryName) {
        harness.queryHandlersByName.set(queryName, handler as QueryHandler);
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

function sampleRun(): WorkflowRunRecord {
  return {
    schema_version: "tychonic.run.v1",
    id: "run_cp_int",
    template: "checkpoint",
    status: "running",
    cwd: "/ignored",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    states: [],
    activity_attempts: [],
    agent_sessions: [],
    artifacts: [],
    findings: [],
    inbox: []
  };
}

function interactiveProfile(cap?: number): TychonicConfig {
  return {
    version: "tychonic.config.v1",
    policies: {
      interaction: cap === undefined ? { mode: "interactive" } : { mode: "interactive", max_reject_iterations: cap }
    }
  };
}

describe("checkpointWorkflow interactive gate", () => {
  let harness: Harness;

  beforeEach(() => {
    __resetInteractionHookState();
    harness = installHarness();
  });

  afterEach(() => {
    __setInteractionHookHarness(undefined);
    __resetInteractionHookState();
  });

  it("auto mode returns immediately without waiting on any signal", async () => {
    registerInteractionSignals();
    setInteractionPolicy(undefined);
    const run = sampleRun();
    const profile: TychonicConfig = { version: "tychonic.config.v1" };
    const rejectCounts = new Map<string, number>();
    let callCount = 0;
    const next = await gateDecisionForCheckpoint(
      run,
      "lint",
      rejectCounts,
      profile,
      () => "2026-01-01T00:00:00Z",
      async (r, _feedback) => {
        callCount += 1;
        return r;
      }
    );
    expect(next).toBe(run);
    expect(callCount).toBe(0); // approve without re-running
    expect(rejectCounts.size).toBe(0);
    expect(effectiveInteractionMode()).toBe("auto");
  });

  it("interactive approve returns the run unchanged", async () => {
    registerInteractionSignals();
    setInteractionPolicy({ mode: "interactive" });
    const run = sampleRun();
    const profile = interactiveProfile();
    const rejectCounts = new Map<string, number>();
    const pending = gateDecisionForCheckpoint(
      run,
      "lint",
      rejectCounts,
      profile,
      () => "2026-01-01T00:00:00Z",
      async (r) => r
    );
    dispatch(harness, interactionApproveStateSignalName, { state: "lint" });
    await expect(pending).resolves.toBe(run);
  });

  it("interactive modify overlays the latest matching state record via patch", async () => {
    registerInteractionSignals();
    setInteractionPolicy({ mode: "interactive" });
    const run = sampleRun();
    run.states = [
      {
        id: "state_lint_1",
        name: "lint",
        status: "succeeded",
        reason: "",
        activity_attempt_ids: [],
        artifact_ids: [],
        finding_ids: []
      }
    ];
    const profile = interactiveProfile();
    const rejectCounts = new Map<string, number>();
    const pending = gateDecisionForCheckpoint(
      run,
      "lint",
      rejectCounts,
      profile,
      () => "2026-01-01T00:00:00Z",
      async (r) => r
    );
    dispatch(harness, interactionModifyStateSignalName, {
      state: "lint",
      patch: { status: "failed", reason: "external override" }
    });
    const next = await pending;
    expect(next.states[0]?.id).toBe("state_lint_1");
    expect(next.states[0]?.status).toBe("failed");
    expect(next.states[0]?.reason).toBe("external override");
  });

  it("interactive reject re-runs the activity until approve", async () => {
    registerInteractionSignals();
    setInteractionPolicy({ mode: "interactive" });
    const baseRun = sampleRun();
    const profile = interactiveProfile();
    const rejectCounts = new Map<string, number>();
    let rerunCount = 0;
    const rerun = async (r: WorkflowRunRecord, feedback?: string): Promise<WorkflowRunRecord> => {
      rerunCount += 1;
      return {
        ...r,
        summary: `rerun=${rerunCount} feedback=${feedback ?? ""}`
      };
    };
    const pending = gateDecisionForCheckpoint(
      baseRun,
      "lint",
      rejectCounts,
      profile,
      () => "2026-01-01T00:00:00Z",
      rerun
    );
    dispatch(harness, interactionRejectStateSignalName, { state: "lint", feedback: "needs more" });
    // After reject, gate re-runs activity, then waits again for a decision.
    // Dispatch an approve to end the loop.
    dispatch(harness, interactionApproveStateSignalName, { state: "lint" });
    const next = await pending;
    expect(rerunCount).toBe(1);
    expect(next.summary).toBe("rerun=1 feedback=needs more");
    expect(rejectCounts.get("lint")).toBe(1);
  });

  it("reject cap promotes the run to waiting_user with an inbox item", async () => {
    registerInteractionSignals();
    setInteractionPolicy({ mode: "interactive", max_reject_iterations: 2 });
    const baseRun = sampleRun();
    const profile = interactiveProfile(2);
    const rejectCounts = new Map<string, number>();
    const rerun = async (r: WorkflowRunRecord, _feedback?: string): Promise<WorkflowRunRecord> => r;
    const pending = gateDecisionForCheckpoint(
      baseRun,
      "lint",
      rejectCounts,
      profile,
      () => "2026-01-01T00:00:00Z",
      rerun
    );
    dispatch(harness, interactionRejectStateSignalName, { state: "lint", feedback: "nope" });
    dispatch(harness, interactionRejectStateSignalName, { state: "lint", feedback: "still nope" });
    const next = await pending;
    expect(rejectCounts.get("lint")).toBe(2);
    expect(next.inbox).toHaveLength(1);
    expect(next.inbox[0]?.title).toBe("Interactive reject limit reached");
    // SPEC §Interactive mode — cap must transition run.status to
    // "waiting_user" so subsequent pipeline stages can short-circuit.
    expect(next.status).toBe("waiting_user");
  });
});
