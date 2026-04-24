import type { WorkflowRunRecord, WorkflowRunStatus } from "../domain/types.js";
import type { ActivityResult } from "../temporal/types.js";

export interface FinalizeRunActivityInput {
  run: WorkflowRunRecord;
  summary?: string;
}

export type FinalizeRunActivityResult = ActivityResult;

/**
 * Computes the terminal `run.status` from the existing state and inbox
 * state without mutating `input.run`. Returns a `WorkflowRunDelta` with
 * `status` (and optionally `summary`) for the caller to merge via
 * `applyRunDelta`.
 *
 * Mirrors `src/domain/inbox.ts` `recomputeWorkflowRunStatus`:
 * - any latest state-by-NAME in `failed` or `timed_out` → `failed`
 * - otherwise any open inbox item → `waiting_user`
 * - otherwise → `succeeded`
 */
export async function finalizeRunActivity(
  input: FinalizeRunActivityInput
): Promise<FinalizeRunActivityResult> {
  const status: WorkflowRunStatus = computeStatus(input.run);
  const delta: ActivityResult["delta"] = { status };
  if (input.summary !== undefined) {
    delta.summary = input.summary;
  }
  return { delta };
}

function computeStatus(run: WorkflowRunRecord): WorkflowRunStatus {
  if (latestStatesByName(run).some((state) => state.status === "failed" || state.status === "timed_out")) {
    return "failed";
  }
  if (run.inbox.some((item) => item.status === "open")) {
    return "waiting_user";
  }
  return "succeeded";
}

function latestStatesByName(run: WorkflowRunRecord): WorkflowRunRecord["states"] {
  const latest = new Map<string, WorkflowRunRecord["states"][number]>();
  for (const state of run.states) {
    latest.set(state.name, state);
  }
  return [...latest.values()];
}
