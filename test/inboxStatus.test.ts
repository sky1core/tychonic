import { describe, expect, it } from "vitest";
import { recomputeWorkflowRunStatus } from "../src/domain/inbox.js";
import type { WorkflowRunRecord, WorkflowStateRecord } from "../src/domain/types.js";

describe("recomputeWorkflowRunStatus", () => {
  it("keeps open inbox items as waiting_user even when a state failed", () => {
    const run = baseRun("run_inbox_failed");
    run.states = [state("review", "failed")];
    run.inbox = [
      {
        id: "inbox_1",
        status: "open",
        title: "needs triage",
        detail: "review cap reached",
        action: { kind: "triage", reason: "review cap reached" },
        created_at: "2026-01-01T00:00:01Z"
      }
    ];

    recomputeWorkflowRunStatus(run);

    expect(run.status).toBe("waiting_user");
  });

  it("preserves blocked status when no inbox item is open and no state failed", () => {
    const run = baseRun("run_inbox_blocked");
    run.states = [state("review", "blocked")];

    recomputeWorkflowRunStatus(run);

    expect(run.status).toBe("blocked");
  });
});

function baseRun(id: string): WorkflowRunRecord {
  return {
    schema_version: "tychonic.run.v1",
    id,
    template: "test",
    status: "running",
    cwd: "/tmp/tychonic-test",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    states: [],
    activity_attempts: [],
    agent_sessions: [],
    artifacts: [],
    findings: [],
    inbox: []
  };
}

function state(name: string, status: WorkflowStateRecord["status"]): WorkflowStateRecord {
  return {
    id: `state_${name}`,
    name,
    status,
    reason: status,
    activity_attempt_ids: [],
    artifact_ids: [],
    finding_ids: [],
    started_at: "2026-01-01T00:00:00Z",
    finished_at: "2026-01-01T00:00:01Z"
  };
}
