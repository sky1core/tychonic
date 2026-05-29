import { CancelledFailure, Context } from "@temporalio/activity";

/**
 * Activity-side heartbeat helper. Activity bodies wire long-running
 * progress callbacks through this so Temporal sees regular heartbeats.
 *
 * This function only sends heartbeats; it never throws to surface
 * cancellation. Cancellation is surfaced separately by `throwIfCancelled`
 * on the await path after the child run resolves, so a heartbeat timer
 * tick can never escape as an uncaught exception.
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
}

/**
 * Surfaces Temporal-side cancellation to the activity result. Activity
 * bodies call this after the child run resolves so an aborted
 * cancellation signal propagates as `CancelledFailure`. Reading the
 * signal here, not in a timer callback, keeps cancellation surfacing on
 * the synchronous await path.
 */
export function throwIfCancelled(): void {
  let context: Context;
  try {
    context = Context.current();
  } catch {
    // Direct invocation outside Temporal context (tests).
    return;
  }
  const signal = context.cancellationSignal;
  if (signal.aborted) {
    throw new CancelledFailure(
      typeof signal.reason === "string" && signal.reason.length > 0
        ? signal.reason
        : "activity cancelled"
    );
  }
}
