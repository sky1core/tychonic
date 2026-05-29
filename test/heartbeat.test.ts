import { describe, expect, it } from "vitest";
import { heartbeatActivity, throwIfCancelled } from "../src/activities/heartbeat.js";

// `heartbeatActivity` only sends heartbeats; `throwIfCancelled` is the only
// path that surfaces Temporal cancellation as `CancelledFailure`. Outside a
// Temporal activity context (`Context.current()` throws) both helpers return
// without doing anything. The aborted branch in `throwIfCancelled` reads the
// activity `cancellationSignal`, which only exists inside a real activity
// context; exercising that branch requires a live Temporal activity context,
// not a fabricated mock backend, so it is covered by the in-process worker
// path rather than this unit test.
describe("heartbeat helpers", () => {
  it("heartbeatActivity returns without throwing outside a Temporal context", () => {
    expect(() => heartbeatActivity({ runId: "run_test" })).not.toThrow();
  });

  it("throwIfCancelled returns without throwing outside a Temporal context", () => {
    expect(() => throwIfCancelled()).not.toThrow();
  });
});
