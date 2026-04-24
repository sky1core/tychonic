import type { RunFacts } from "../facts/gitFacts.js";
import type {
  ActivityAttemptRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStateRecord
} from "./types.js";

/**
 * Change set a single activity call returns. The caller merges the delta
 * into its `WorkflowRunRecord` via `applyRunDelta`.
 *
 * Stage 1 supports exactly five fields. Run-level id lists
 * (`artifact_ids`, `finding_ids`, `inbox_item_ids`, `agent_session_ids`)
 * are deliberately not part of this delta because `WorkflowRunRecord`
 * has no matching run-level slots — those lives on individual steps or
 * on the record's object arrays (`run.artifacts`, `run.findings`, etc.).
 * Activities that produce those records must return them through their
 * own TYPE-specific result shape (e.g. `reviewOutcome` for review
 * activities) and the caller merges them into the appropriate
 * object arrays directly.
 *
 * @field steps             New `WorkflowStateRecord`s to append to
 *                          `run.states`. Each state must carry its own
 *                          lifecycle (`started_at` + `finished_at` on
 *                          both success and failure; never handed off in
 *                          `running` state).
 * @field activityAttempts  New `ActivityAttemptRecord`s to append to
 *                          `run.activity_attempts`. Naming differs from
 *                          the record field (`activity_attempts`) because
 *                          delta keys use camelCase per project style.
 * @field facts             Shallow patch applied over `run.facts`. Missing
 *                          keys preserve the prior value; present keys
 *                          replace it.
 * @field status            New `run.status` (terminal or progress update).
 *                          Missing means no change.
 * @field summary           New `run.summary` string. Missing means no
 *                          change.
 */
export interface WorkflowRunDelta {
  states?: WorkflowStateRecord[];
  activityAttempts?: ActivityAttemptRecord[];
  facts?: Partial<RunFacts>;
  status?: WorkflowRunStatus;
  summary?: string;
}

/**
 * Pure merge: returns a shallow-copied `WorkflowRunRecord` with the delta
 * applied. `run` is never mutated. Arrays Tychonic does not manage through
 * the delta (`artifacts`, `findings`, `inbox`, `agent_sessions`) are
 * copied as-is so downstream mutation of the returned record cannot
 * leak back into the source.
 */
export function applyRunDelta(run: WorkflowRunRecord, delta: WorkflowRunDelta): WorkflowRunRecord {
  const nextRun: WorkflowRunRecord = {
    ...run,
    states: delta.states ? [...run.states, ...delta.states] : [...run.states],
    activity_attempts: delta.activityAttempts ? [...run.activity_attempts, ...delta.activityAttempts] : [...run.activity_attempts],
    facts: delta.facts ? mergeRunFacts(run.facts, delta.facts) : run.facts,
    status: delta.status ?? run.status,
    agent_sessions: [...run.agent_sessions],
    artifacts: [...run.artifacts],
    findings: [...run.findings],
    inbox: [...run.inbox]
  };

  if (delta.summary !== undefined) {
    nextRun.summary = delta.summary;
  } else if (run.summary !== undefined) {
    nextRun.summary = run.summary;
  }

  return nextRun;
}

function mergeRunFacts(existing: WorkflowRunRecord["facts"], delta: Partial<RunFacts>): Partial<RunFacts> {
  return {
    ...asRunFacts(existing),
    ...delta
  };
}

function asRunFacts(value: WorkflowRunRecord["facts"]): Partial<RunFacts> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Partial<RunFacts>;
  }
  return {};
}
