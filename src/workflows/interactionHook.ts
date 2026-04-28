import {
  condition,
  defineQuery,
  defineSignal,
  setHandler
} from "@temporalio/workflow";
import { INTERACTION_DEFAULT_MAX_REJECT_ITERATIONS } from "./interactionDefaults.js";
import type { DecisionInboxItemRecord, WorkflowRunRecord } from "../domain/types.js";

/**
 * Workflow-runtime shape of a `policies.interaction` block as consumed by
 * this hook. The host config schema treats `policies` as opaque; each
 * workflow validates the keys it reads at workflow start. This local
 * type captures the fields the hook itself depends on.
 */
export interface PolicyInteraction {
  mode: "auto" | "interactive";
  max_reject_iterations?: number;
}
import {
  interactionApproveStateSignalName,
  interactionModifyStateSignalName,
  interactionPendingStateQueryName,
  interactionRejectStateSignalName,
  type InteractionApproveStatePayload,
  type InteractionModifyStatePayload,
  type InteractionRejectStatePayload,
  type StateRecordPatch
} from "../temporal/types.js";
import { applyModifyStateDecision } from "./runMerge.js";

export type ApprovalDecision =
  | { kind: "approve" }
  | { kind: "reject"; feedback: string }
  | { kind: "modify"; patch: StateRecordPatch };

export interface StraySignal {
  kind: "approve" | "reject" | "modify";
  state: string;
  payload: InteractionApproveStatePayload | InteractionRejectStatePayload | InteractionModifyStatePayload;
}

/**
 * Minimal facade over `@temporalio/workflow` helpers the unit tests can
 * substitute for a plain injector (no Temporal runtime required).
 *
 * The workflow bundle imports the production implementation from
 * `@temporalio/workflow`. Unit tests override these helpers through
 * `__setInteractionHookHarness` so the helper logic can be exercised
 * without starting a worker.
 */
interface InteractionHarness {
  defineSignal: typeof defineSignal;
  defineQuery: typeof defineQuery;
  setHandler: typeof setHandler;
  condition: typeof condition;
}

let harness: InteractionHarness = {
  defineSignal,
  defineQuery,
  setHandler,
  condition
};

/**
 * Test-only: swap the Temporal runtime facade for an injected harness.
 * Production workflows must not call this; it is exposed solely for
 * `test/interactionHook.test.ts` to drive the helper without a worker.
 */
export function __setInteractionHookHarness(next: Partial<InteractionHarness> | undefined): void {
  if (!next) {
    harness = { defineSignal, defineQuery, setHandler, condition };
    return;
  }
  harness = {
    defineSignal: next.defineSignal ?? defineSignal,
    defineQuery: next.defineQuery ?? defineQuery,
    setHandler: next.setHandler ?? setHandler,
    condition: next.condition ?? condition
  };
}

// Module-local state. Each workflow run gets its own workflow VM in
// Temporal, which re-creates this module per run, so module-level state
// is safe to use as per-run state.
let policyCache: { resolved: boolean; mode: "auto" | "interactive"; policy: PolicyInteraction | undefined } = {
  resolved: false,
  mode: "auto",
  policy: undefined
};

interface QueuedApprove {
  kind: "approve";
  payload: InteractionApproveStatePayload;
}
interface QueuedReject {
  kind: "reject";
  payload: InteractionRejectStatePayload;
}
interface QueuedModify {
  kind: "modify";
  payload: InteractionModifyStatePayload;
}
type QueuedInteraction = QueuedApprove | QueuedReject | QueuedModify;

/**
 * Single FIFO queue across all three interaction kinds. The queue
 * preserves signal arrival order so two rejects received before an
 * approve are consumed reject-first (matching the operator's intent
 * when they dispatched them in sequence).
 */
const signalQueue: QueuedInteraction[] = [];

let pendingStateName: string | undefined;
let signalsRegistered = false;
let queryRegistered = false;

/**
 * Reset all module-local state. Unit tests call this between cases.
 * Production workflows never call it — each run starts with a fresh
 * workflow VM, which already starts with fresh module state.
 */
export function __resetInteractionHookState(): void {
  policyCache = { resolved: false, mode: "auto", policy: undefined };
  signalQueue.length = 0;
  pendingStateName = undefined;
  signalsRegistered = false;
  queryRegistered = false;
}

/**
 * Register the three interaction signal handlers and the
 * pending-state query. Each product workflow calls this once at
 * workflow start, before its first `await`, so Temporal-buffered
 * signals that arrived before the workflow reached its first task are
 * attached to our queues on replay (see R-07). Calling it twice is a
 * no-op.
 */
export function registerInteractionSignals(): void {
  if (signalsRegistered) {
    return;
  }
  signalsRegistered = true;

  const approveSignal = harness.defineSignal<[InteractionApproveStatePayload]>(interactionApproveStateSignalName);
  const rejectSignal = harness.defineSignal<[InteractionRejectStatePayload]>(interactionRejectStateSignalName);
  const modifySignal = harness.defineSignal<[InteractionModifyStatePayload]>(interactionModifyStateSignalName);

  harness.setHandler(approveSignal, (payload: InteractionApproveStatePayload) => {
    signalQueue.push({ kind: "approve", payload });
  });
  harness.setHandler(rejectSignal, (payload: InteractionRejectStatePayload) => {
    signalQueue.push({ kind: "reject", payload });
  });
  harness.setHandler(modifySignal, (payload: InteractionModifyStatePayload) => {
    signalQueue.push({ kind: "modify", payload });
  });

  if (!queryRegistered) {
    queryRegistered = true;
    const pendingQuery = harness.defineQuery<string | undefined>(interactionPendingStateQueryName);
    harness.setHandler(pendingQuery, () => pendingStateName);
  }
}

/**
 * Cache the start-time interaction policy. Called once per workflow
 * run. Absent block → auto. Overwriting an already-resolved cache is a
 * bug (the policy is immutable per SPEC §Configuration Model →
 * Immutability) so this throws to catch mis-wiring in tests.
 */
export function setInteractionPolicy(policy: PolicyInteraction | undefined): void {
  if (policyCache.resolved) {
    throw new Error(
      "setInteractionPolicy was called twice; interaction policy is fixed at workflow start"
    );
  }
  policyCache = {
    resolved: true,
    mode: policy?.mode ?? "auto",
    policy
  };
}

/**
 * Resolve the currently-cached mode. Auto when no policy was set
 * (covers both workflows that never registered and the absent-block
 * case).
 */
export function effectiveInteractionMode(): "auto" | "interactive" {
  return policyCache.mode;
}

/**
 * Resolve the reject cap for the current policy. Falls back to the
 * documented default of 5 when mode is interactive and the policy did
 * not set a cap explicitly. Auto mode callers must not consult this
 * value; the function returns `Infinity` in that case to make
 * accidental use inert.
 */
export function resolveRejectCap(): number {
  if (policyCache.mode !== "interactive") {
    return Number.POSITIVE_INFINITY;
  }
  return policyCache.policy?.max_reject_iterations ?? INTERACTION_DEFAULT_MAX_REJECT_ITERATIONS;
}

function hasQueuedSignalFor(stateName: string): boolean {
  return signalQueue.some((entry) => entry.payload.state === stateName);
}

function takeQueuedDecision(stateName: string): ApprovalDecision | undefined {
  const index = signalQueue.findIndex((entry) => entry.payload.state === stateName);
  if (index < 0) {
    return undefined;
  }
  const [entry] = signalQueue.splice(index, 1);
  if (!entry) {
    return undefined;
  }
  if (entry.kind === "approve") {
    return { kind: "approve" };
  }
  if (entry.kind === "reject") {
    const feedback = entry.payload.feedback;
    if (!feedback || feedback.length === 0) {
      throw new Error(
        `rejectState for '${stateName}' carried an empty feedback string; the sender must supply non-empty feedback`
      );
    }
    return { kind: "reject", feedback };
  }
  return { kind: "modify", patch: entry.payload.patch };
}

/**
 * Workflow-level gate: returns an `ApprovalDecision` describing what
 * the external caller asked the workflow to do with the state the
 * activity just finished.
 *
 * - Auto mode resolves to `{ kind: "approve" }` immediately with no
 *   signal wait, no Temporal timer, and no history event.
 * - Interactive mode suspends on `condition()` until one of the three
 *   interaction signals arrives whose `state` matches `stateName`.
 *   Signals targeting a different state name stay on their queue for
 *   the hook call that matches them; stray signals are surfaced
 *   through `drainStraySignals()` at workflow finalize.
 */
export async function waitForStateApproval(stateName: string): Promise<ApprovalDecision> {
  if (policyCache.mode === "auto") {
    return { kind: "approve" };
  }

  pendingStateName = stateName;
  try {
    const queued = takeQueuedDecision(stateName);
    if (queued) {
      return queued;
    }
    await harness.condition(() => hasQueuedSignalFor(stateName));
    const decision = takeQueuedDecision(stateName);
    if (!decision) {
      throw new Error(
        `waitForStateApproval('${stateName}') woke without a queued decision; this is an internal bug`
      );
    }
    return decision;
  } finally {
    pendingStateName = undefined;
  }
}

/**
 * Drain every signal that is still queued when the workflow finalizes.
 * Returns one `StraySignal` entry per queued payload. Callers convert
 * them into inbox items so a typo-signal never causes a silent hang
 * (R-03 mitigation).
 */
export function drainStraySignals(): StraySignal[] {
  const strays: StraySignal[] = signalQueue.map((entry) => ({
    kind: entry.kind,
    state: entry.payload.state,
    payload: entry.payload
  }));
  signalQueue.length = 0;
  return strays;
}

/**
 * Apply an `ApprovalDecision` to the run. Approve is a no-op.
 * Modify replaces the latest state record for `stateName` in
 * `run.states` via `applyModifyStateDecision`. Reject does not mutate
 * `run` here; the workflow caller implements the reject-retry branch
 * (re-run the activity with feedback, bump the per-state counter).
 */
export function applyApprovalDecision(
  run: WorkflowRunRecord,
  stateName: string,
  decision: ApprovalDecision
): WorkflowRunRecord {
  switch (decision.kind) {
    case "approve":
      return run;
    case "modify":
      return applyModifyStateDecision(run, stateName, decision.patch);
    case "reject":
      return run;
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
}

/**
 * Build the `waiting_user` inbox item that `waitForStateApproval`
 * callers attach when a state reaches `max_reject_iterations` (R-05).
 */
export function rejectCapInboxItem(
  stateName: string,
  options: { createdAt: string; id: string; detail?: string }
): DecisionInboxItemRecord {
  return {
    id: options.id,
    status: "open",
    title: "Interactive reject limit reached",
    detail:
      options.detail ??
      `state '${stateName}' reached the interactive reject iteration cap; inspect artifacts and start a fresh run with adjusted input/config`,
    action: { kind: "triage", reason: `interactive reject cap for state '${stateName}'` },
    created_at: options.createdAt
  };
}

/**
 * Build an inbox item describing a stray interaction signal. Callers
 * push the result onto `run.inbox` during workflow finalize.
 */
export function strayInteractionSignalInboxItem(
  signal: StraySignal,
  options: { createdAt: string; id: string }
): DecisionInboxItemRecord {
  const detail = JSON.stringify(signal.payload);
  return {
    id: options.id,
    status: "open",
    title: "Stray interaction signal",
    detail: `kind=${signal.kind} state=${signal.state} payload=${detail}`,
    action: { kind: "triage", reason: `stray ${signal.kind} signal for state '${signal.state}'` },
    created_at: options.createdAt
  };
}

/**
 * True when the reject counter has reached the configured cap. Callers
 * pass the per-workflow counter map they maintain between hook calls.
 */
export function isRejectCapReached(
  counts: Map<string, number>,
  stateName: string,
  policy: PolicyInteraction | undefined
): boolean {
  if (policy?.mode !== "interactive") {
    return false;
  }
  const cap = policy.max_reject_iterations ?? INTERACTION_DEFAULT_MAX_REJECT_ITERATIONS;
  return (counts.get(stateName) ?? 0) >= cap;
}
