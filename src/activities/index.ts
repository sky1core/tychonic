/**
 * Host-side activity registry. Workflow bundles compose these
 * activity functions through `proxyActivities` from `@temporalio/workflow`.
 *
 * `heartbeatActivity` is a generic activity-side heartbeat helper that
 * activity bodies use directly; it is exported so per-TYPE activity
 * implementations under this directory can wire it without re-importing
 * from `@temporalio/activity`.
 */
import { CancelledFailure, Context } from "@temporalio/activity";

export { heartbeatActivity } from "./heartbeat.js";

export { runVerifyActivity } from "./runVerifyActivity.js";
export { runWorkerActivity } from "./runWorkerActivity.js";
export { runReviewActivity } from "./runReviewActivity.js";
export { startRunActivity } from "./startRunActivity.js";
export { collectGitFactsActivity } from "./collectGitFactsActivity.js";
export { createWorktreeActivity } from "./createWorktreeActivity.js";
export { finalizeRunActivity } from "./finalizeRunActivity.js";

/**
 * Reads the activity-side cancellation signal. Per-TYPE activity bodies
 * call this when they spawn long-lived child processes that need to be
 * cancelled in step with Temporal-side cancellation.
 */
export function currentCancellationSignal(): AbortSignal | undefined {
  try {
    return Context.current().cancellationSignal;
  } catch {
    return undefined;
  }
}

// Re-export the CancelledFailure surface so per-TYPE activity bodies
// (e.g. `runWorkerActivity` cancellation propagation) do not need to
// import `@temporalio/activity` directly.
export { CancelledFailure };
