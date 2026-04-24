import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runSimpleWorkflowExtendIterations } from "../src/bootstrap/simpleWorkflowRunner.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";

const execFileAsync = promisify(execFile);

describe("runSimpleWorkflowExtendIterations", () => {
  it("returns immediately when no open inbox items remain", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-extend-empty-"));
    const runId = "run_fix_extend_empty";
    const worktreePath = join(cwd, ".tychonic", "worktrees", runId);
    await mkdir(worktreePath, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: worktreePath });

    const run: WorkflowRunRecord = {
      schema_version: "tychonic.run.v1",
      id: runId,
      template: "simple_workflow",
      status: "waiting_user",
      cwd,
      created_at: "2026-04-21T00:00:00.000Z",
      updated_at: "2026-04-21T00:00:01.000Z",
      states: [],
      activity_attempts: [],
      agent_sessions: [],
      artifacts: [],
      findings: [],
      inbox: []
    };

    const result = await runSimpleWorkflowExtendIterations({
      cwd,
      run,
      worktreePath,
      verifyCommand: "true",
      maxIterations: 3
    });

    expect(result.run.states).toHaveLength(0);
    expect(result.run.activity_attempts).toHaveLength(0);
  });

  it("rejects non-positive max iteration budgets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-extend-bad-budget-"));
    const runId = "run_fix_extend_bad";
    const worktreePath = join(cwd, ".tychonic", "worktrees", runId);
    await mkdir(worktreePath, { recursive: true });

    const run: WorkflowRunRecord = {
      schema_version: "tychonic.run.v1",
      id: runId,
      template: "simple_workflow",
      status: "waiting_user",
      cwd,
      created_at: "2026-04-21T00:00:00.000Z",
      updated_at: "2026-04-21T00:00:01.000Z",
      states: [],
      activity_attempts: [],
      agent_sessions: [],
      artifacts: [],
      findings: [],
      inbox: []
    };

    await expect(
      runSimpleWorkflowExtendIterations({
        cwd,
        run,
        worktreePath,
        verifyCommand: "true",
        maxIterations: 0
      })
    ).rejects.toThrow(/positive integer/);
  });

  it("processes an open resume_work inbox item and marks it resolved on a successful review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-extend-resume-"));
    const runId = "run_fix_extend_resume";
    const artifactDir = join(cwd, ".tychonic", "runs", runId, "artifacts");
    const worktreePath = join(cwd, ".tychonic", "worktrees", runId);
    await mkdir(artifactDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: worktreePath });
    await writeFile(join(artifactDir, "resume-prompt.txt"), "create final marker\n", "utf8");

    const run: WorkflowRunRecord = {
      schema_version: "tychonic.run.v1",
      id: runId,
      template: "simple_workflow",
      status: "waiting_user",
      goal: "continue failed review",
      cwd,
      created_at: "2026-04-21T00:00:00.000Z",
      updated_at: "2026-04-21T00:00:01.000Z",
      states: [],
      activity_attempts: [],
      agent_sessions: [
        {
          id: "session_1",
          agent: "command",
          role: "worker",
          cwd: worktreePath,
          status: "succeeded",
          resume_command:
            "node -e \"require('fs').writeFileSync('final.txt', require('fs').readFileSync(0, 'utf8'))\"",
          started_at: "2026-04-21T00:00:00.000Z"
        }
      ],
      artifacts: [
        {
          id: "artifact_1",
          kind: "resume_prompt",
          path: `.tychonic/runs/${runId}/artifacts/resume-prompt.txt`,
          created_at: "2026-04-21T00:00:01.000Z"
        }
      ],
      findings: [],
      inbox: [
        {
          id: "inbox_1",
          status: "open",
          title: "Resume work",
          detail: "review failed",
          target_session_id: "session_1",
          action: {
            kind: "resume_work",
            command:
              "node -e \"require('fs').writeFileSync('final.txt', require('fs').readFileSync(0, 'utf8'))\"",
            prompt_artifact_id: "artifact_1"
          },
          created_at: "2026-04-21T00:00:01.000Z"
        }
      ]
    };

    const result = await runSimpleWorkflowExtendIterations({
      cwd,
      run,
      worktreePath,
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('final.txt') ? 0 : 1)\"",
      maxIterations: 3,
      commandTimeoutMs: 10_000
    });

    expect(result.run.inbox.find((item) => item.id === "inbox_1")?.status).toBe("resolved");
    expect(result.run.status).not.toBe("waiting_user");
  });
});
