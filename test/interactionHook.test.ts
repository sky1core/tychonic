import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowStateRecord } from "../src/domain/types.js";
import {
  __resetInteractionHookState,
  __setInteractionHookHarness,
  applyApprovalDecision,
  drainStraySignals,
  effectiveInteractionMode,
  isRejectCapReached,
  registerInteractionSignals,
  rejectCapInboxItem,
  resolveRejectCap,
  setInteractionPolicy,
  strayInteractionSignalInboxItem,
  waitForStateApproval
} from "../src/workflows/interactionHook.js";
import {
  interactionApproveStateSignalName,
  interactionModifyStateSignalName,
  interactionPendingStateQueryName,
  interactionRejectStateSignalName,
  type InteractionApproveStatePayload,
  type InteractionModifyStatePayload,
  type InteractionRejectStatePayload
} from "../src/temporal/types.js";
import { createTychonicInteraction } from "../src/workflow.js";

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
      const handle = { __name: name };
      definedSignals.set(handle, name);
      return handle;
    }) as unknown as typeof import("@temporalio/workflow").defineSignal,
    defineQuery: ((name: string) => {
      const handle = { __name: name };
      definedQueries.set(handle, name);
      return handle;
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
        return;
      }
      throw new Error("unknown signal/query handle");
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

function dispatchSignal(
  harness: Harness,
  signalName: string,
  payload: unknown
): void {
  const handler = harness.signalHandlersByName.get(signalName);
  if (!handler) {
    throw new Error(`no handler registered for signal ${signalName}`);
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

function runQuery(harness: Harness, queryName: string): unknown {
  const handler = harness.queryHandlersByName.get(queryName);
  if (!handler) {
    throw new Error(`no handler for query ${queryName}`);
  }
  return handler();
}

describe("interactionHook", () => {
  let harness: Harness;

  beforeEach(() => {
    __resetInteractionHookState();
    harness = installHarness();
  });

  afterEach(() => {
    __setInteractionHookHarness(undefined);
    __resetInteractionHookState();
  });

  describe("effectiveInteractionMode / setInteractionPolicy", () => {
    it("defaults to 'auto' when the policy is undefined", () => {
      setInteractionPolicy(undefined);
      expect(effectiveInteractionMode()).toBe("auto");
    });

    it("caches interactive mode from the supplied policy", () => {
      setInteractionPolicy({ mode: "interactive" });
      expect(effectiveInteractionMode()).toBe("interactive");
    });

    it("throws if set twice (policy is immutable per run)", () => {
      setInteractionPolicy({ mode: "interactive" });
      expect(() => setInteractionPolicy({ mode: "auto" })).toThrow();
    });

    it("reports Infinity reject cap when mode is auto", () => {
      setInteractionPolicy({ mode: "auto" });
      expect(resolveRejectCap()).toBe(Number.POSITIVE_INFINITY);
    });

    it("reports documented default 5 when interactive and no cap provided", () => {
      setInteractionPolicy({ mode: "interactive" });
      expect(resolveRejectCap()).toBe(5);
    });

    it("respects an explicit max_reject_iterations", () => {
      setInteractionPolicy({ mode: "interactive", max_reject_iterations: 2 });
      expect(resolveRejectCap()).toBe(2);
    });
  });

  describe("createTychonicInteraction", () => {
    it("registers the standard interaction surface as one workflow helper", async () => {
      const interaction = createTychonicInteraction({ mode: "interactive", max_reject_iterations: 2 });
      expect(interaction.mode()).toBe("interactive");
      expect(interaction.rejectCap()).toBe(2);
      expect(harness.signalHandlersByName.has(interactionApproveStateSignalName)).toBe(true);
      expect(harness.signalHandlersByName.has(interactionRejectStateSignalName)).toBe(true);
      expect(harness.signalHandlersByName.has(interactionModifyStateSignalName)).toBe(true);
      expect(harness.queryHandlersByName.has(interactionPendingStateQueryName)).toBe(true);

      const pending = interaction.waitForStateApproval("qa");
      dispatchSignal(harness, interactionApproveStateSignalName, { state: "qa" });
      await expect(pending).resolves.toEqual({ kind: "approve" });
    });
  });

  describe("waitForStateApproval", () => {
    it("returns approve immediately under auto mode without touching signal queues", async () => {
      registerInteractionSignals();
      setInteractionPolicy({ mode: "auto" });
      const decision = await waitForStateApproval("work");
      expect(decision).toEqual({ kind: "approve" });
    });

    it("rejects an empty workflow-owned state name before waiting", async () => {
      registerInteractionSignals();
      setInteractionPolicy({ mode: "interactive" });
      await expect(waitForStateApproval("")).rejects.toThrow(/stateName must be a non-empty string/);
    });

    it("suspends until an approveState signal arrives in interactive mode", async () => {
      registerInteractionSignals();
      setInteractionPolicy({ mode: "interactive" });
      const pending = waitForStateApproval("work");
      // pending state query exposes the awaited state name while suspended
      expect(runQuery(harness, interactionPendingStateQueryName)).toBe("work");
      dispatchSignal(harness, interactionApproveStateSignalName, { state: "work" } satisfies InteractionApproveStatePayload);
      await expect(pending).resolves.toEqual({ kind: "approve" });
      expect(runQuery(harness, interactionPendingStateQueryName)).toBeUndefined();
    });

    it("resolves with reject when a rejectState signal arrives", async () => {
      registerInteractionSignals();
      setInteractionPolicy({ mode: "interactive" });
      const pending = waitForStateApproval("work");
      dispatchSignal(harness, interactionRejectStateSignalName, {
        state: "work",
        feedback: "needs tests"
      } satisfies InteractionRejectStatePayload);
      await expect(pending).resolves.toEqual({ kind: "reject", feedback: "needs tests" });
    });

    it("resolves with modify when a modifyState signal arrives", async () => {
      registerInteractionSignals();
      setInteractionPolicy({ mode: "interactive" });
      const patch = { status: "failed" as const, reason: "external override" };
      const pending = waitForStateApproval("work");
      dispatchSignal(harness, interactionModifyStateSignalName, {
        state: "work",
        patch
      } satisfies InteractionModifyStatePayload);
      await expect(pending).resolves.toEqual({ kind: "modify", patch });
    });

    it("parks cross-name signals until the matching hook call runs", async () => {
      registerInteractionSignals();
      setInteractionPolicy({ mode: "interactive" });
      // Signal for 'verify' arrives first, but we are awaiting 'work'.
      dispatchSignal(harness, interactionApproveStateSignalName, { state: "verify" } satisfies InteractionApproveStatePayload);
      const workPending = waitForStateApproval("work");
      // The verify signal must not satisfy work's wait.
      let resolvedWork = false;
      workPending.then(() => {
        resolvedWork = true;
      });
      await flushMicrotasks();
      expect(resolvedWork).toBe(false);
      // Dispatch the matching 'work' approval.
      dispatchSignal(harness, interactionApproveStateSignalName, { state: "work" } satisfies InteractionApproveStatePayload);
      await expect(workPending).resolves.toEqual({ kind: "approve" });
      // The 'verify' signal stayed queued and is consumed by the later hook.
      const verifyPending = waitForStateApproval("verify");
      await expect(verifyPending).resolves.toEqual({ kind: "approve" });
    });

    it("keeps an invalid reject payload from satisfying the approval gate", async () => {
      registerInteractionSignals();
      setInteractionPolicy({ mode: "interactive" });
      const pending = waitForStateApproval("work");
      let resolved = false;
      pending.then(() => {
        resolved = true;
      });
      dispatchSignal(harness, interactionRejectStateSignalName, {
        state: "work",
        feedback: ""
      });
      await flushMicrotasks();
      expect(resolved).toBe(false);
      expect(drainStraySignals()).toMatchObject([
        {
          kind: "invalid",
          state: "<invalid>",
          reason: "reject payload feedback must be a non-empty string"
        }
      ]);
      dispatchSignal(harness, interactionApproveStateSignalName, { state: "work" } satisfies InteractionApproveStatePayload);
      await expect(pending).resolves.toEqual({ kind: "approve" });
    });

    it("keeps an invalid modify payload from satisfying the approval gate", async () => {
      registerInteractionSignals();
      setInteractionPolicy({ mode: "interactive" });
      const pending = waitForStateApproval("work");
      dispatchSignal(harness, interactionModifyStateSignalName, {
        state: "work"
      });
      await flushMicrotasks();
      expect(drainStraySignals()).toMatchObject([
        {
          kind: "invalid",
          state: "<invalid>",
          reason: "modify payload patch must be an object"
        }
      ]);
      dispatchSignal(harness, interactionApproveStateSignalName, { state: "work" } satisfies InteractionApproveStatePayload);
      await expect(pending).resolves.toEqual({ kind: "approve" });
    });

    it("consumes signals buffered before the workflow reached the hook (R-07)", async () => {
      registerInteractionSignals();
      setInteractionPolicy({ mode: "interactive" });
      // Signal arrives while no hook is pending. This simulates
      // Temporal's pre-registration buffering behavior.
      dispatchSignal(harness, interactionApproveStateSignalName, { state: "work" } satisfies InteractionApproveStatePayload);
      await expect(waitForStateApproval("work")).resolves.toEqual({ kind: "approve" });
    });
  });

  describe("drainStraySignals", () => {
    it("emits one StraySignal per queued payload and empties every queue", () => {
      registerInteractionSignals();
      setInteractionPolicy({ mode: "interactive" });
      dispatchSignal(harness, interactionApproveStateSignalName, { state: "typo1" });
      dispatchSignal(harness, interactionRejectStateSignalName, {
        state: "typo2",
        feedback: "x"
      });
      dispatchSignal(harness, interactionModifyStateSignalName, {
        state: "typo3",
        patch: { status: "succeeded" }
      });
      dispatchSignal(harness, interactionApproveStateSignalName, {});
      const strays = drainStraySignals();
      expect(strays.map((item) => item.kind)).toEqual(["approve", "reject", "modify", "invalid"]);
      expect(strays.map((item) => item.state)).toEqual(["typo1", "typo2", "typo3", "<invalid>"]);
      // Subsequent call returns empty — queues were drained.
      expect(drainStraySignals()).toEqual([]);
    });
  });

  describe("applyApprovalDecision", () => {
    it("returns the run unchanged for approve", () => {
      const run = {
        schema_version: "tychonic.run.v1" as const,
        id: "run_apply",
        template: "t",
        status: "running" as const,
        cwd: "/c",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        states: [
          {
            id: "s1",
            name: "work",
            status: "succeeded" as const,
            reason: "",
            activity_attempt_ids: [],
            artifact_ids: [],
            finding_ids: []
          }
        ],
        activity_attempts: [],
        agent_sessions: [],
        artifacts: [],
        findings: [],
        inbox: []
      };
      expect(applyApprovalDecision(run, "work", { kind: "approve" })).toBe(run);
    });

    it("returns the run unchanged for reject (workflow handles retry)", () => {
      const run = {
        schema_version: "tychonic.run.v1" as const,
        id: "run_apply_reject",
        template: "t",
        status: "running" as const,
        cwd: "/c",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        states: [],
        activity_attempts: [],
        agent_sessions: [],
        artifacts: [],
        findings: [],
        inbox: []
      };
      expect(applyApprovalDecision(run, "work", { kind: "reject", feedback: "x" })).toBe(run);
    });

    it("replaces the latest state record for modify", () => {
      const run = {
        schema_version: "tychonic.run.v1" as const,
        id: "run_apply_modify",
        template: "t",
        status: "running" as const,
        cwd: "/c",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        states: [
          {
            id: "s1",
            name: "work",
            status: "succeeded" as const,
            reason: "",
            activity_attempt_ids: [],
            artifact_ids: [],
            finding_ids: []
          }
        ],
        activity_attempts: [],
        agent_sessions: [],
        artifacts: [],
        findings: [],
        inbox: []
      };
      const next = applyApprovalDecision(run, "work", {
        kind: "modify",
        patch: { status: "failed", reason: "external reject" }
      });
      expect(next.states[0]?.id).toBe("s1"); // id preserved, status overlaid
      expect(next.states[0]?.status).toBe("failed");
      expect(next.states[0]?.reason).toBe("external reject");
    });
  });

  describe("isRejectCapReached", () => {
    it("returns false when policy is not interactive", () => {
      const counts = new Map<string, number>([["work", 100]]);
      expect(isRejectCapReached(counts, "work", { mode: "auto" })).toBe(false);
    });

    it("returns false while the count is below the cap", () => {
      const counts = new Map<string, number>([["work", 2]]);
      expect(
        isRejectCapReached(counts, "work", { mode: "interactive", max_reject_iterations: 3 })
      ).toBe(false);
    });

    it("returns true when the count reaches the cap", () => {
      const counts = new Map<string, number>([["work", 3]]);
      expect(
        isRejectCapReached(counts, "work", { mode: "interactive", max_reject_iterations: 3 })
      ).toBe(true);
    });

    it("uses the default cap of 5 when no explicit cap is set", () => {
      const counts = new Map<string, number>([["work", 5]]);
      expect(isRejectCapReached(counts, "work", { mode: "interactive" })).toBe(true);
    });
  });

  describe("inbox item helpers", () => {
    it("rejectCapInboxItem has a stable title", () => {
      const item = rejectCapInboxItem("work", {
        createdAt: "2026-01-01T00:00:00Z",
        id: "inbox_rej"
      });
      expect(item.title).toBe("Interactive reject limit reached");
      expect(item.action.kind).toBe("triage");
    });

    it("strayInteractionSignalInboxItem reports kind/state", () => {
      const item = strayInteractionSignalInboxItem(
        {
          kind: "approve",
          state: "typo",
          payload: { state: "typo" }
        },
        { createdAt: "2026-01-01T00:00:00Z", id: "inbox_stray" }
      );
      expect(item.title).toBe("Stray interaction signal");
      expect(item.detail).toContain("typo");
      expect(item.detail).toContain("approve");
    });
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
