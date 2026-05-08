import type { ActivityResult } from "../temporal/types.js";
import type { AdapterDispatch } from "../adapters/resolveAdapter.js";
import { reportedModelMismatchMessage } from "../adapters/modelSelection.js";

/**
 * Adapter-created worker sessions start with a temporary local id because
 * the command has not run yet. Once the adapter exposes its durable session
 * id, that id becomes the single session id stored in the run record.
 */
export function applyParsedAdapterSession(
  result: ActivityResult,
  adapterDispatch: AdapterDispatch
): ActivityResult {
  if (result.workerOutcome?.kind !== "executed") {
    return result;
  }
  const stdout = result.workerOutcome.rawStdout ?? "";
  const exitCode = result.delta.activityAttempts?.[0]?.exit_code ?? 0;
  const parsed = adapterDispatch.adapter.parseResult(stdout, "", exitCode);

  const session = result.workerOutcome.agentSessions[0];
  const sessionId = parsed.sessionId;
  if (session && sessionId) {
    const previousId = session.id;
    session.id = sessionId;
    session.resumable = true;

    const attempt = result.delta.activityAttempts?.[0];
    if (attempt?.agent_session_id === previousId) {
      attempt.agent_session_id = session.id;
    }
  }

  const modelMismatch = reportedModelMismatchMessage({
    agentName: adapterDispatch.agentName,
    requestedModel: adapterDispatch.requestedModel,
    reportedModel: parsed.reportedModel
  });
  if (result.workerOutcome.status === "succeeded" && modelMismatch !== undefined) {
    markWorkerModelMismatch(result, modelMismatch);
  }

  return result;
}

function markWorkerModelMismatch(result: ActivityResult, reason: string): void {
  const attempt = result.delta.activityAttempts?.[0];
  if (attempt) {
    attempt.status = "failed";
    attempt.reason = reason;
    attempt.error = reason;
  }

  const state = result.delta.states?.[0];
  if (state) {
    state.status = "failed";
    state.reason = reason;
  }

  if (result.workerOutcome?.kind === "executed") {
    result.workerOutcome.status = "failed";
    for (const session of result.workerOutcome.agentSessions) {
      session.status = "failed";
    }
  }
}
