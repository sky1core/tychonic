import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runLintActivity } from "../src/activities/runLintActivity.js";
import type { TychonicConfig } from "../src/catalog/types.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";

const ACTIVITY_NAME = "lint_alt";

describe("runLintActivity", () => {
  it("looks up the activity block by input.name and does not mutate input.run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-lint-pass-"));
    const run = baseRun("run_lint_pass");
    const runBefore = structuredClone(run);

    const result = await runLintActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileWith("node -e \"console.log('lint ok')\"")
    });

    expect(run).toEqual(runBefore);
    expect(result.delta.states).toHaveLength(1);
    expect(result.delta.states[0]?.name).toBe(ACTIVITY_NAME);
    expect(result.delta.states[0]?.status).toBe("succeeded");
    expect(result.delta.activityAttempts).toHaveLength(1);
    expect(result.delta.activityAttempts?.[0]?.kind).toBe("deterministic_command");
    expect(result.commandOutcome?.artifact.kind).toBe(`${ACTIVITY_NAME}_output`);
    expect(result.commandOutcome?.artifact.activity_attempt_id).toBe(result.delta.activityAttempts?.[0]?.id);
  });

  it("finalizes state.status as 'failed' when the command exits non-zero", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-lint-fail-"));
    const run = baseRun("run_lint_fail");

    const result = await runLintActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileWith("node -e \"process.stderr.write('boom'); process.exit(1)\"")
    });

    expect(result.delta.states[0]?.status).toBe("failed");
    expect(result.commandOutcome?.artifact).toBeDefined();
  });

  it("throws ApplicationFailure when profile block is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-lint-missing-"));
    await expect(
      runLintActivity({
        stateName: "does_not_exist",
        run: baseRun("run_lint_missing"),
        cwd,
        profile: { version: "tychonic.config.v1" }
      })
    ).rejects.toThrow(/does_not_exist/);
  });

  it("rejects an unvalidated lint profile block before command execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-lint-no-cmd-"));
    await expect(
      runLintActivity({
        stateName: ACTIVITY_NAME,
        run: baseRun("run_lint_no_cmd"),
        cwd,
        profile: {
          version: "tychonic.config.v1",
          states: { [ACTIVITY_NAME]: { type: "lint" } }
        }
      })
    ).rejects.toThrow(/profile\.states\.lint_alt failed schema validation/);
  });

  it("runs in worktreePath while keeping artifacts under the project root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-lint-root-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-run-lint-worktree-"));
    const run = baseRun("run_lint_worktree");

    const result = await runLintActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileWith("node -e \"require('node:fs').writeFileSync('lint-cwd.txt', process.cwd())\""),
      worktreePath
    });
    const canonicalWorktreePath = await realpath(worktreePath);

    expect(result.delta.activityAttempts?.[0]?.cwd).toBe(worktreePath);
    expect(await readFile(join(worktreePath, "lint-cwd.txt"), "utf8")).toBe(canonicalWorktreePath);
    expect(result.commandOutcome?.artifact.path).toContain(`.tychonic/runs/${run.id}/artifacts/`);
    expect(result.commandOutcome?.artifact.path).not.toContain("/worktrees/");
  });
});

function profileWith(command: string): TychonicConfig {
  return {
    version: "tychonic.config.v1",
    states: {
      [ACTIVITY_NAME]: {
        type: "lint",
        command
      }
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
