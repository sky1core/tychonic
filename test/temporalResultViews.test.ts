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
      run_id: "run_temporal_view",
      template: "simple_workflow",
      status: "waiting_user",
      goal: "inspect Temporal result"
    });
    expect(listArtifacts(result).map((artifact) => artifact.id)).toEqual(["artifact_1"]);
    expect(listLiveOutputAttempts(result).map((attempt) => attempt.id)).toEqual(["attempt_1"]);
    expect(listInboxItems(result).map((item) => item.id)).toEqual(["inbox_1"]);
    expect(listAgentSessions(result, 1).map((session) => session.id)).toEqual(["session_1"]);
    expect(workflowEvidenceView(result, "wf_1", "run_1")).toMatchObject({
      run_id: "run_temporal_view",
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
      join(cwd, ".tychonic", "runs", "run_temporal_view", "artifacts", "worker-output.txt")
    );
    expect(liveOutputContentPath(result, "attempt_1")).toBe(
      join(cwd, ".tychonic", "runs", "run_temporal_view", "live", "attempt_1.log")
    );
  });

  it("rejects artifact paths outside the Tychonic artifact root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-result-view-escape-"));
    const result = fakeResult(cwd);
    result.run.artifacts[0] = {
      ...result.run.artifacts[0],
      path: "../outside.txt"
    };

    expect(() => artifactContentPath(result, "artifact_1")).toThrow("stored path escapes Tychonic root");
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
});

function fakeResult(cwd: string): TychonicWorkflowResult {
  return {
    runId: "run_temporal_view",
    status: "waiting_user",
    artifactRoot: join(cwd, ".tychonic", "runs", "run_temporal_view"),
    worktreePath: join(cwd, ".tychonic", "worktrees", "run_temporal_view"),
    run: {
      schema_version: "tychonic.run.v1",
      id: "run_temporal_view",
      template: "simple_workflow",
      status: "waiting_user",
      goal: "inspect Temporal result",
      cwd,
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
          live_output_path: ".tychonic/runs/run_temporal_view/live/attempt_1.log"
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
          path: ".tychonic/runs/run_temporal_view/artifacts/worker-output.txt",
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
