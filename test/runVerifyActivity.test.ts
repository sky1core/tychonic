import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runVerifyActivity } from "../src/activities/runVerifyActivity.js";
import type { TychonicConfig } from "../src/catalog/types.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";

const ACTIVITY_NAME = "verify_alt";

describe("runVerifyActivity", () => {
  it("looks up the activity block by input.name and does not mutate input.run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-verify-pass-"));
    const run = baseRun("run_verify_pass");
    const runBefore = structuredClone(run);

    const result = await runVerifyActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileWith("node -e \"console.log('verify ok')\""),
      extras: {}
    });

    expect(run).toEqual(runBefore);
    expect(result.delta.states[0]?.name).toBe(ACTIVITY_NAME);
    expect(result.delta.states[0]?.status).toBe("succeeded");
    expect(result.commandOutcome?.artifact.kind).toBe(`${ACTIVITY_NAME}_output`);
  });

  it("uses extras.worktreePath as the execution cwd when provided", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-verify-cwd-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-run-verify-wt-"));
    const run = baseRun("run_verify_cwd");

    const result = await runVerifyActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileWith("node -e \"process.stdout.write(process.cwd())\""),
      extras: { worktreePath }
    });

    expect(result.commandOutcome?.artifact).toBeDefined();
    expect(result.delta.activityAttempts?.[0]?.cwd).toBe(worktreePath);
  });

  it("throws ApplicationFailure when profile block is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-verify-missing-"));
    await expect(
      runVerifyActivity({
        stateName: "missing",
        run: baseRun("run_verify_missing"),
        cwd,
        profile: { version: "tychonic.config.v1" },
        extras: {}
      })
    ).rejects.toThrow(/missing/);
  });
});

function profileWith(command: string): TychonicConfig {
  return {
    version: "tychonic.config.v1",
    states: {
      [ACTIVITY_NAME]: { type: "verify", command }
    }
  };
}

function baseRun(id: string): WorkflowRunRecord {
  return {
    schema_version: "tychonic.run.v1",
    id,
    template: "checkpoint",
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
