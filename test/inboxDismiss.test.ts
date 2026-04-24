import { describe, expect, it } from "vitest";
import { dismissDecisionInboxItem } from "../src/domain/inbox.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";

describe("dismissDecisionInboxItem", () => {
  it("dismisses an open inbox item, preserves the reason, and completes the run when no open items remain", () => {
    const run = waitingRun();

    const result = dismissDecisionInboxItem({
      run,
      inboxItemId: "inbox_1",
      reason: "the finding is no longer actionable",
      dismissedAt: "2026-04-20T00:00:00.000Z"
    });

    expect(run.inbox[0]?.status).toBe("open");
    expect(result.status).toBe("succeeded");
    expect(result.updated_at).toBe("2026-04-20T00:00:00.000Z");
    expect(result.inbox[0]).toMatchObject({
      id: "inbox_1",
      status: "dismissed"
    });
    expect(result.inbox[0]?.detail).toContain("Continue work");
    expect(result.inbox[0]?.detail).toContain("Dismissed at 2026-04-20T00:00:00.000Z");
    expect(result.inbox[0]?.detail).toContain("the finding is no longer actionable");
    expect(result.findings[0]?.status).toBe("rejected");
  });

  it("keeps the run waiting when other inbox items are still open", () => {
    const run = waitingRun();
    run.inbox.push({
      id: "inbox_2",
      status: "open",
      title: "Another review finding",
      detail: "Still needs a decision",
      action: { kind: "manual_approval", reason: "needs user" },
      created_at: "2026-04-19T00:00:02.000Z"
    });

    const result = dismissDecisionInboxItem({
      run,
      inboxItemId: "inbox_1",
      dismissedAt: "2026-04-20T00:00:00.000Z"
    });

    expect(result.status).toBe("waiting_user");
    expect(result.inbox.map((item) => item.status)).toEqual(["dismissed", "open"]);
  });

  it("rejects dismissing an item that is not open", () => {
    const run = waitingRun();
    run.inbox[0]!.status = "resolved";

    expect(() =>
      dismissDecisionInboxItem({
        run,
        inboxItemId: "inbox_1",
        dismissedAt: "2026-04-20T00:00:00.000Z"
      })
    ).toThrow("inbox item is not open: inbox_1");
  });

  it("recomputes status from the latest state by NAME after dismissing the last inbox item", () => {
    const run = waitingRun();
    run.states = [
      {
        ...run.states[0]!,
        id: "state_old",
        name: "verify",
        status: "failed",
        reason: "first verify failed"
      },
      {
        ...run.states[0]!,
        id: "state_new",
        name: "verify",
        status: "succeeded",
        reason: "retry verify passed"
      }
    ];

    const result = dismissDecisionInboxItem({
      run,
      inboxItemId: "inbox_1",
      dismissedAt: "2026-04-20T00:00:00.000Z"
    });

    expect(result.status).toBe("succeeded");
  });
});

function waitingRun(): WorkflowRunRecord {
  return {
    schema_version: "tychonic.run.v1",
    id: "run_1",
    template: "simple_workflow",
    status: "waiting_user",
    cwd: "/repo",
    created_at: "2026-04-19T00:00:00.000Z",
    updated_at: "2026-04-19T00:00:01.000Z",
    states: [
      {
        id: "state_1",
        name: "review",
        status: "blocked",
        reason: "review finding",
        activity_attempt_ids: [],
        artifact_ids: [],
        finding_ids: ["finding_1"],
        started_at: "2026-04-19T00:00:00.000Z",
        finished_at: "2026-04-19T00:00:01.000Z"
      }
    ],
    activity_attempts: [],
    agent_sessions: [],
    artifacts: [],
    findings: [
      {
        id: "finding_1",
        status: "needs_decision",
        severity: "medium",
        title: "Review finding",
        detail: "Needs a human decision.",
        target: "src/example.ts",
        source_state_id: "state_1",
        created_at: "2026-04-19T00:00:01.000Z"
      }
    ],
    inbox: [
      {
        id: "inbox_1",
        status: "open",
        title: "Review finding",
        detail: "Continue work",
        finding_id: "finding_1",
        action: { kind: "triage", reason: "review finding" },
        created_at: "2026-04-19T00:00:01.000Z"
      }
    ]
  };
}
