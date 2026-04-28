import type { AgentSessionRecord, ArtifactRecord, WorkflowStateStatus } from "../domain/types.js";

/**
 * Outcome of one worker-body invocation. Parallels
 * `ReviewActivityOutcome` / `commandOutcome`. Returned through
 * `ActivityResult.workerOutcome` by `work` and explicit resume-work calls.
 *
 * `artifacts` and `agentSessions` carry full records (not ids) because the
 * caller appends them to `run.artifacts` / `run.agent_sessions`; the body
 * never mutates `input.run` (SPEC §Activity Result And Evidence Invariants).
 *
 * For fresh work: `agentSessions` contains a newly-constructed session the
 * body created. For resume: the caller-supplied session id is returned
 * through `resumedSessionId`, and `agentSessions` is empty because no new
 * session is registered.
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
      /**
       * Raw stdout captured from the worker command. Populated when the
       * call site needs to feed stdout into an adapter's `parseResult`
       * (built-in agent dispatch path). Absent for explicit-`command`
       * invocations that have no adapter to consult.
       */
      rawStdout?: string;
    };
