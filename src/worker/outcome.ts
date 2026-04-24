import type { AgentSessionRecord, ArtifactRecord, WorkflowStateStatus } from "../domain/types.js";

/**
 * Outcome of one worker-body invocation. Parallels
 * `ReviewActivityOutcome` / `commandOutcome`. Returned through
 * `ActivityResult.workerOutcome` by `work`, `resume_work`, and (in future)
 * `auto_continue` activities.
 *
 * `artifacts` and `agentSessions` carry full records (not ids) because the
 * caller appends them to `run.artifacts` / `run.agent_sessions`; the body
 * never mutates `input.run` (SPEC §File I/O vs run mutation).
 *
 * For fresh work: `agentSessions` contains a newly-constructed session the
 * body created. For resume: the caller-supplied session id is returned
 * through `resumedSessionId`, and `agentSessions` contains the same session
 * record updated in place by the adapter (new external_session_id or
 * resume_command if observed).
 *
 * `status` duplicates `state.status` for callers that want to branch
 * without re-scanning `run.states`.
 */
export type WorkerActivityOutcome =
  | { kind: "skipped"; reason: string }
  | {
      kind: "executed";
      status: WorkflowStateStatus;
      artifacts: ArtifactRecord[];
      agentSessions: AgentSessionRecord[];
      resumedSessionId?: string;
    };
