import { applyRunDelta } from "../domain/runDelta.js";
import type {
  DecisionInboxItemRecord,
  WorkflowRunRecord,
  WorkflowStateRecord,
  WorkflowStateStatus
} from "../domain/types.js";
import type { ActivityResult, StateRecordPatch } from "../temporal/types.js";

const TERMINAL_STATE_STATUSES: readonly WorkflowStateStatus[] = [
  "succeeded",
  "failed",
  "skipped",
  "blocked",
  "timed_out"
] as const;

/**
 * Pure helpers workflow code uses to merge activity results into its local
 * `WorkflowRunRecord`. None of these mutates the input record.
 *
 * An activity call returns:
 * - `result.delta` — changes to `states`, `activity_attempts`, `facts`,
 *   `status`, `summary` (merged by `applyRunDelta`).
 * - `result.reviewOutcome`, `result.commandOutcome`, `result.workerOutcome`
 *   — TYPE-specific payloads carrying `ArtifactRecord` / `AgentSessionRecord`
 *   that the caller appends to `run.artifacts` / `run.agent_sessions`. The
 *   body never pushes into `input.run` itself (SPEC §Activity Result And
 *   Evidence Invariants).
 *
 * `applyActivityResult` applies both halves in one step. Parsed failed review
 * findings are promoted into `run.findings` and linked back to the review
 * state record; workflow-specific inbox routing still belongs to the workflow.
 */
export function applyActivityResult(
  run: WorkflowRunRecord,
  result: ActivityResult
): WorkflowRunRecord {
  let next = applyRunDelta(run, result.delta);

  if (result.commandOutcome) {
    next = {
      ...next,
      artifacts: [...next.artifacts, result.commandOutcome.artifact]
    };
  }

  if (result.reviewOutcome) {
    const outcome = result.reviewOutcome;
    if (outcome.kind !== "skipped") {
      next = {
        ...next,
        artifacts: [...next.artifacts, ...outcome.artifacts],
        agent_sessions: [...next.agent_sessions, ...outcome.agentSessions]
      };
      next = appendParsedReviewFindings(next, result);
    }
  }

  if (result.workerOutcome && result.workerOutcome.kind === "executed") {
    next = {
      ...next,
      artifacts: [...next.artifacts, ...result.workerOutcome.artifacts],
      agent_sessions: [...next.agent_sessions, ...result.workerOutcome.agentSessions]
    };
  }

  return next;
}

export function latestStateByName(
  run: WorkflowRunRecord,
  stateName: string
): WorkflowStateRecord | undefined {
  for (let i = run.states.length - 1; i >= 0; i -= 1) {
    if (run.states[i]?.name === stateName) return run.states[i];
  }
  return undefined;
}

export function addRunInboxItem(
  run: WorkflowRunRecord,
  item: DecisionInboxItemRecord
): WorkflowRunRecord {
  if (run.inbox.some((existing) => existing.id === item.id)) {
    return run;
  }
  return { ...run, inbox: [...run.inbox, item] };
}

export function nextRunLocalId(run: WorkflowRunRecord, prefix: string): string {
  const counter =
    run.states.length +
    run.activity_attempts.length +
    run.artifacts.length +
    run.findings.length +
    run.inbox.length +
    run.agent_sessions.length;
  return `${prefix}_${counter + 1}`;
}

function appendParsedReviewFindings(
  run: WorkflowRunRecord,
  result: ActivityResult
): WorkflowRunRecord {
  const outcome = result.reviewOutcome;
  if (!outcome || outcome.kind !== "parsed" || outcome.result.status !== "fail") {
    return run;
  }
  const sourceState = result.delta.states?.[0];
  if (!sourceState) {
    return run;
  }

  let next = run;
  const findingIds: string[] = [];
  const createdAt = sourceState.finished_at ?? sourceState.started_at ?? run.updated_at;
  for (const finding of outcome.result.findings) {
    const id = nextRunLocalId(next, "finding");
    findingIds.push(id);
    next = {
      ...next,
      findings: [
        ...next.findings,
        {
          id,
          status: "new",
          severity: finding.severity,
          title: finding.title,
          detail: finding.detail,
          ...(finding.target ? { target: finding.target } : {}),
          source_state_id: sourceState.id,
          ...(outcome.reviewerSessionId ? { source_review_session_id: outcome.reviewerSessionId } : {}),
          ...(finding.target_session_id ? { target_work_session_id: finding.target_session_id } : {}),
          created_at: createdAt
        }
      ]
    };
  }

  return {
    ...next,
    states: next.states.map((state) =>
      state.id === sourceState.id
        ? { ...state, finding_ids: [...state.finding_ids, ...findingIds] }
        : state
    )
  };
}

/**
 * Apply a `StateRecordPatch` from an external `modifyState` signal to the
 * latest state record whose `name === stateName`. Pure.
 *
 * Contract (see SPEC §Workflow Model → `waitForStateApproval`):
 * - The patch is an overlay, not a replacement. `status`, `reason`, and
 *   `note` update the latest state record; `artifacts` and `findings` are
 *   appended to both the state record's id lists and to the run-level
 *   arrays (`run.artifacts`, `run.findings`).
 * - Resulting state status must be terminal (`succeeded | failed |
 *   skipped | blocked | timed_out`). If the patch omits `status` the
 *   existing status is kept — which must already be terminal, because
 *   gate is called after an activity has finalized the state.
 * - If no existing state has the requested NAME, throw. Signalling
 *   `modifyState` before the activity has run is a caller error; the
 *   workflow does not synthesize a placeholder state record.
 *
 * Earlier state records that share the NAME (produced by previous
 * activity attempts for the same NAME) are left untouched.
 */
export function applyModifyStateDecision(
  run: WorkflowRunRecord,
  stateName: string,
  patch: StateRecordPatch
): WorkflowRunRecord {
  let latestIndex = -1;
  for (let i = run.states.length - 1; i >= 0; i--) {
    const candidate = run.states[i];
    if (candidate && candidate.name === stateName) {
      latestIndex = i;
      break;
    }
  }
  if (latestIndex < 0) {
    throw new Error(
      `modifyState cannot patch state '${stateName}' because no state with that name has run yet`
    );
  }
  const original = run.states[latestIndex]!;

  const nextStatus: WorkflowStateStatus = patch.status ?? original.status;
  if (!TERMINAL_STATE_STATUSES.includes(nextStatus)) {
    throw new Error(
      `modifyState resulting status must be terminal (one of ${TERMINAL_STATE_STATUSES.join(", ")}), got '${nextStatus}'`
    );
  }

  const baseReason = patch.reason ?? original.reason;
  const nextReason = patch.note
    ? baseReason
      ? `${baseReason} — note: ${patch.note}`
      : patch.note
    : baseReason;

  const addedArtifacts = patch.artifacts ?? [];
  const addedArtifactIds = addedArtifacts.map((a) => a.id);
  const addedFindings = patch.findings ?? [];
  const addedFindingIds = addedFindings.map((f) => f.id);

  const patched: WorkflowStateRecord = {
    ...original,
    status: nextStatus,
    ...(nextReason !== undefined ? { reason: nextReason } : {}),
    artifact_ids: [...original.artifact_ids, ...addedArtifactIds],
    finding_ids: [...original.finding_ids, ...addedFindingIds]
  };

  const nextStates = [...run.states];
  nextStates[latestIndex] = patched;

  return {
    ...run,
    states: nextStates,
    artifacts: addedArtifacts.length > 0 ? [...run.artifacts, ...addedArtifacts] : run.artifacts,
    findings: addedFindings.length > 0 ? [...run.findings, ...addedFindings] : run.findings
  };
}
