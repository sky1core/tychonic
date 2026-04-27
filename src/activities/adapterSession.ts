import type { ActivityResult } from "../temporal/types.js";
import type { AdapterDispatch } from "../adapters/resolveAdapter.js";

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
  const session = result.workerOutcome.agentSessions[0];
  if (!session) {
    return result;
  }
  const stdout = result.workerOutcome.rawStdout ?? "";
  const exitCode = result.delta.activityAttempts?.[0]?.exit_code ?? 0;
  const parsed = adapterDispatch.adapter.parseResult(stdout, "", exitCode);
  const sessionId = parsed.sessionId;
  if (!sessionId) {
    return result;
  }

  const previousId = session.id;
  session.id = sessionId;
  session.resumable = true;

  const attempt = result.delta.activityAttempts?.[0];
  if (attempt?.agent_session_id === previousId) {
    attempt.agent_session_id = session.id;
  }

  return result;
}
