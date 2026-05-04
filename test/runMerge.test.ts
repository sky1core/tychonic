import { describe, expect, it } from "vitest";
import {
  applyActivityResult,
  applyModifyStateDecision
} from "../src/workflows/runMerge.js";
import type { WorkflowRunRecord, WorkflowStateRecord } from "../src/domain/types.js";
import type { ActivityResult } from "../src/temporal/types.js";

describe("applyActivityResult", () => {
  it("merges delta states/attempts without mutating the source run", () => {
    const run = baseRun("run_merge");
    const before = structuredClone(run);

    const result: ActivityResult = {
      delta: {
        states: [
          {
            id: "state_1",
            name: "lint",
            status: "succeeded",
            reason: "ok",
            activity_attempt_ids: ["attempt_1"],
            artifact_ids: [],
            finding_ids: [],
            started_at: "2026-01-01T00:00:00Z",
            finished_at: "2026-01-01T00:00:01Z"
          }
        ],
        activityAttempts: [
          {
            id: "attempt_1",
            state_id: "state_1",
            kind: "deterministic_command",
            status: "succeeded",
            reason: "succeeded",
            cwd: "/ignored",
            started_at: "2026-01-01T00:00:00Z"
          }
        ]
      }
    };

    const next = applyActivityResult(run, result);
    expect(run).toEqual(before);
    expect(next.states).toHaveLength(1);
    expect(next.activity_attempts).toHaveLength(1);
  });

  it("appends commandOutcome.artifact to run.artifacts", () => {
    const run = baseRun("run_cmd_out");
    const result: ActivityResult = {
      delta: { states: [], activityAttempts: [] },
      commandOutcome: {
        artifact: {
          id: "artifact_1",
          kind: "lint_output",
          path: "runs/run_cmd_out/artifacts/lint_output-attempt_1.txt",
          created_at: "2026-01-01T00:00:00Z"
        }
      }
    };
    const next = applyActivityResult(run, result);
    expect(next.artifacts).toHaveLength(1);
    expect(next.artifacts[0]?.id).toBe("artifact_1");
  });

  it("appends reviewOutcome artifacts and sessions for parsed outcomes", () => {
    const run = baseRun("run_rev_out");
    const result: ActivityResult = {
      delta: { states: [], activityAttempts: [] },
      reviewOutcome: {
        kind: "parsed",
        result: { schema_version: "tychonic.review.v1", status: "pass", summary: "ok", findings: [] },
        reviewerSessionId: "sess_r1",
        artifacts: [
          {
            id: "artifact_p",
            kind: "review_prompt",
            path: "p",
            created_at: "2026-01-01T00:00:00Z"
          }
        ],
        agentSessions: [
          {
            id: "sess_r1",
            agent: "claude",
            role: "reviewer",
            cwd: "/ignored",
            status: "succeeded",
            started_at: "2026-01-01T00:00:00Z"
          }
        ]
      }
    };
    const next = applyActivityResult(run, result);
    expect(next.artifacts).toHaveLength(1);
    expect(next.agent_sessions).toHaveLength(1);
  });

  it("promotes failed parsed review findings to run-level records", () => {
    const run = baseRun("run_rev_findings");
    const result: ActivityResult = {
      delta: {
        states: [
          {
            id: "state_review",
            name: "review",
            status: "failed",
            reason: "has findings",
            activity_attempt_ids: ["attempt_review"],
            artifact_ids: [],
            finding_ids: [],
            started_at: "2026-01-01T00:00:00Z",
            finished_at: "2026-01-01T00:00:05Z"
          }
        ],
        activityAttempts: []
      },
      reviewOutcome: {
        kind: "parsed",
        result: {
          schema_version: "tychonic.review.v1",
          status: "fail",
          summary: "needs work",
          findings: [
            {
              severity: "high",
              title: "Missing regression test",
              detail: "Add a test for the changed behavior.",
              target: "test/example.test.ts",
              target_session_id: "sess_worker"
            }
          ]
        },
        reviewerSessionId: "sess_review",
        artifacts: [],
        agentSessions: []
      }
    };

    const next = applyActivityResult(run, result);
    expect(next.findings).toHaveLength(1);
    expect(next.findings[0]).toMatchObject({
      id: "finding_2",
      status: "new",
      severity: "high",
      title: "Missing regression test",
      source_state_id: "state_review",
      source_review_session_id: "sess_review",
      target_work_session_id: "sess_worker",
      created_at: "2026-01-01T00:00:05Z"
    });
    expect(next.states[0]?.finding_ids).toEqual(["finding_2"]);
  });

  it("appends reviewOutcome artifacts and sessions for command failures", () => {
    const run = baseRun("run_rev_failed_out");
    const result: ActivityResult = {
      delta: { states: [], activityAttempts: [] },
      reviewOutcome: {
        kind: "command_failed",
        status: "failed",
        reviewerSessionId: "sess_failed",
        artifacts: [
          {
            id: "artifact_failed",
            kind: "review_output",
            path: "failed",
            created_at: "2026-01-01T00:00:00Z"
          }
        ],
        agentSessions: [
          {
            id: "sess_failed",
            agent: "claude",
            role: "reviewer",
            cwd: "/ignored",
            status: "failed",
            started_at: "2026-01-01T00:00:00Z"
          }
        ]
      }
    };
    const next = applyActivityResult(run, result);
    expect(next.artifacts).toHaveLength(1);
    expect(next.agent_sessions).toHaveLength(1);
  });

  it("appends workerOutcome artifacts and sessions for executed outcomes", () => {
    const run = baseRun("run_wrk_out");
    const result: ActivityResult = {
      delta: { states: [], activityAttempts: [] },
      workerOutcome: {
        kind: "executed",
        status: "succeeded",
        artifacts: [
          { id: "artifact_w", kind: "work_output", path: "w", created_at: "2026-01-01T00:00:00Z" }
        ],
        agentSessions: [
          { id: "sess_w1", agent: "codex", role: "worker", cwd: "/ignored", status: "succeeded", started_at: "2026-01-01T00:00:00Z" }
        ]
      }
    };
    const next = applyActivityResult(run, result);
    expect(next.artifacts).toHaveLength(1);
    expect(next.agent_sessions).toHaveLength(1);
  });
});

describe("applyModifyStateDecision", () => {
  it("overlays status/reason on the latest matching state record", () => {
    const run = baseRun("run_modify_latest");
    run.states = [
      terminalState("state_a1", "review", "succeeded", "2026-01-01T00:00:00Z"),
      terminalState("state_a2", "verify", "succeeded", "2026-01-01T00:00:01Z"),
      terminalState("state_a3", "review", "succeeded", "2026-01-01T00:00:02Z")
    ];
    const next = applyModifyStateDecision(run, "review", {
      status: "failed",
      reason: "external reject via modifyState"
    });
    expect(next.states).toHaveLength(3);
    expect(next.states[0]).toEqual(run.states[0]);
    expect(next.states[1]).toEqual(run.states[1]);
    expect(next.states[2]?.id).toBe("state_a3"); // id preserved
    expect(next.states[2]?.status).toBe("failed");
    expect(next.states[2]?.reason).toBe("external reject via modifyState");
  });

  it("leaves the input run untouched", () => {
    const run = baseRun("run_modify_immutable");
    run.states = [terminalState("state_b1", "review", "succeeded", "2026-01-01T00:00:00Z")];
    const before = structuredClone(run);
    applyModifyStateDecision(run, "review", { status: "failed", reason: "x" });
    expect(run).toEqual(before);
  });

  it("leaves earlier records with the same name untouched (overlay on latest only)", () => {
    const run = baseRun("run_modify_earlier");
    run.states = [
      terminalState("state_c1", "review", "succeeded", "2026-01-01T00:00:00Z"),
      terminalState("state_c2", "review", "failed", "2026-01-01T00:00:01Z")
    ];
    const next = applyModifyStateDecision(run, "review", { status: "succeeded" });
    expect(next.states[0]).toEqual(run.states[0]);
    expect(next.states[1]?.id).toBe("state_c2");
    expect(next.states[1]?.status).toBe("succeeded");
  });

  it("throws when no matching state exists", () => {
    const run = baseRun("run_modify_missing");
    expect(() =>
      applyModifyStateDecision(run, "review", { status: "succeeded" })
    ).toThrowError(/no state with that name has run yet/);
  });

  it("throws when resulting status is not terminal", () => {
    const run = baseRun("run_modify_notterminal");
    run.states = [terminalState("state_f1", "review", "succeeded", "2026-01-01T00:00:00Z")];
    expect(() =>
      applyModifyStateDecision(run, "review", { status: "running" as never })
    ).toThrowError(/resulting status must be terminal/);
  });

  it("appends a note to existing reason (separator format)", () => {
    const run = baseRun("run_modify_note_append");
    run.states = [
      { ...terminalState("s1", "review", "succeeded", "2026-01-01T00:00:00Z"), reason: "auto-pass" }
    ];
    const next = applyModifyStateDecision(run, "review", { note: "reviewer added caveat" });
    expect(next.states[0]?.reason).toBe("auto-pass — note: reviewer added caveat");
  });

  it("sets reason from note when no prior reason exists", () => {
    const run = baseRun("run_modify_note_set");
    run.states = [terminalState("s1", "review", "succeeded", "2026-01-01T00:00:00Z")];
    const next = applyModifyStateDecision(run, "review", { note: "extra context" });
    expect(next.states[0]?.reason).toBe("extra context");
  });
});

function terminalState(
  id: string,
  name: string,
  status: WorkflowStateRecord["status"],
  startedAt: string
): WorkflowStateRecord {
  return {
    id,
    name,
    status,
    reason: "",
    activity_attempt_ids: [],
    artifact_ids: [],
    finding_ids: [],
    started_at: startedAt,
    finished_at: startedAt
  };
}

function baseRun(id: string): WorkflowRunRecord {
  return {
    schema_version: "tychonic.run.v1",
    id,
    template: "checkpoint",
    status: "running",
    cwd: "/ignored",
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
