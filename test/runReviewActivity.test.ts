import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runReviewActivity } from "../src/activities/runReviewActivity.js";
import type { TychonicConfig } from "../src/catalog/types.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";

const ACTIVITY_NAME = "review_alt";
const execFileAsync = promisify(execFile);

describe("runReviewActivity", () => {
  it("returns parsed outcome on verdict=pass without mutating input.run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-review-pass-"));
    const run = baseRun("run_review_pass");
    const runBefore = structuredClone(run);

    const result = await runReviewActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileWith({
        command:
          "node -e \"console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'ok',findings:[]}))\""
      }),
      prompt: "please review"
    });

    expect(run).toEqual(runBefore);
    expect(result.reviewOutcome?.kind).toBe("parsed");
    if (result.reviewOutcome?.kind !== "parsed") throw new Error("unreachable");
    expect(result.reviewOutcome.result.status).toBe("pass");
    expect(result.delta.states).toHaveLength(1);
    expect(result.delta.states[0]?.name).toBe(ACTIVITY_NAME);
    expect(result.delta.states[0]?.status).toBe("succeeded");
    expect(result.reviewOutcome.artifacts.map((a) => a.kind)).toEqual([
      `${ACTIVITY_NAME}_prompt`,
      `${ACTIVITY_NAME}_output`,
      `${ACTIVITY_NAME}_parsed`
    ]);
    expect(result.reviewOutcome.agentSessions).toHaveLength(1);
    expect(result.reviewOutcome.agentSessions[0]?.id).toBe(result.reviewOutcome.reviewerSessionId);
  });

  it("returns parsed outcome with step=failed on verdict=fail", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-review-fail-"));
    const run = baseRun("run_review_fail");

    const result = await runReviewActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileWith({
        command:
          "node -e \"console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'fail',summary:'needs fix',findings:[{title:'x',severity:'high',detail:'d',target:'src/a.ts'}]}))\""
      }),
      prompt: "please review"
    });

    expect(result.reviewOutcome?.kind).toBe("parsed");
    if (result.reviewOutcome?.kind !== "parsed") throw new Error("unreachable");
    expect(result.reviewOutcome.result.status).toBe("fail");
    expect(result.reviewOutcome.result.findings).toHaveLength(1);
    expect(result.delta.states[0]?.status).toBe("failed");
  });

  it("returns unparseable outcome with step=blocked when output is malformed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-review-unparse-"));
    const run = baseRun("run_review_unparse");

    const result = await runReviewActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileWith({
        command: "node -e \"console.log('not a tychonic.review.v1 payload')\""
      }),
      prompt: "please review"
    });

    expect(result.reviewOutcome?.kind).toBe("unparseable");
    if (result.reviewOutcome?.kind !== "unparseable") throw new Error("unreachable");
    expect(result.delta.states[0]?.status).toBe("blocked");
    expect(result.reviewOutcome.artifacts.map((a) => a.kind)).toEqual([
      `${ACTIVITY_NAME}_prompt`,
      `${ACTIVITY_NAME}_output`
    ]);
    expect(result.reviewOutcome.agentSessions).toHaveLength(1);
  });

  it("treats command reviewer semantic-only JSON as unparseable because commands must emit the wire contract", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-review-command-semantic-"));
    const run = baseRun("run_review_command_semantic");

    const result = await runReviewActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileWith({
        command: "node -e \"console.log(JSON.stringify({status:'pass',summary:'ok',findings:[]}))\""
      }),
      prompt: "please review"
    });

    expect(result.reviewOutcome?.kind).toBe("unparseable");
    if (result.reviewOutcome?.kind !== "unparseable") throw new Error("unreachable");
    expect(result.delta.states[0]?.status).toBe("blocked");
  });

  it("treats command reviewer adapter envelopes as unparseable because commands must emit the wire contract directly", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-review-command-envelope-"));
    const run = baseRun("run_review_command_envelope");

    const result = await runReviewActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileWith({
        command:
          "node -e \"console.log(JSON.stringify({type:'result',result:'ok',structured_output:{status:'pass',summary:'ok',findings:[]}}))\""
      }),
      prompt: "please review"
    });

    expect(result.reviewOutcome?.kind).toBe("unparseable");
    if (result.reviewOutcome?.kind !== "unparseable") throw new Error("unreachable");
    expect(result.delta.states[0]?.status).toBe("blocked");
  });

  it("returns command_failed outcome with prompt/output artifacts when the reviewer command fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-review-failcmd-"));
    const run = baseRun("run_review_failcmd");

    const result = await runReviewActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileWith({
        command: "node -e \"process.exit(9)\""
      }),
      prompt: "please review"
    });

    expect(result.reviewOutcome?.kind).toBe("command_failed");
    if (result.reviewOutcome?.kind !== "command_failed") throw new Error("unreachable");
    expect(result.delta.states[0]?.status).toBe("failed");
    expect(result.delta.activityAttempts?.[0]?.status).toBe("failed");
    expect(result.reviewOutcome.artifacts.map((a) => a.kind)).toEqual([
      `${ACTIVITY_NAME}_prompt`,
      `${ACTIVITY_NAME}_output`
    ]);
    expect(result.reviewOutcome.agentSessions).toHaveLength(1);
    expect(result.reviewOutcome.agentSessions[0]?.status).toBe("failed");
  });

  it("returns skipped outcome when the named activity block is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-review-missing-"));
    const run = baseRun("run_review_missing");

    const result = await runReviewActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: { version: "tychonic.config.v1" },
      prompt: "please review"
    });

    expect(result.reviewOutcome?.kind).toBe("skipped");
    expect(result.delta.states?.[0]?.status).toBe("skipped");
  });

  it("throws ApplicationFailure when prompt is empty", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-review-noprompt-"));
    const run = baseRun("run_review_noprompt");

    await expect(
      runReviewActivity({
        stateName: ACTIVITY_NAME,
        run,
        cwd,
        profile: profileWith({
          command: "node -e \"console.log('ignored')\""
        }),
        prompt: ""
      })
    ).rejects.toThrow(/requires prompt/);
  });

  it("runs in worktreePath while keeping review artifacts under the project root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-review-root-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-run-review-worktree-"));
    const run = baseRun("run_review_worktree");

    const result = await runReviewActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileWith({
        command:
          "node -e \"require('node:fs').writeFileSync('review-cwd.txt', process.cwd()); console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'ok',findings:[]}))\""
      }),
      prompt: "please review",
      worktreePath
    });
    const canonicalWorktreePath = await realpath(worktreePath);

    expect(result.delta.activityAttempts?.[0]?.cwd).toBe(worktreePath);
    expect(result.reviewOutcome?.kind).toBe("parsed");
    if (result.reviewOutcome?.kind !== "parsed") throw new Error("unreachable");
    expect(result.reviewOutcome.agentSessions[0]?.cwd).toBe(worktreePath);
    expect(await readFile(join(worktreePath, "review-cwd.txt"), "utf8")).toBe(canonicalWorktreePath);
    for (const artifact of result.reviewOutcome.artifacts) {
      expect(artifact.path).toContain(`.tychonic/runs/${run.id}/artifacts/`);
      expect(artifact.path).not.toContain("/worktrees/");
    }
  });

  it("fails a review command that mutates the git worktree", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-run-review-mutation-"));
    await initGitRepo(cwd);
    const run = baseRun("run_review_mutation");

    const result = await runReviewActivity({
      stateName: ACTIVITY_NAME,
      run,
      cwd,
      profile: profileWith({
        command:
          "node -e \"require('node:fs').writeFileSync('README.md','mutated by review\\n'); console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'ok',findings:[]}))\""
      }),
      prompt: "please review"
    });

    expect(result.reviewOutcome?.kind).toBe("command_failed");
    if (result.reviewOutcome?.kind !== "command_failed") throw new Error("unreachable");
    expect(result.delta.states[0]?.status).toBe("failed");
    expect(result.delta.states[0]?.reason).toBe("reviewer command did not succeed");
    expect(result.reviewOutcome.artifacts.map((a) => a.kind)).toEqual([
      `${ACTIVITY_NAME}_prompt`,
      `${ACTIVITY_NAME}_output`
    ]);
  });
});

function profileWith(block: { command: string }): TychonicConfig {
  return {
    version: "tychonic.config.v1",
    states: {
      [ACTIVITY_NAME]: {
        type: "review",
        command: block.command
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

async function initGitRepo(cwd: string): Promise<void> {
  await writeFile(join(cwd, "README.md"), "baseline\n", "utf8");
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Tychonic Test",
      "-c",
      "user.email=tychonic-test@example.invalid",
      "commit",
      "-m",
      "baseline"
    ],
    { cwd }
  );
}
