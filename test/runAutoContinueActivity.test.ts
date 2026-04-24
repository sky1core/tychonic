import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAutoContinueActivity } from "../src/activities/runAutoContinueActivity.js";
import type { TychonicConfig } from "../src/catalog/types.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";

const ACTIVITY_NAME = "auto_alt";

describe("runAutoContinueActivity", () => {
  it("runs fresh mode when no sessionId is provided", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-auto-fresh-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-run-auto-fresh-wt-"));
    const run = baseRun("run_auto_fresh");
    const runBefore = structuredClone(run);

    const result = await runAutoContinueActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileFresh("node -e \"console.log('auto fresh ok')\""),
      extras: { worktreePath, prompt: "continue" }
    });

    expect(run).toEqual(runBefore);
    expect(result.delta.states?.[0]?.status).toBe("succeeded");
    expect(result.delta.activityAttempts?.[0]?.kind).toBe("work");
    if (result.workerOutcome?.kind !== "executed") throw new Error("expected executed outcome");
    expect(result.workerOutcome.resumedSessionId).toBeUndefined();
    expect(result.workerOutcome.agentSessions).toHaveLength(1);
  });

  it("runs resume mode when sessionId is provided", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-auto-resume-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-run-auto-resume-wt-"));
    const run = baseRunWithSession("run_auto_resume", "sess_auto");

    const result = await runAutoContinueActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileResume(),
      extras: { worktreePath, prompt: "resume please", sessionId: "sess_auto" }
    });

    expect(result.delta.states?.[0]?.status).toBe("succeeded");
    expect(result.delta.activityAttempts?.[0]?.kind).toBe("resume_work");
    if (result.workerOutcome?.kind !== "executed") throw new Error("expected executed outcome");
    expect(result.workerOutcome.resumedSessionId).toBe("sess_auto");
  });

  it("throws ApplicationFailure when neither sessionId nor command is available", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-auto-empty-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-run-auto-empty-wt-"));

    await expect(
      runAutoContinueActivity({
        stateName: ACTIVITY_NAME,
        run: baseRun("run_auto_empty"),
        cwd,
        profile: profileNoCommand(),
        extras: { worktreePath }
      })
    ).rejects.toThrow(/sessionId.*resume.*command/);
  });
});

function profileFresh(command: string): TychonicConfig {
  return {
    version: "tychonic.config.v1",
    states: {
      [ACTIVITY_NAME]: {
        type: "auto_continue",
        agent: "codex",
        command
      }
    }
  };
}

function profileResume(): TychonicConfig {
  return {
    version: "tychonic.config.v1",
    states: {
      [ACTIVITY_NAME]: {
        type: "auto_continue",
        agent: "codex"
      }
    }
  };
}

function profileNoCommand(): TychonicConfig {
  return {
    version: "tychonic.config.v1",
    states: {
      [ACTIVITY_NAME]: {
        type: "auto_continue",
        agent: "codex"
      }
    }
  };
}

function baseRun(id: string): WorkflowRunRecord {
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
    agent_sessions: [],
    artifacts: [],
    findings: [],
    inbox: []
  };
}

function baseRunWithSession(id: string, sessionId: string): WorkflowRunRecord {
  return {
    ...baseRun(id),
    agent_sessions: [
      {
        id: sessionId,
        agent: "codex",
        role: "worker",
        cwd: "/ignored",
        status: "succeeded",
        resume_command: "node -e \"console.log('resumed ok')\"",
        started_at: "2026-04-19T00:00:00.000Z",
        finished_at: "2026-04-19T00:00:10.000Z"
      }
    ]
  };
}
