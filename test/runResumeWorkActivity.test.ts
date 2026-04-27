import { chmod, mkdtemp, writeFile } from "node:fs/promises";
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
    const restorePath = await installFakeCodex();

    let result;
    try {
      result = await runResumeWorkActivity({
        stateName: ACTIVITY_NAME,
        run,
        cwd,
        profile: profileWith(),
        worktreePath,
        prompt: "continue please",
        sessionId: "sess_1"
      });
    } finally {
      restorePath();
    }

    expect(run).toEqual(runBefore);
    expect(result.delta.states?.[0]?.status).toBe("succeeded");
    expect(result.delta.activityAttempts?.[0]?.kind).toBe("resume_work");
    expect(result.delta.activityAttempts?.[0]?.agent_session_id).toBe("sess_1");
    if (result.workerOutcome?.kind !== "executed") throw new Error("expected executed outcome");
    expect(result.workerOutcome.resumedSessionId).toBe("sess_1");
    expect(result.workerOutcome.agentSessions).toHaveLength(0);
  });

  it("throws ApplicationFailure when the referenced session is not resumable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-resume-nores-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-run-resume-wt2-"));
    const run = baseRunWithSession("run_resume_nores", "sess_nores", { resumable: false });

    await expect(
      runResumeWorkActivity({
        stateName: ACTIVITY_NAME,
        run,
        cwd,
        profile: profileWith(),
        worktreePath,
        sessionId: "sess_nores"
      })
    ).rejects.toThrow(/not resumable/);
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
        worktreePath,
        sessionId: "sess_missing"
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
  options: { resumable?: boolean } = {}
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
        ...(options.resumable === false ? {} : { resumable: true }),
        started_at: "2026-04-19T00:00:00.000Z",
        finished_at: "2026-04-19T00:00:10.000Z"
      }
    ],
    artifacts: [],
    findings: [],
    inbox: []
  };
}

async function installFakeCodex(): Promise<() => void> {
  const binDir = await mkdtemp(join(tmpdir(), "tychonic-fake-codex-"));
  const binPath = join(binDir, "codex");
  await writeFile(binPath, "#!/bin/sh\necho '{\"session_id\":\"external-session-1\"}'\n", "utf8");
  await chmod(binPath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  return () => {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  };
}
