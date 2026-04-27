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

  it("passes heartbeat into runResumeWorkActivity bodies", async () => {
    const captured = { heartbeat: undefined as unknown };
    vi.doMock("../src/bootstrap/workerActivityBody.js", () => ({
      runWorkerActivityBody: vi.fn(async (options: { resources: { heartbeat?: unknown } }) => {
        captured.heartbeat = options.resources.heartbeat;
        return executedResult();
      })
    }));

    const { runResumeWorkActivity } = await import("../src/activities/runResumeWorkActivity.js");
    await runResumeWorkActivity({
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

  it("passes heartbeat into runAutoContinueActivity bodies in both fresh and resume modes", async () => {
    const captured: unknown[] = [];
    vi.doMock("../src/bootstrap/workerActivityBody.js", () => ({
      runWorkerActivityBody: vi.fn(async (options: { resources: { heartbeat?: unknown } }) => {
        captured.push(options.resources.heartbeat);
        return executedResult();
      })
    }));

    const { runAutoContinueActivity } = await import("../src/activities/runAutoContinueActivity.js");
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-auto-heartbeat-"));

    await runAutoContinueActivity({
      stateName: "auto_alt",
      run: baseRun("run_auto_fresh_heartbeat"),
      cwd,
      profile: profileWith("auto_alt", "auto_continue"),
      worktreePath: await mkdtemp(join(tmpdir(), "tychonic-auto-heartbeat-wt1-"))
    });

    await runAutoContinueActivity({
      stateName: "auto_alt",
      run: baseRun("run_auto_resume_heartbeat", {
        sessionId: "sess_auto"
      }),
      cwd,
      profile: profileWith("auto_alt", "auto_continue"),
      worktreePath: await mkdtemp(join(tmpdir(), "tychonic-auto-heartbeat-wt2-")),
      sessionId: "sess_auto"
    });

    expect(captured).toHaveLength(2);
    expect(captured[0]).toEqual(expect.any(Function));
    expect(captured[1]).toEqual(expect.any(Function));
  });
});

function profileWith(name: string, type: "work" | "auto_continue"): TychonicConfig {
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
