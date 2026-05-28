import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  artifactContentPath,
  listAgentSessions,
  listArtifacts,
  listInboxItems,
  listLiveOutputAttemptViews,
  listLiveOutputAttempts,
  liveOutputContentPath,
  workflowEvidenceView,
  workflowResultView,
  workflowTimingView,
  type TychonicWorkflowResult
} from "../src/cli/temporalResultViews.js";

describe("Temporal result views", () => {
  it("projects workflow result metadata without inferring state paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-result-view-"));
    const result = fakeResult(cwd);

    expect(workflowResultView(result)).toEqual({
      runId: "run_temporal_view",
      template: "simple_workflow",
      status: "waiting_user",
      goal: "inspect Temporal result"
    });
    expect(listArtifacts(result).map((artifact) => artifact.id)).toEqual(["artifact_1"]);
    expect(listLiveOutputAttempts(result).map((attempt) => attempt.id)).toEqual(["attempt_1"]);
    expect(listInboxItems(result).map((item) => item.id)).toEqual(["inbox_1"]);
    expect(listAgentSessions(result, 1).map((session) => session.id)).toEqual(["session_1"]);
    expect(workflowEvidenceView(result, "wf_1", "run_1")).toMatchObject({
      runId: "run_temporal_view",
      template: "simple_workflow",
      status: "waiting_user",
      counts: {
        states: 1,
        attempts: 2,
        artifacts: 1,
        logs: 1,
        inbox: 1,
        sessions: 1,
        findings: 0
      },
      commands: {
        status: "tychonic status --workflow-id wf_1 --run-id run_1",
        inbox: "tychonic inbox --workflow-id wf_1 --run-id run_1",
        artifacts: "tychonic artifacts --workflow-id wf_1 --run-id run_1",
        logs: "tychonic logs --workflow-id wf_1 --run-id run_1",
        sessions: "tychonic sessions --workflow-id wf_1 --run-id run_1"
      },
      artifacts: [
        {
          id: "artifact_1",
          read_command: "tychonic artifacts --workflow-id wf_1 --run-id run_1 --artifact artifact_1"
        }
      ],
      logs: [
        {
          id: "attempt_1",
          state_name: "work",
          read_command: "tychonic logs --workflow-id wf_1 --run-id run_1 --attempt attempt_1"
        }
      ],
      timing: {
        run_ms: 1000,
        activity_ms: 0,
        non_activity_ms: 1000,
        activity_count: 0,
        by_kind: [],
        slowest_attempts: []
      }
    });
    expect(listLiveOutputAttemptViews(result, "wf_1", "run_1")[0]).not.toHaveProperty("command");
    expect(artifactContentPath(result, "artifact_1")).toBe(
      join(cwd, "tychonic-runs", "run_temporal_view", "artifacts", "worker-output.txt")
    );
    expect(liveOutputContentPath(result, "attempt_1")).toBe(
      join(cwd, "tychonic-runs", "run_temporal_view", "live", "attempt_1.log")
    );
  });

  it("rejects artifact paths outside the Tychonic artifact root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-result-view-escape-"));
    const result = fakeResult(cwd);
    result.run.artifacts[0] = {
      ...result.run.artifacts[0],
      path: "../outside.txt"
    };

    expect(() => artifactContentPath(result, "artifact_1")).toThrow(/stored path escapes/);
  });

  it("derives run timing from observed state and activity timestamps when run.updated_at is stale", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-result-view-timing-"));
    const result = fakeResult(cwd);
    result.run.updated_at = result.run.created_at;
    result.run.activity_attempts[0] = {
      ...result.run.activity_attempts[0],
      finished_at: "2026-04-19T00:00:05.000Z"
    };

    expect(workflowTimingView(result)).toMatchObject({
      run_ms: 5000,
      activity_ms: 5000,
      non_activity_ms: 0,
      activity_count: 1
    });
  });

  it("surfaces an active running state ahead of completed state history", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-result-view-active-"));
    const result = fakeResult(cwd);
    result.status = "running";
    result.run.status = "running";
    result.activeState = {
      id: "active_review",
      name: "review",
      status: "running",
      reason: "running review state 'review'",
      activity_attempt_ids: [],
      artifact_ids: [],
      finding_ids: [],
      started_at: "2026-04-19T00:00:02.000Z"
    };

    expect(workflowEvidenceView(result, "wf_1", "run_1").latest_state).toMatchObject({
      name: "review",
      status: "running"
    });
  });

  it("projects active and historical findings separately without dropping evidence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-result-view-findings-"));
    const result = fakeResult(cwd);
    result.run.states = [
      {
        id: "state_final_qa_1",
        name: "final_qa",
        status: "failed",
        reason: "review failed",
        activity_attempt_ids: [],
        artifact_ids: [],
        finding_ids: ["finding_new", "finding_resolved"],
        started_at: "2026-04-19T00:00:00.000Z",
        finished_at: "2026-04-19T00:00:01.000Z"
      }
    ];
    result.run.findings = [
      {
        id: "finding_new",
        status: "new",
        severity: "high",
        title: "Active finding",
        detail: "Still actionable.",
        source_state_id: "state_final_qa_1",
        created_at: "2026-04-19T00:00:01.000Z"
      },
      {
        id: "finding_resolved",
        status: "resolved",
        severity: "medium",
        title: "Resolved finding",
        detail: "Closed by the latest pass.",
        source_state_id: "state_final_qa_1",
        created_at: "2026-04-19T00:00:01.000Z"
      },
      {
        id: "finding_superseded",
        status: "superseded",
        severity: "low",
        title: "Superseded finding",
        detail: "Replaced by a later fail result.",
        source_state_id: "state_final_qa_1",
        created_at: "2026-04-19T00:00:01.000Z"
      }
    ];

    const view = workflowEvidenceView(result, "wf_1", "run_1");

    expect(view.counts).toMatchObject({
      findings: 3,
      active_findings: 1,
      historical_findings: 2
    });
    expect(view.findings.map((finding) => finding.id)).toEqual([
      "finding_new",
      "finding_resolved",
      "finding_superseded"
    ]);
    expect(view.active_findings.map((finding) => finding.id)).toEqual(["finding_new"]);
    expect(view.historical_findings.map((finding) => finding.id)).toEqual([
      "finding_resolved",
      "finding_superseded"
    ]);
  });

  it("projects stale active findings from an older same-gate pass as resolved", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-result-view-findings-pass-"));
    const result = fakeResult(cwd);
    result.run.status = "succeeded";
    result.run.states = [
      {
        id: "state_final_qa_1",
        name: "final_qa",
        status: "failed",
        reason: "review failed",
        activity_attempt_ids: ["attempt_final_qa_1"],
        artifact_ids: ["artifact_final_qa_1_parsed"],
        finding_ids: ["finding_1", "finding_2"],
        started_at: "2026-04-19T00:00:00.000Z",
        finished_at: "2026-04-19T00:00:01.000Z"
      },
      {
        id: "state_builder_1",
        name: "builder",
        status: "succeeded",
        reason: "builder fixed review findings",
        activity_attempt_ids: ["attempt_builder_1"],
        artifact_ids: ["artifact_builder_1"],
        finding_ids: [],
        started_at: "2026-04-19T00:00:02.000Z",
        finished_at: "2026-04-19T00:00:03.000Z"
      },
      {
        id: "state_final_qa_2",
        name: "final_qa",
        status: "succeeded",
        reason: "final QA passed",
        activity_attempt_ids: ["attempt_final_qa_2"],
        artifact_ids: ["artifact_final_qa_2_parsed"],
        finding_ids: [],
        started_at: "2026-04-19T00:00:04.000Z",
        finished_at: "2026-04-19T00:00:05.000Z"
      }
    ];
    result.run.artifacts = [
      parsedReviewArtifact("artifact_final_qa_1_parsed", "state_final_qa_1", "final_qa"),
      parsedReviewArtifact("artifact_final_qa_2_parsed", "state_final_qa_2", "final_qa")
    ];
    result.run.findings = [
      {
        id: "finding_1",
        status: "new",
        severity: "high",
        title: "First stale finding",
        detail: "Closed by final pass.",
        source_state_id: "state_final_qa_1",
        created_at: "2026-04-19T00:00:01.000Z"
      },
      {
        id: "finding_2",
        status: "new",
        severity: "medium",
        title: "Second stale finding",
        detail: "Closed by final pass.",
        source_state_id: "state_final_qa_1",
        created_at: "2026-04-19T00:00:01.000Z"
      }
    ];

    const view = workflowEvidenceView(result, "wf_1", "run_1");

    expect(view.counts).toMatchObject({
      findings: 2,
      active_findings: 0,
      historical_findings: 2
    });
    expect(view.findings.map((finding) => [finding.id, finding.status])).toEqual([
      ["finding_1", "resolved"],
      ["finding_2", "resolved"]
    ]);
    expect(view.warnings).toEqual([]);
  });

  it("projects stale active findings from an older same-gate fail as superseded", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-result-view-findings-fail-"));
    const result = fakeResult(cwd);
    result.run.states = [
      {
        id: "state_final_qa_1",
        name: "final_qa",
        status: "failed",
        reason: "first review failed",
        activity_attempt_ids: ["attempt_final_qa_1"],
        artifact_ids: ["artifact_final_qa_1_parsed"],
        finding_ids: ["finding_old"],
        started_at: "2026-04-19T00:00:00.000Z",
        finished_at: "2026-04-19T00:00:01.000Z"
      },
      {
        id: "state_builder_1",
        name: "builder",
        status: "succeeded",
        reason: "builder attempted fix",
        activity_attempt_ids: ["attempt_builder_1"],
        artifact_ids: ["artifact_builder_1"],
        finding_ids: [],
        started_at: "2026-04-19T00:00:02.000Z",
        finished_at: "2026-04-19T00:00:03.000Z"
      },
      {
        id: "state_final_qa_2",
        name: "final_qa",
        status: "failed",
        reason: "second review failed",
        activity_attempt_ids: ["attempt_final_qa_2"],
        artifact_ids: ["artifact_final_qa_2_parsed"],
        finding_ids: ["finding_new"],
        started_at: "2026-04-19T00:00:04.000Z",
        finished_at: "2026-04-19T00:00:05.000Z"
      }
    ];
    result.run.artifacts = [
      parsedReviewArtifact("artifact_final_qa_1_parsed", "state_final_qa_1", "final_qa"),
      parsedReviewArtifact("artifact_final_qa_2_parsed", "state_final_qa_2", "final_qa")
    ];
    result.run.findings = [
      {
        id: "finding_old",
        status: "new",
        severity: "high",
        title: "Old finding",
        detail: "Replaced by later final QA.",
        source_state_id: "state_final_qa_1",
        created_at: "2026-04-19T00:00:01.000Z"
      },
      {
        id: "finding_new",
        status: "new",
        severity: "medium",
        title: "Current finding",
        detail: "Still active.",
        source_state_id: "state_final_qa_2",
        created_at: "2026-04-19T00:00:05.000Z"
      }
    ];

    const view = workflowEvidenceView(result, "wf_1", "run_1");

    expect(view.counts).toMatchObject({
      findings: 2,
      active_findings: 1,
      historical_findings: 1
    });
    expect(view.findings.map((finding) => [finding.id, finding.status])).toEqual([
      ["finding_old", "superseded"],
      ["finding_new", "new"]
    ]);
    expect(view.active_findings.map((finding) => finding.id)).toEqual(["finding_new"]);
  });

  it("warns when a succeeded workflow still has active findings after projection", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-result-view-findings-warning-"));
    const result = fakeResult(cwd);
    result.run.status = "succeeded";
    result.run.states = [
      {
        id: "state_first_review_1",
        name: "first_review",
        status: "failed",
        reason: "first review failed",
        activity_attempt_ids: ["attempt_first_review_1"],
        artifact_ids: ["artifact_first_review_1_parsed"],
        finding_ids: ["finding_first_review"],
        started_at: "2026-04-19T00:00:00.000Z",
        finished_at: "2026-04-19T00:00:01.000Z"
      },
      {
        id: "state_final_qa_1",
        name: "final_qa",
        status: "succeeded",
        reason: "final QA passed",
        activity_attempt_ids: ["attempt_final_qa_1"],
        artifact_ids: ["artifact_final_qa_1_parsed"],
        finding_ids: [],
        started_at: "2026-04-19T00:00:02.000Z",
        finished_at: "2026-04-19T00:00:03.000Z"
      }
    ];
    result.run.artifacts = [
      parsedReviewArtifact("artifact_first_review_1_parsed", "state_first_review_1", "first_review"),
      parsedReviewArtifact("artifact_final_qa_1_parsed", "state_final_qa_1", "final_qa")
    ];
    result.run.findings = [
      {
        id: "finding_first_review",
        status: "new",
        severity: "high",
        title: "Unclosed first review finding",
        detail: "No later first_review pass closed this finding.",
        source_state_id: "state_first_review_1",
        created_at: "2026-04-19T00:00:01.000Z"
      }
    ];

    const view = workflowEvidenceView(result, "wf_1", "run_1");

    expect(view.counts.active_findings).toBe(1);
    expect(view.warnings).toContainEqual(
      expect.objectContaining({
        source: "projection",
        code: "succeeded_with_active_findings"
      })
    );
  });

  it("does not close same-name findings without parsed review result evidence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-result-view-findings-manual-"));
    const result = fakeResult(cwd);
    result.run.status = "succeeded";
    result.run.states = [
      {
        id: "state_manual_gate_1",
        name: "manual_gate",
        status: "failed",
        reason: "manual patch added a finding",
        activity_attempt_ids: [],
        artifact_ids: [],
        finding_ids: ["finding_manual"],
        started_at: "2026-04-19T00:00:00.000Z",
        finished_at: "2026-04-19T00:00:01.000Z"
      },
      {
        id: "state_manual_gate_2",
        name: "manual_gate",
        status: "succeeded",
        reason: "same-name state later succeeded without parsed review evidence",
        activity_attempt_ids: [],
        artifact_ids: [],
        finding_ids: [],
        started_at: "2026-04-19T00:00:02.000Z",
        finished_at: "2026-04-19T00:00:03.000Z"
      }
    ];
    result.run.artifacts = [];
    result.run.findings = [
      {
        id: "finding_manual",
        status: "new",
        severity: "high",
        title: "Manual finding",
        detail: "No parsed review verdict closed this finding.",
        source_state_id: "state_manual_gate_1",
        created_at: "2026-04-19T00:00:01.000Z"
      }
    ];

    const view = workflowEvidenceView(result, "wf_1", "run_1");

    expect(view.counts).toMatchObject({
      findings: 1,
      active_findings: 1,
      historical_findings: 0
    });
    expect(view.findings.map((finding) => [finding.id, finding.status])).toEqual([
      ["finding_manual", "new"]
    ]);
    expect(view.warnings).toContainEqual(
      expect.objectContaining({
        source: "projection",
        code: "succeeded_with_active_findings"
      })
    );
  });

  it("does not close same-name findings when the source state lacks parsed review evidence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-result-view-findings-source-unparsed-"));
    const result = fakeResult(cwd);
    result.run.status = "succeeded";
    result.run.states = [
      {
        id: "state_final_qa_1",
        name: "final_qa",
        status: "failed",
        reason: "finding was appended without parsed review evidence",
        activity_attempt_ids: [],
        artifact_ids: [],
        finding_ids: ["finding_unparsed_source"],
        started_at: "2026-04-19T00:00:00.000Z",
        finished_at: "2026-04-19T00:00:01.000Z"
      },
      {
        id: "state_final_qa_2",
        name: "final_qa",
        status: "succeeded",
        reason: "later parsed final QA passed",
        activity_attempt_ids: [],
        artifact_ids: ["artifact_final_qa_2_parsed"],
        finding_ids: [],
        started_at: "2026-04-19T00:00:02.000Z",
        finished_at: "2026-04-19T00:00:03.000Z"
      }
    ];
    result.run.artifacts = [
      parsedReviewArtifact("artifact_final_qa_2_parsed", "state_final_qa_2", "final_qa")
    ];
    result.run.findings = [
      {
        id: "finding_unparsed_source",
        status: "new",
        severity: "high",
        title: "Unparsed source finding",
        detail: "Source state has no parsed review artifact.",
        source_state_id: "state_final_qa_1",
        created_at: "2026-04-19T00:00:01.000Z"
      }
    ];

    const view = workflowEvidenceView(result, "wf_1", "run_1");

    expect(view.findings.map((finding) => [finding.id, finding.status])).toEqual([
      ["finding_unparsed_source", "new"]
    ]);
    expect(view.counts).toMatchObject({
      active_findings: 1,
      historical_findings: 0
    });
  });

  it("does not close same-name findings when the later state lacks parsed review evidence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-result-view-findings-later-unparsed-"));
    const result = fakeResult(cwd);
    result.run.status = "succeeded";
    result.run.states = [
      {
        id: "state_final_qa_1",
        name: "final_qa",
        status: "failed",
        reason: "parsed final QA failed",
        activity_attempt_ids: [],
        artifact_ids: ["artifact_final_qa_1_parsed"],
        finding_ids: ["finding_unparsed_later"],
        started_at: "2026-04-19T00:00:00.000Z",
        finished_at: "2026-04-19T00:00:01.000Z"
      },
      {
        id: "state_final_qa_2",
        name: "final_qa",
        status: "succeeded",
        reason: "later state was patched without parsed review evidence",
        activity_attempt_ids: [],
        artifact_ids: [],
        finding_ids: [],
        started_at: "2026-04-19T00:00:02.000Z",
        finished_at: "2026-04-19T00:00:03.000Z"
      }
    ];
    result.run.artifacts = [
      parsedReviewArtifact("artifact_final_qa_1_parsed", "state_final_qa_1", "final_qa")
    ];
    result.run.findings = [
      {
        id: "finding_unparsed_later",
        status: "new",
        severity: "high",
        title: "Unparsed later finding",
        detail: "Later state has no parsed review artifact.",
        source_state_id: "state_final_qa_1",
        created_at: "2026-04-19T00:00:01.000Z"
      }
    ];

    const view = workflowEvidenceView(result, "wf_1", "run_1");

    expect(view.findings.map((finding) => [finding.id, finding.status])).toEqual([
      ["finding_unparsed_later", "new"]
    ]);
    expect(view.counts).toMatchObject({
      active_findings: 1,
      historical_findings: 0
    });
  });
});

function parsedReviewArtifact(id: string, stateId: string, stateName: string) {
  return {
    id,
    kind: `${stateName}_parsed`,
    path: `artifacts/${id}.json`,
    state_id: stateId,
    created_at: "2026-04-19T00:00:01.000Z"
  };
}

function fakeResult(cwd: string): TychonicWorkflowResult {
  return {
    runId: "run_temporal_view",
    status: "waiting_user",
    artifactRoot: join(cwd, "tychonic-runs", "run_temporal_view"),
    worktreePath: join("/tmp", "tychonic-worktree-run_temporal_view-fixture", "worktree"),
    run: {
      schema_version: "tychonic.run.v1",
      id: "run_temporal_view",
      template: "simple_workflow",
      status: "waiting_user",
      goal: "inspect Temporal result",
      cwd,
      artifact_root: join(cwd, "tychonic-runs", "run_temporal_view"),
      created_at: "2026-04-19T00:00:00.000Z",
      updated_at: "2026-04-19T00:00:01.000Z",
      states: [
        {
          id: "state_1",
          name: "work",
          status: "succeeded",
          reason: "worker succeeded",
          activity_attempt_ids: ["attempt_1", "attempt_2"],
          artifact_ids: ["artifact_1"],
          finding_ids: [],
          started_at: "2026-04-19T00:00:00.000Z",
          finished_at: "2026-04-19T00:00:01.000Z"
        }
      ],
      activity_attempts: [
        {
          id: "attempt_1",
          state_id: "state_1",
          kind: "work",
          status: "succeeded",
          reason: "done",
          command: "codex exec --json",
          cwd,
          exit_code: 0,
          agent_session_id: "session_1",
          started_at: "2026-04-19T00:00:00.000Z",
          live_output_path: "live/attempt_1.log"
        },
        {
          id: "attempt_2",
          state_id: "state_1",
          kind: "deterministic_command",
          status: "succeeded",
          reason: "reset done",
          command: "git clean -fdx",
          cwd,
          exit_code: 0,
          started_at: "2026-04-19T00:00:00.500Z"
        }
      ],
      agent_sessions: [
        {
          id: "session_1",
          agent: "codex",
          role: "worker",
          cwd,
          status: "succeeded",
          started_at: "2026-04-19T00:00:00.000Z"
        }
      ],
      artifacts: [
        {
          id: "artifact_1",
          kind: "worker_output",
          path: "artifacts/worker-output.txt",
          created_at: "2026-04-19T00:00:00.000Z"
        }
      ],
      findings: [],
      inbox: [
        {
          id: "inbox_1",
          status: "open",
          title: "Continue work",
          detail: "Review failed",
          action: { kind: "triage", reason: "needs Temporal update" },
          created_at: "2026-04-19T00:00:00.000Z"
        }
      ]
    }
  };
}
