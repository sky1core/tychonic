import { CancelledFailure, Context } from "@temporalio/activity";

/**
 * Activity-side heartbeat helper. Activity bodies wire long-running
 * progress callbacks through this so Temporal sees regular heartbeats
 * and aborted cancellation signals propagate as `CancelledFailure`.
 */
export function heartbeatActivity(details: unknown): void {
  let context: Context;
  try {
    context = Context.current();
  } catch {
    // Direct invocation outside Temporal context (tests).
    return;
  }
  context.heartbeat(details);
  const signal = context.cancellationSignal;
  if (signal.aborted) {
    throw new CancelledFailure(
      typeof signal.reason === "string" && signal.reason.length > 0
        ? signal.reason
        : "activity cancelled"
    );
  }
}
