import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gateState } from "../src/workflows/simpleWorkflow.js";
import {
  __resetInteractionHookState,
  __setInteractionHookHarness,
  effectiveInteractionMode,
  registerInteractionSignals,
  setInteractionPolicy
} from "../src/workflows/interactionHook.js";
import {
  interactionApproveStateSignalName,
  interactionModifyStateSignalName,
  interactionRejectStateSignalName
} from "../src/temporal/types.js";
import type { TychonicConfig } from "../src/catalog/types.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";

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

function baseRun(): WorkflowRunRecord {
  return {
    schema_version: "tychonic.run.v1",
    id: "run_sw_int",
    template: "simple_workflow",
    status: "running",
    cwd: "/repo",
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
      interaction:
        cap === undefined ? { mode: "interactive" } : { mode: "interactive", max_reject_iterations: cap }
    }
  };
}

describe("simpleWorkflow interactive gateState", () => {
  let harness: Harness;

  beforeEach(() => {
    __resetInteractionHookState();
    harness = installHarness();
  });

  afterEach(() => {
    __setInteractionHookHarness(undefined);
    __resetInteractionHookState();
  });

  it("auto mode runs the activity exactly once with no signal wait", async () => {
    registerInteractionSignals();
    setInteractionPolicy(undefined);
    const run = baseRun();
    let runs = 0;
    const result = await gateState({
      stateName: "work",
      run,
      profile: { version: "tychonic.config.v1" },
      rejectCounts: new Map(),
      runActivity: async (r, _f) => {
        runs += 1;
        return r;
      }
    });
    expect(result).toBe(run);
    expect(runs).toBe(1);
    expect(effectiveInteractionMode()).toBe("auto");
    expect(harness.conditionCalls).toHaveLength(0);
  });

  it("interactive approve runs the activity once and returns the run unchanged", async () => {
    registerInteractionSignals();
    setInteractionPolicy({ mode: "interactive" });
    const run = baseRun();
    let runs = 0;
    const pending = gateState({
      stateName: "work",
      run,
      profile: interactiveProfile(),
      rejectCounts: new Map(),
      runActivity: async (r, _f) => {
        runs += 1;
        return r;
      }
    });
    await flushMicrotasks();
    dispatch(harness, interactionApproveStateSignalName, { state: "work" });
    const result = await pending;
    expect(result).toBe(run);
    expect(runs).toBe(1);
  });

  it("interactive modify overlays the latest state record via patch", async () => {
    registerInteractionSignals();
    setInteractionPolicy({ mode: "interactive" });
    const run: WorkflowRunRecord = {
      ...baseRun(),
      states: [
        {
          id: "s1",
          name: "work",
          status: "succeeded",
          reason: "",
          activity_attempt_ids: [],
          artifact_ids: [],
          finding_ids: []
        }
      ]
    };
    const pending = gateState({
      stateName: "work",
      run,
      profile: interactiveProfile(),
      rejectCounts: new Map(),
      runActivity: async (r, _f) => r
    });
    await flushMicrotasks();
    dispatch(harness, interactionModifyStateSignalName, {
      state: "work",
      patch: { status: "failed", reason: "external override" }
    });
    const result = await pending;
    expect(result.states[0]?.id).toBe("s1");
    expect(result.states[0]?.status).toBe("failed");
    expect(result.states[0]?.reason).toBe("external override");
  });

  it("interactive reject re-runs the activity until approve", async () => {
    registerInteractionSignals();
    setInteractionPolicy({ mode: "interactive" });
    const run = baseRun();
    const rejectCounts = new Map<string, number>();
    let runs = 0;
    const feedbacks: (string | undefined)[] = [];
    const pending = gateState({
      stateName: "work",
      run,
      profile: interactiveProfile(),
      rejectCounts,
      runActivity: async (r, f) => {
        runs += 1;
        feedbacks.push(f);
        return r;
      }
    });
    await flushMicrotasks();
    dispatch(harness, interactionRejectStateSignalName, {
      state: "work",
      feedback: "try harder"
    });
    await flushMicrotasks();
    dispatch(harness, interactionApproveStateSignalName, { state: "work" });
    const result = await pending;
    expect(result).toBe(run);
    expect(runs).toBe(2); // initial + reject-triggered re-run
    expect(feedbacks).toEqual([undefined, "try harder"]);
    expect(rejectCounts.get("work")).toBe(1);
  });

  it("reject cap appends an inbox item and stops re-running", async () => {
    registerInteractionSignals();
    setInteractionPolicy({ mode: "interactive", max_reject_iterations: 2 });
    const run = baseRun();
    const rejectCounts = new Map<string, number>();
    let runs = 0;
    const pending = gateState({
      stateName: "work",
      run,
      profile: interactiveProfile(2),
      rejectCounts,
      runActivity: async (r, _f) => {
        runs += 1;
        return r;
      }
    });
    await flushMicrotasks();
    dispatch(harness, interactionRejectStateSignalName, {
      state: "work",
      feedback: "no"
    });
    await flushMicrotasks();
    dispatch(harness, interactionRejectStateSignalName, {
      state: "work",
      feedback: "still no"
    });
    const result = await pending;
    expect(rejectCounts.get("work")).toBe(2);
    expect(result.inbox).toHaveLength(1);
    expect(result.inbox[0]?.title).toBe("Interactive reject limit reached");
    // initial activity run + one re-run before cap = 2 total runs
    expect(runs).toBe(2);
    // SPEC §Interactive mode — cap promotes the run to waiting_user so
    // subsequent states in runSimpleWorkflowInteractive short-circuit.
    expect(result.status).toBe("waiting_user");
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
