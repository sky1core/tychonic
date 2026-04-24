import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runResumeWorkActivity } from "../src/activities/runResumeWorkActivity.js";
import type { TychonicConfig } from "../src/catalog/types.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";

const ACTIVITY_NAME = "resume_alt";

describe("runResumeWorkActivity", () => {
  it("resumes an existing worker session and does not mutate input.run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-resume-pass-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-run-resume-wt-"));
    const run = baseRunWithSession("run_resume_pass", "sess_1");
    const runBefore = structuredClone(run);

    const result = await runResumeWorkActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileWith(),
      extras: { worktreePath, prompt: "continue please", sessionId: "sess_1" }
    });

    expect(run).toEqual(runBefore);
    expect(result.delta.states?.[0]?.status).toBe("succeeded");
    expect(result.delta.activityAttempts?.[0]?.kind).toBe("resume_work");
    expect(result.delta.activityAttempts?.[0]?.agent_session_id).toBe("sess_1");
    if (result.workerOutcome?.kind !== "executed") throw new Error("expected executed outcome");
    expect(result.workerOutcome.resumedSessionId).toBe("sess_1");
    expect(result.workerOutcome.agentSessions).toHaveLength(0);
  });

  it("throws ApplicationFailure when the referenced session has no resume_command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-resume-nores-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-run-resume-wt2-"));
    const run = baseRunWithSession("run_resume_nores", "sess_nores", { omitResumeCommand: true });

    await expect(
      runResumeWorkActivity({
        stateName: ACTIVITY_NAME,
        run,
        cwd,
        profile: profileWith(),
        extras: { worktreePath, sessionId: "sess_nores" }
      })
    ).rejects.toThrow(/resume_command/);
  });

  it("throws ApplicationFailure when the session id is not in run.agent_sessions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-resume-404-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-run-resume-wt3-"));

    await expect(
      runResumeWorkActivity({
        stateName: ACTIVITY_NAME,
        run: baseRunWithSession("run_resume_404", "sess_other"),
        cwd,
        profile: profileWith(),
        extras: { worktreePath, sessionId: "sess_missing" }
      })
    ).rejects.toThrow(/sess_missing/);
  });
});

function profileWith(): TychonicConfig {
  return {
    version: "tychonic.config.v1",
    states: {
      [ACTIVITY_NAME]: {
        type: "work",
        agent: "codex"
      }
    }
  };
}

function baseRunWithSession(
  id: string,
  sessionId: string,
  options: { omitResumeCommand?: boolean } = {}
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
    agent_sessions: [
      {
        id: sessionId,
        agent: "codex",
        role: "worker",
        cwd: "/ignored",
        status: "succeeded",
        ...(options.omitResumeCommand
          ? {}
          : { resume_command: "node -e \"console.log('resumed ok')\"" }),
        started_at: "2026-04-19T00:00:00.000Z",
        finished_at: "2026-04-19T00:00:10.000Z"
      }
    ],
    artifacts: [],
    findings: [],
    inbox: []
  };
}
