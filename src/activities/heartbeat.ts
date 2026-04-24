import { Context } from "@temporalio/activity";

export function heartbeatActivity(details: unknown): void {
  try {
    Context.current().heartbeat(details);
  } catch {
    // Direct invocation outside Temporal context (tests).
  }
}
