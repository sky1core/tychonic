import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runSimpleWorkflow, runSimpleWorkflowContinuation, runSimpleWorkflowSessionResume } from "../src/bootstrap/simpleWorkflowRunner.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";

const execFileAsync = promisify(execFile);

describe("runSimpleWorkflowContinuation", () => {
  it("executes a Temporal-provided resume_work inbox item without reading run.json", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-continuation-"));
    const runId = "run_fix_continue";
    const artifactDir = join(cwd, ".tychonic", "runs", runId, "artifacts");
    const worktreePath = join(cwd, ".tychonic", "worktrees", runId);
    await mkdir(artifactDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: worktreePath });
    await writeFile(join(artifactDir, "resume-prompt.txt"), "create final marker\n", "utf8");
    const result = await runSimpleWorkflowContinuation({
      cwd,
      run: previousRun(cwd, runId),
      worktreePath,
      inboxItemId: "inbox_1",
      verifyCommand: "node -e \"process.exit(require('fs').existsSync('final.txt') ? 0 : 1)\"",
      commandTimeoutMs: 10_000
    });

    expect(result.run.status).toBe("succeeded");
    expect(result.run.inbox.find((item) => item.id === "inbox_1")?.status).toBe("resolved");
    expect(result.run.states.map((step) => step.name)).toContain("auto_continue");
    expect(result.run.states.map((step) => step.name)).toContain("verify");
    expect(result.run.activity_attempts.filter((attempt) => attempt.kind === "resume_work")).toHaveLength(1);
    expect(result.run.activity_attempts.filter((attempt) => attempt.kind === "work")).toHaveLength(0);
  });

  it("executes a Temporal-provided triage finding as fresh work with worker candidate failover", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-continuation-fresh-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");
    await writeFile(
      join(cwd, "initial-worker.js"),
      [
        "const fs = require('fs');",
        "fs.writeFileSync('started.txt', 'ok\\n');",
        "console.log('initial worker done');",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(cwd, "fresh-a.js"),
      [
        "const fs = require('fs');",
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  fs.writeFileSync('fresh-a-prompt.txt', input);",
        "  if (!input.includes('Final marker missing')) process.exit(8);",
        "  fs.writeFileSync('contaminated.txt', 'bad\\n');",
        "  process.exit(7);",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(cwd, "fresh-b.js"),
      [
        "const fs = require('fs');",
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  fs.writeFileSync('fresh-b-prompt.txt', input);",
        "  if (!input.includes('Final marker missing')) process.exit(8);",
        "  if (fs.existsSync('contaminated.txt')) process.exit(9);",
        "  if (!fs.existsSync('started.txt')) process.exit(10);",
        "  fs.writeFileSync('final.txt', 'done\\n');",
        "  console.log('fresh worker done');",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(cwd, "reviewer.js"),
      [
        "const fs = require('fs');",
        "if (fs.existsSync('final.txt')) {",
        "  console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'complete',findings:[]}));",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'fail',summary:'final marker missing',findings:[{severity:'high',title:'Final marker missing',detail:'Create final.txt before the task is complete.',target:'final.txt'}]}));",
        ""
      ].join("\n"),
      "utf8"
    );

    const waiting = await runSimpleWorkflow({
      cwd,
      runId: "simple_workflow_continue_fresh_test",
      goal: "create final marker after review feedback",
      command: "node initial-worker.js",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('started.txt') ? 0 : 1)\"",
      reviewCommand: "node reviewer.js",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });
    const triageItem = waiting.run.inbox.find((item) => item.action.kind === "triage" && item.status === "open");
    expect(waiting.run.status).toBe("waiting_user");
    expect(triageItem?.detail).toMatch(/not known to be resumable/);
    if (!triageItem) {
      throw new Error("triage inbox item missing");
    }

    const result = await runSimpleWorkflowContinuation({
      cwd,
      run: waiting.run,
      worktreePath: waiting.worktreePath,
      inboxItemId: triageItem.id,
      workerCandidates: [
        { agent: "first-fresh-worker", command: "node fresh-a.js" },
        { agent: "second-fresh-worker", command: "node fresh-b.js" }
      ],
      verifyCommand:
        "node -e \"const fs=require('fs'); process.exit(fs.existsSync('started.txt') && fs.existsSync('final.txt') ? 0 : 1)\"",
      reviewCommand: "node reviewer.js",
      commandTimeoutMs: 10_000
    });

    const openInbox = result.run.inbox.filter((item) => item.status === "open");
    const workAttempts = result.run.activity_attempts.filter((attempt) => attempt.kind === "work");
    const latestVerify = [...result.run.states].reverse().find((step) => step.name === "verify");
    const latestReview = [...result.run.states].reverse().find((step) => step.name === "review");

    expect(result.run.status).toBe("succeeded");
    expect(result.run.inbox.find((item) => item.id === triageItem.id)?.status).toBe("resolved");
    expect(result.run.findings.find((finding) => finding.id === triageItem.finding_id)?.status).toBe("fixed");
    expect(openInbox).toHaveLength(0);
    expect(workAttempts.map((attempt) => attempt.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(result.run.activity_attempts.filter((attempt) => attempt.kind === "resume_work")).toHaveLength(0);
    expect(result.run.states.filter((step) => step.name === "verify")).toHaveLength(2);
    expect(result.run.states.filter((step) => step.name === "review")).toHaveLength(2);
    expect(latestVerify?.status).toBe("succeeded");
    expect(latestReview?.status).toBe("succeeded");
    await expect(access(join(cwd, "final.txt"))).rejects.toThrow();
    await expect(readFile(join(result.worktreePath, "started.txt"), "utf8")).resolves.toBe("ok\n");
    await expect(readFile(join(result.worktreePath, "final.txt"), "utf8")).resolves.toBe("done\n");
    await expect(access(join(result.worktreePath, "contaminated.txt"))).rejects.toThrow();
    await expect(readFile(join(result.worktreePath, "fresh-b-prompt.txt"), "utf8")).resolves.toContain(
      "Final marker missing"
    );
  });

  it("resumes a Temporal-provided agent session directly", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-session-resume-"));
    const runId = "run_session_resume";
    const worktreePath = join(cwd, ".tychonic", "worktrees", runId);
    await mkdir(worktreePath, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: worktreePath });

    const result = await runSimpleWorkflowSessionResume({
      cwd,
      run: previousRun(cwd, runId),
      worktreePath,
      sessionId: "session_1",
      prompt: "create direct marker",
      verifyCommand: "node -e \"process.exit(require('fs').existsSync('final.txt') ? 0 : 1)\"",
      commandTimeoutMs: 10_000
    });

    expect(result.run.status).toBe("waiting_user");
    expect(result.run.states.map((step) => step.name)).toContain("work");
    expect(result.run.states.map((step) => step.name)).toContain("verify");
    expect(result.run.activity_attempts.some((attempt) => attempt.kind === "resume_work")).toBe(true);
  });

  it("resolves session-targeted inbox items and findings when resumed work passes review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-session-resume-reviewed-"));
    const runId = "run_session_resume_reviewed";
    const worktreePath = join(cwd, ".tychonic", "worktrees", runId);
    await mkdir(worktreePath, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: worktreePath });
    await writeFile(
      join(worktreePath, "reviewer.js"),
      [
        "const fs = require('fs');",
        "if (fs.existsSync('final.txt')) {",
        "  console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'complete',findings:[]}));",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'fail',summary:'final marker missing',findings:[{severity:'high',title:'Final marker missing',detail:'Create final.txt before the task is complete.',target:'final.txt'}]}));"
      ].join("\n"),
      "utf8"
    );

    const result = await runSimpleWorkflowSessionResume({
      cwd,
      run: previousRunWithFinding(cwd, runId),
      worktreePath,
      sessionId: "session_1",
      prompt: "done",
      verifyCommand: "node -e \"process.exit(require('fs').existsSync('final.txt') ? 0 : 1)\"",
      reviewCommand: "node reviewer.js",
      commandTimeoutMs: 10_000
    });

    expect(result.run.status).toBe("succeeded");
    expect(result.run.inbox.find((item) => item.id === "inbox_1")?.status).toBe("resolved");
    expect(result.run.findings.find((finding) => finding.id === "finding_1")?.status).toBe("fixed");
    expect(result.run.states.filter((step) => step.name === "review").at(-1)?.status).toBe("succeeded");
  });
});

function previousRun(cwd: string, runId: string): WorkflowRunRecord {
  return {
    schema_version: "tychonic.run.v1",
    id: runId,
    template: "simple_workflow",
    status: "waiting_user",
    goal: "continue failed review",
    cwd,
    created_at: "2026-04-19T00:00:00.000Z",
    updated_at: "2026-04-19T00:00:01.000Z",
    states: [],
    activity_attempts: [],
    agent_sessions: [
      {
        id: "session_1",
        agent: "command",
        role: "worker",
        cwd: join(cwd, ".tychonic", "worktrees", runId),
        status: "succeeded",
        resume_command: "node -e \"require('fs').writeFileSync('final.txt', require('fs').readFileSync(0, 'utf8'))\"",
        started_at: "2026-04-19T00:00:00.000Z"
      }
    ],
    artifacts: [
      {
        id: "artifact_1",
        kind: "resume_prompt",
        path: `.tychonic/runs/${runId}/artifacts/resume-prompt.txt`,
        created_at: "2026-04-19T00:00:01.000Z"
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
          command: "node -e \"require('fs').writeFileSync('final.txt', require('fs').readFileSync(0, 'utf8'))\"",
          prompt_artifact_id: "artifact_1"
        },
        created_at: "2026-04-19T00:00:01.000Z"
      }
    ]
  };
}

function previousRunWithFinding(cwd: string, runId: string): WorkflowRunRecord {
  const run = previousRun(cwd, runId);
  run.findings = [
    {
      id: "finding_1",
      status: "new",
      severity: "high",
      title: "Resume work",
      detail: "Create final.txt before the task is complete.",
      target: "final.txt",
      source_state_id: "state_review_1",
      source_review_session_id: "review_session_1",
      target_work_session_id: "session_1",
      created_at: "2026-04-19T00:00:01.000Z"
    }
  ];
  run.inbox = [
    {
      ...run.inbox[0]!,
      finding_id: "finding_1"
    }
  ];
  return run;
}
