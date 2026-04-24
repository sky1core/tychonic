import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runWorkerActivity } from "../src/activities/runWorkerActivity.js";
import type { TychonicConfig } from "../src/catalog/types.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";

const ACTIVITY_NAME = "work_alt";

describe("runWorkerActivity", () => {
  it("runs a worker command, returns one state/attempt, and does not mutate input.run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-worker-pass-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-run-worker-wt-"));
    const run = baseRun("run_worker_pass");
    const runBefore = structuredClone(run);

    const result = await runWorkerActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileWith("node -e \"console.log('worker ok')\""),
      extras: { worktreePath, prompt: "do the thing" }
    });

    expect(run).toEqual(runBefore);
    expect(result.delta.states).toHaveLength(1);
    expect(result.delta.states?.[0]?.name).toBe(ACTIVITY_NAME);
    expect(result.delta.states?.[0]?.status).toBe("succeeded");
    expect(result.delta.activityAttempts?.[0]?.kind).toBe("work");
    expect(result.delta.activityAttempts?.[0]?.cwd).toBe(worktreePath);
    if (result.workerOutcome?.kind !== "executed") throw new Error("expected executed outcome");
    expect(result.workerOutcome.status).toBe("succeeded");
    expect(result.workerOutcome.artifacts.map((a) => a.kind)).toEqual([
      `${ACTIVITY_NAME}_prompt`,
      `${ACTIVITY_NAME}_output`
    ]);
    expect(result.workerOutcome.agentSessions).toHaveLength(1);
    expect(result.workerOutcome.agentSessions[0]?.role).toBe("worker");
    expect(result.workerOutcome.agentSessions[0]?.status).toBe("succeeded");
    expect(result.workerOutcome.resumedSessionId).toBeUndefined();
  });

  it("finalizes state.status as 'failed' when the worker command exits non-zero", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-worker-fail-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-run-worker-wt2-"));

    const result = await runWorkerActivity({
      stateName: ACTIVITY_NAME,
      run: baseRun("run_worker_fail"),
      cwd,
      profile: profileWith("node -e \"process.exit(1)\""),
      extras: { worktreePath, prompt: "" }
    });

    expect(result.delta.states?.[0]?.status).toBe("failed");
    if (result.workerOutcome?.kind !== "executed") throw new Error("expected executed outcome");
    expect(result.workerOutcome.status).toBe("failed");
    expect(result.workerOutcome.agentSessions[0]?.status).toBe("failed");
  });

  it("throws ApplicationFailure when profile block is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-worker-missing-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-run-worker-wt3-"));
    await expect(
      runWorkerActivity({
        stateName: "does_not_exist",
        run: baseRun("run_worker_missing"),
        cwd,
        profile: { version: "tychonic.config.v1" },
        extras: { worktreePath }
      })
    ).rejects.toThrow(/does_not_exist/);
  });

  it("throws ApplicationFailure when extras.worktreePath is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-worker-no-wt-"));
    await expect(
      runWorkerActivity({
        stateName: ACTIVITY_NAME,
        run: baseRun("run_worker_no_wt"),
        cwd,
        profile: profileWith("echo"),
        extras: {}
      })
    ).rejects.toThrow(/worktreePath/);
  });

  it("fails when the work activity omits command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-worker-command-missing-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-run-worker-wt-command-missing-"));

    await expect(
      runWorkerActivity({
        stateName: ACTIVITY_NAME,
        run: baseRun("run_worker_command_missing"),
        cwd,
        profile: {
          version: "tychonic.config.v1",
          states: {
            [ACTIVITY_NAME]: {
              type: "work",
              agent: "codex"
            }
          }
        },
        extras: { worktreePath, prompt: "make the requested change" }
      })
    ).rejects.toThrow(/requires a command/);
  });
});

function profileWith(command: string): TychonicConfig {
  return {
    version: "tychonic.config.v1",
    states: {
      [ACTIVITY_NAME]: {
        type: "work",
        agent: "codex",
        command
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
