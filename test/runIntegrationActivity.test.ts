import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runIntegrationActivity } from "../src/activities/runIntegrationActivity.js";
import type { TychonicConfig } from "../src/catalog/types.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";

const ACTIVITY_NAME = "integration_alt";

describe("runIntegrationActivity", () => {
  it("looks up the activity block by input.name and does not mutate input.run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-integration-pass-"));
    const run = baseRun("run_integration_pass");
    const runBefore = structuredClone(run);

    const result = await runIntegrationActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileWith("node -e \"console.log('integration ok')\""),
      extras: {}
    });

    expect(run).toEqual(runBefore);
    expect(result.delta.states[0]?.name).toBe(ACTIVITY_NAME);
    expect(result.delta.states[0]?.status).toBe("succeeded");
    expect(result.commandOutcome?.artifact.kind).toBe(`${ACTIVITY_NAME}_output`);
  });

  it("throws ApplicationFailure when profile block is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-integration-missing-"));
    await expect(
      runIntegrationActivity({
        stateName: "missing",
        run: baseRun("run_integration_missing"),
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
      [ACTIVITY_NAME]: { type: "integration", command }
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
