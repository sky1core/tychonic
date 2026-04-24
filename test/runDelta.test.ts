import { describe, expect, it } from "vitest";
import { applyRunDelta, type WorkflowRunDelta } from "../src/domain/runDelta.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";

describe("applyRunDelta", () => {
  it("appends states", () => {
    const run = sampleRun();

    const result = applyRunDelta(run, {
      states: [
        {
          id: "state_2",
          name: "unit_test",
          status: "succeeded",
          reason: "tests passed",
          activity_attempt_ids: [],
          artifact_ids: [],
          finding_ids: [],
          started_at: "2026-04-20T00:01:00.000Z",
          finished_at: "2026-04-20T00:02:00.000Z"
        }
      ]
    });

    expect(result.states.map((step) => step.id)).toEqual(["state_1", "state_2"]);
    expect(run.states.map((step) => step.id)).toEqual(["state_1"]);
  });

  it("appends activity attempts", () => {
    const run = sampleRun();

    const result = applyRunDelta(run, {
      activityAttempts: [
        {
          id: "attempt_2",
          state_id: "state_1",
          kind: "deterministic_command",
          status: "succeeded",
          reason: "command passed",
          cwd: "/repo",
          started_at: "2026-04-20T00:00:30.000Z",
          finished_at: "2026-04-20T00:00:40.000Z"
        }
      ]
    });

    expect(result.activity_attempts.map((attempt) => attempt.id)).toEqual(["attempt_1", "attempt_2"]);
    expect(run.activity_attempts.map((attempt) => attempt.id)).toEqual(["attempt_1"]);
  });

  it("shallow-merges facts", () => {
    const run = sampleRun();

    const result = applyRunDelta(run, {
      facts: {
        tests_changed: true,
        test_command: "npm test"
      }
    });

    expect(result.facts).toEqual({
      changed_files: [],
      has_changes: false,
      has_source: false,
      only_docs: false,
      tests_changed: true,
      frontend_changed: false,
      docs_changed: false,
      test_command: "npm test"
    });
    expect(run.facts).toEqual({
      changed_files: [],
      has_changes: false,
      has_source: false,
      only_docs: false,
      tests_changed: false,
      frontend_changed: false,
      docs_changed: false
    });
  });

  it("replaces status", () => {
    const run = sampleRun();

    const result = applyRunDelta(run, { status: "failed" });

    expect(result.status).toBe("failed");
    expect(run.status).toBe("running");
  });

  it("replaces summary", () => {
    const run = sampleRun();

    const result = applyRunDelta(run, { summary: "review failed" });

    expect(result.summary).toBe("review failed");
    expect(run.summary).toBe("lint passed");
  });

  it("preserves the run shape for an empty delta", () => {
    const run = sampleRun();
    const result = applyRunDelta(run, {});

    expect(result).toEqual(run);
    expect(result).not.toBe(run);
    expect(result.states).not.toBe(run.states);
    expect(result.activity_attempts).not.toBe(run.activity_attempts);
    expect(result.agent_sessions).not.toBe(run.agent_sessions);
    expect(result.artifacts).not.toBe(run.artifacts);
    expect(result.findings).not.toBe(run.findings);
    expect(result.inbox).not.toBe(run.inbox);
  });

  it("does not mutate the source run", () => {
    const run = sampleRun();
    const before = structuredClone(run);
    const delta: WorkflowRunDelta = {
      states: [
        {
          id: "state_2",
          name: "review",
          status: "failed",
          reason: "new finding",
          activity_attempt_ids: ["attempt_2"],
          artifact_ids: [],
          finding_ids: [],
          started_at: "2026-04-20T00:03:00.000Z",
          finished_at: "2026-04-20T00:04:00.000Z"
        }
      ],
      activityAttempts: [
        {
          id: "attempt_2",
          state_id: "state_2",
          kind: "semantic_review",
          status: "failed",
          reason: "review failed",
          cwd: "/repo",
          started_at: "2026-04-20T00:03:00.000Z",
          finished_at: "2026-04-20T00:04:00.000Z"
        }
      ],
      facts: { has_source: true },
      status: "failed",
      summary: "review failed"
    };

    applyRunDelta(run, delta);

    expect(run).toEqual(before);
  });
});

function sampleRun(): WorkflowRunRecord {
  return {
    schema_version: "tychonic.run.v1",
    id: "run_1",
    template: "checkpoint",
    status: "running",
    cwd: "/repo",
    summary: "lint passed",
    facts: {
      changed_files: [],
      has_changes: false,
      has_source: false,
      only_docs: false,
      tests_changed: false,
      frontend_changed: false,
      docs_changed: false
    },
    created_at: "2026-04-20T00:00:00.000Z",
    updated_at: "2026-04-20T00:00:00.000Z",
    states: [
      {
        id: "state_1",
        name: "lint",
        status: "succeeded",
        reason: "command passed",
        activity_attempt_ids: ["attempt_1"],
        artifact_ids: [],
        finding_ids: [],
        started_at: "2026-04-20T00:00:00.000Z",
        finished_at: "2026-04-20T00:00:10.000Z"
      }
    ],
    activity_attempts: [
      {
        id: "attempt_1",
        state_id: "state_1",
        kind: "deterministic_command",
        status: "succeeded",
        reason: "command passed",
        cwd: "/repo",
        started_at: "2026-04-20T00:00:00.000Z",
        finished_at: "2026-04-20T00:00:10.000Z"
      }
    ],
    agent_sessions: [
      {
        id: "session_1",
        agent: "codex",
        role: "reviewer",
        cwd: "/repo",
        status: "unknown",
        started_at: "2026-04-20T00:00:00.000Z"
      }
    ],
    artifacts: [
      {
        id: "artifact_1",
        kind: "lint_output",
        path: "/repo/.tychonic/runs/run_1/lint.txt",
        created_at: "2026-04-20T00:00:10.000Z"
      }
    ],
    findings: [
      {
        id: "finding_1",
        status: "confirmed",
        severity: "low",
        title: "Example",
        detail: "Example finding",
        target: "src/example.ts",
        source_state_id: "state_1",
        created_at: "2026-04-20T00:00:10.000Z"
      }
    ],
    inbox: [
      {
        id: "inbox_1",
        status: "open",
        title: "Example inbox item",
        detail: "Needs review",
        action: { kind: "triage", reason: "example" },
        created_at: "2026-04-20T00:00:10.000Z"
      }
    ]
  };
}
