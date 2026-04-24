import { describe, expect, it } from "vitest";
import type { WorkflowRunRecord } from "../src/domain/types.js";
import { appendInboxForActionableSkippedReviews, nextSequentialId } from "../src/workflows/checkpointPure.js";

describe("checkpoint pure helpers", () => {
  it("allocates the next sequential state id from the current run ids", () => {
    expect(nextSequentialId("state", ["state_1", "attempt_9", "state_7", "state_x", "other_99"])).toBe("state_8");
  });

  it("opens inbox items only for actionable skipped reviews", () => {
    const run = baseRun({
      states: [
        skippedState("state_1", "semantic_review", "no source changes requiring review"),
        skippedState("state_2", "test_review", "autonomy check does not run test-review"),
        skippedState("state_3", "semantic_review", "activity 'semantic_review' is not configured"),
        skippedState("state_4", "lint", "lint command is not configured")
      ]
    });

    const next = appendInboxForActionableSkippedReviews(run, "2026-04-22T06:30:00.000Z");

    expect(next.inbox).toEqual([
      {
        id: "inbox_skipped_state_3",
        status: "open",
        title: "semantic_review skipped",
        detail: "activity 'semantic_review' is not configured",
        action: { kind: "triage", reason: "activity 'semantic_review' is not configured" },
        created_at: "2026-04-22T06:30:00.000Z"
      }
    ]);
  });

  it("does not duplicate actionable skipped review inbox items", () => {
    const run = baseRun({
      states: [skippedState("state_3", "semantic_review", "activity 'semantic_review' is not configured")],
      inbox: [
        {
          id: "inbox_skipped_state_3",
          status: "open",
          title: "semantic_review skipped",
          detail: "activity 'semantic_review' is not configured",
          action: { kind: "triage", reason: "activity 'semantic_review' is not configured" },
          created_at: "2026-04-22T06:30:00.000Z"
        }
      ]
    });

    const next = appendInboxForActionableSkippedReviews(run, "2026-04-22T06:31:00.000Z");

    expect(next.inbox).toHaveLength(1);
  });
});

function baseRun(overrides: Partial<WorkflowRunRecord>): WorkflowRunRecord {
  return {
    schema_version: "tychonic.run.v1",
    id: "checkpoint_test_run",
    template: "checkpoint",
    status: "running",
    cwd: "/tmp/checkpoint-test",
    created_at: "2026-04-22T06:00:00.000Z",
    updated_at: "2026-04-22T06:00:00.000Z",
    states: [],
    activity_attempts: [],
    agent_sessions: [],
    artifacts: [],
    findings: [],
    inbox: [],
    ...overrides
  };
}

function skippedState(id: string, name: string, reason: string) {
  return {
    id,
    name,
    status: "skipped" as const,
    reason,
    activity_attempt_ids: [],
    artifact_ids: [],
    finding_ids: [],
    started_at: "2026-04-22T06:00:00.000Z",
    finished_at: "2026-04-22T06:00:00.000Z"
  };
}
