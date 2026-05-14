import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TychonicConfig } from "../src/catalog/types.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";

describe("activity heartbeat wiring", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock("../src/bootstrap/workerActivityBody.js");
  });

  it("passes heartbeat into runWorkerActivity bodies", async () => {
    const captured = { heartbeat: undefined as unknown };
    vi.doMock("../src/bootstrap/workerActivityBody.js", () => ({
      runWorkerActivityBody: vi.fn(async (options: { resources: { heartbeat?: unknown } }) => {
        captured.heartbeat = options.resources.heartbeat;
        return executedResult();
      })
    }));

    const { runWorkerActivity } = await import("../src/activities/runWorkerActivity.js");
    await runWorkerActivity({
      stateName: "work_alt",
      run: baseRun("run_worker_heartbeat"),
      cwd: await mkdtemp(join(tmpdir(), "tychonic-worker-heartbeat-")),
      profile: profileWith("work_alt", "work"),
      worktreePath: await mkdtemp(join(tmpdir(), "tychonic-worker-heartbeat-wt-"))
    });

    expect(captured.heartbeat).toEqual(expect.any(Function));
  });

  it("passes heartbeat into runWorkerActivity resume-mode bodies", async () => {
    const captured = { heartbeat: undefined as unknown };
    vi.doMock("../src/bootstrap/workerActivityBody.js", () => ({
      runWorkerActivityBody: vi.fn(async (options: { resources: { heartbeat?: unknown } }) => {
        captured.heartbeat = options.resources.heartbeat;
        return executedResult();
      })
    }));

    const { runWorkerActivity } = await import("../src/activities/runWorkerActivity.js");
    await runWorkerActivity({
      stateName: "resume_alt",
      run: baseRun("run_resume_heartbeat", {
        sessionId: "sess_1"
      }),
      cwd: await mkdtemp(join(tmpdir(), "tychonic-resume-heartbeat-")),
      profile: profileWith("resume_alt", "work"),
      worktreePath: await mkdtemp(join(tmpdir(), "tychonic-resume-heartbeat-wt-")),
      sessionId: "sess_1"
    });

    expect(captured.heartbeat).toEqual(expect.any(Function));
  });

  it("passes heartbeat into runVerifyActivity bodies", async () => {
    const captured = { heartbeat: undefined as unknown };
    vi.doMock("../src/bootstrap/deterministicCommandBody.js", () => ({
      runDeterministicCommandBody: vi.fn(async (options: { resources: { heartbeat?: unknown } }) => {
        captured.heartbeat = options.resources.heartbeat;
        return executedResult();
      })
    }));

    const { runVerifyActivity } = await import("../src/activities/runVerifyActivity.js");
    await runVerifyActivity({
      stateName: "verify_alt",
      run: baseRun("run_verify_heartbeat"),
      cwd: await mkdtemp(join(tmpdir(), "tychonic-verify-heartbeat-")),
      profile: profileWith("verify_alt", "verify")
    });

    expect(captured.heartbeat).toEqual(expect.any(Function));
  });

});

function profileWith(name: string, type: "work" | "verify"): TychonicConfig {
  return {
    version: "tychonic.config.v1",
    states: {
      [name]: {
        type,
        command: "node -e \"console.log('ok')\""
      }
    }
  };
}

function baseRun(
  id: string,
  session?: {
    sessionId: string;
  }
): WorkflowRunRecord {
  return {
    schema_version: "tychonic.run.v1",
    id,
    template: "simple_workflow",
    status: "running",
    cwd: "/ignored",
    artifact_root: join(tmpdir(), "tychonic-test-runs", id),
    created_at: "2026-04-19T00:00:00.000Z",
    updated_at: "2026-04-19T00:00:00.000Z",
    states: [],
    activity_attempts: [],
    agent_sessions: session
      ? [
          {
            id: session.sessionId,
            agent: "codex",
            role: "worker",
            cwd: "/ignored",
            status: "succeeded",
            resumable: true,
            started_at: "2026-04-19T00:00:00.000Z",
            finished_at: "2026-04-19T00:00:10.000Z"
          }
        ]
      : [],
    artifacts: [],
    findings: [],
    inbox: []
  };
}

function executedResult() {
  return {
    delta: {
      states: [],
      activityAttempts: []
    },
    workerOutcome: {
      kind: "executed" as const,
      status: "succeeded" as const,
      artifacts: [],
      agentSessions: []
    }
  };
}
