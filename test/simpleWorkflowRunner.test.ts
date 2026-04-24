import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  runSimpleWorkflow,
  runSimpleWorkflowContinuation,
  runSimpleWorkflowSessionResume
} from "../src/bootstrap/simpleWorkflowRunner.js";
import { resolveSimpleWorkflowCliOptions } from "../src/cli/simpleWorkflowCliOptions.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";
import { TYCHONIC_AGENT_PATH_ENV } from "../src/system/executables.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

describe("runSimpleWorkflow", () => {
  it("validates command-only worker and review selection rules", async () => {
    await expect(
      runSimpleWorkflow({
        cwd: "/repo",
        goal: "run worker",
        verifyCommand: "npm test"
      })
    ).rejects.toThrow(/simple_workflow requires a worker command/);

    await expect(
      runSimpleWorkflow({
        cwd: "/repo",
        goal: "run worker",
        command: "node worker.js",
        workerCandidates: [{ agent: "claude", command: "claude --print" }],
        verifyCommand: "npm test"
      })
    ).rejects.toThrow(/simple_workflow accepts worker candidates or --command/);

    await expect(
      runSimpleWorkflow({
        cwd: "/repo",
        workerCandidates: [{ agent: "codex" }],
        verifyCommand: "npm test"
      })
    ).rejects.toThrow(/simple_workflow worker candidate codex requires command/);

    await expect(
      runSimpleWorkflow({
        cwd: "/repo",
        command: "node worker.js",
        verifyCommand: "npm test",
        reviewCandidates: [{ agent: "reviewer", command: "review --json", resumeCommand: "review --resume" }]
      })
    ).rejects.toThrow(/simple_workflow review candidate reviewer must not set resumeCommand/);

    await expect(
      runSimpleWorkflow({
        cwd: "/repo",
        command: "node worker.js",
        verifyCommand: "npm test",
        reviewCandidates: [{ agent: "reviewer", command: "review --json" }],
        reviewCommand: "node reviewer.js"
      })
    ).rejects.toThrow(/simple_workflow review candidates own their agent labels and commands/);
  });

  it("delegates work into an isolated no-HEAD worktree copy", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_test",
      goal: "create delegated marker file",
      command: "node -e \"require('fs').writeFileSync('delegated.txt', 'ok')\"",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('delegated.txt') ? 0 : 1)\"",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });
    const persisted = result.run;

    await expect(access(join(cwd, "delegated.txt"))).rejects.toThrow();
    await expect(access(join(result.worktreePath, "delegated.txt"))).resolves.toBeUndefined();
    expect(persisted.status).toBe("succeeded");
    expect(persisted.states.map((step) => `${step.name}:${step.status}`)).toEqual([
      "create_isolated_worktree:succeeded",
      "work:succeeded",
      "verify:succeeded"
    ]);
    expect(persisted.agent_sessions).toHaveLength(1);
    expect(persisted.agent_sessions[0]?.role).toBe("worker");
    expect(persisted.activity_attempts.find((attempt) => attempt.kind === "work")?.cwd).toBe(
      result.worktreePath
    );
    expect(persisted.artifacts.some((artifact) => artifact.kind === "worker_output")).toBe(true);
    expect(persisted.artifacts.some((artifact) => artifact.kind === "worker_diff")).toBe(true);
    expect(persisted.artifacts.some((artifact) => artifact.kind === "verify_output")).toBe(true);

    const workerPatch = persisted.artifacts.find((artifact) => artifact.kind === "worker_patch");
    expect(workerPatch).toBeDefined();
    if (!workerPatch) {
      throw new Error("worker_patch artifact missing");
    }

    expect(persisted.agent_sessions[0]?.diff_artifact_id).toBe(workerPatch.id);
    const workerPatchPath = join(cwd, workerPatch.path);
    const patch = await readFile(workerPatchPath, "utf8");
    expect(patch).toContain("diff --git a/delegated.txt b/delegated.txt");
    expect(patch).toContain("new file mode");
    expect(patch).toContain("+ok");
    await execFileAsync("git", ["apply", "--check", workerPatchPath], { cwd });
  });

  it("passes the delegated goal on stdin to command workers", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-stdin-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_stdin_test",
      goal: "create marker from stdin prompt",
      command:
        "node -e \"let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => require('fs').writeFileSync('stdin.txt', input));\"",
      verifyCommand:
        "node -e \"const input=require('fs').readFileSync('stdin.txt','utf8'); process.exit(input.includes('create marker from stdin prompt') ? 0 : 1)\"",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });

    expect(result.run.status).toBe("succeeded");
    await expect(readFile(join(result.worktreePath, "stdin.txt"), "utf8")).resolves.toContain(
      "create marker from stdin prompt"
    );
  });

  it("writes the effective profile snapshot and does not emit a profile_sources artifact", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-profile-snapshot-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_profile_snapshot_test",
      command: "node -e \"require('fs').writeFileSync('delegated.txt', 'ok')\"",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('delegated.txt') ? 0 : 1)\"",
      profile: {
        version: "tychonic.config.v1",
        states: {
          verify: { type: "verify", command: "node -e \"process.exit(0)\"" },
          work: { type: "work", agent: "codex", command: "node worker.js" }
        }
      },
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });

    const snapshot = result.run.artifacts.find((artifact) => artifact.kind === "profile_snapshot");
    const sources = result.run.artifacts.find((artifact) => artifact.kind === "profile_sources");
    expect(snapshot?.path).toContain("profile_snapshot.yaml");
    expect(sources).toBeUndefined();
    if (!snapshot) {
      throw new Error("profile_snapshot missing");
    }
    await expect(readFile(join(cwd, snapshot.path), "utf8")).resolves.toContain("version: tychonic.config.v1");
  });

  it("applies the review activity timeout when the structured review step runs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-review-timeout-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_review_timeout_test",
      goal: "run review timeout path",
      command: "node -e \"require('fs').writeFileSync('delegated.txt', 'ok')\"",
      verifyCommand: "node -e \"process.exit(0)\"",
      reviewCommand:
        "node -e \"setTimeout(() => console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'ok',findings:[]})), 50)\"",
      activityTimeouts: { review: 1 },
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });

    const reviewStep = result.run.states.find((step) => step.name === "review");
    const reviewAttempt = result.run.activity_attempts.find((attempt) => attempt.state_id === reviewStep?.id);
    expect(reviewStep?.status).toBe("timed_out");
    expect(reviewAttempt?.timeout_ms).toBe(1);
  });

  it("tries the next worker candidate when an earlier candidate fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-candidate-"));
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Tychonic Test"], { cwd });
    await execFileAsync("git", ["config", "user.email", "tychonic@example.invalid"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "committed\n", "utf8");
    await execFileAsync("git", ["add", "seed.txt"], { cwd });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "dirty baseline\n", "utf8");
    await writeFile(join(cwd, "untracked-baseline.txt"), "untracked baseline\n", "utf8");

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_candidate_test",
      goal: "create final delegated marker",
      workerCandidates: [
        {
          agent: "broken-worker",
          command: "node -e \"require('fs').writeFileSync('contaminated.txt', 'bad'); process.exit(7)\""
        },
        {
          agent: "good-worker",
          command:
            "node -e \"const fs=require('fs'); if (fs.existsSync('contaminated.txt')) process.exit(8); if (fs.readFileSync('seed.txt','utf8') !== 'dirty baseline\\n') process.exit(9); if (!fs.existsSync('untracked-baseline.txt')) process.exit(10); fs.writeFileSync('delegated.txt', 'ok')\""
        }
      ],
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('delegated.txt') ? 0 : 1)\"",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });

    expect(result.run.status).toBe("succeeded");
    expect(result.run.states.map((step) => `${step.name}:${step.status}`)).toEqual([
      "create_isolated_worktree:succeeded",
      "work:succeeded",
      "verify:succeeded"
    ]);
    expect(result.run.agent_sessions.filter((session) => session.role === "worker").map((session) => session.agent)).toEqual([
      "broken-worker",
      "good-worker"
    ]);
    expect(result.run.activity_attempts.filter((attempt) => attempt.kind === "work").map((attempt) => attempt.status)).toEqual([
      "failed",
      "succeeded"
    ]);
    await expect(access(join(result.worktreePath, "contaminated.txt"))).rejects.toThrow();
    await expect(access(join(result.worktreePath, "delegated.txt"))).resolves.toBeUndefined();
  });

  it("fails the run when deterministic verification fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-fail-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_fail_test",
      command: "node -e \"require('fs').writeFileSync('delegated.txt', 'ok')\"",
      verifyCommand: "node -e \"process.exit(7)\"",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });

    const verifyStep = result.run.states.find((step) => step.name === "verify");

    expect(result.run.status).toBe("failed");
    expect(verifyStep?.status).toBe("failed");
    expect(
      result.run.activity_attempts.find((attempt) => attempt.state_id === verifyStep?.id)?.exit_code
    ).toBe(7);
  });

  it("runs structured review after verification and waits for the user on resumable findings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-review-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_review_test",
      goal: "create delegated marker file",
      command: "node -e \"require('fs').writeFileSync('delegated.txt', 'ok')\"",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('delegated.txt') ? 0 : 1)\"",
      resumeCommand: "codex exec resume worker-session",
      reviewCommand:
        "node -e \"console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'fail',summary:'needs worker follow-up',findings:[{severity:'high',title:'Missing edge case',detail:'The worker did not cover the edge case.',target:'delegated.txt'}]}))\"",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });
    const persisted = result.run;
    const workerSession = persisted.agent_sessions.find((session) => session.role === "worker");
    const reviewSession = persisted.agent_sessions.find((session) => session.role === "reviewer");
    const reviewStep = persisted.states.find((step) => step.name === "review");
    const inbox = persisted.inbox.find((item) => item.action.kind === "resume_work");

    expect(persisted.status).toBe("waiting_user");
    expect(reviewStep?.status).toBe("failed");
    expect(workerSession?.resume_command).toBe("codex exec resume worker-session");
    expect(reviewSession?.agent).toBe("review");
    expect(persisted.findings[0]?.target_work_session_id).toBe(workerSession?.id);
    expect(reviewStep?.finding_ids).toEqual([persisted.findings[0]?.id]);
    expect(inbox?.target_session_id).toBe(workerSession?.id);
    expect(inbox?.action.kind).toBe("resume_work");
    if (!inbox || inbox.action.kind !== "resume_work") {
      throw new Error("resume_work inbox item missing");
    }
    expect(inbox.action.command).toBe("codex exec resume worker-session");

    const resumePromptPath = join(
      cwd,
      persisted.artifacts.find((artifact) => artifact.id === inbox.action.prompt_artifact_id)?.path ?? ""
    );
    const resumePrompt = await readFile(resumePromptPath, "utf8");
    expect(resumePrompt).toContain("Missing edge case");
    expect(resumePrompt).toContain("delegated.txt");
  });

  it("succeeds when the optional structured review passes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-review-pass-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_review_pass_test",
      command: "node -e \"require('fs').writeFileSync('delegated.txt', 'ok')\"",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('delegated.txt') ? 0 : 1)\"",
      reviewCommand:
        "node -e \"console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'review passed',findings:[]}))\"",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });

    expect(result.run.status).toBe("succeeded");
    expect(result.run.states.find((step) => step.name === "review")?.status).toBe("succeeded");
    expect(result.run.findings).toHaveLength(0);
    expect(result.run.inbox).toHaveLength(0);
  });

  it("tries the next reviewer candidate when an earlier candidate fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-review-candidate-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_review_candidate_test",
      command: "node -e \"require('fs').writeFileSync('delegated.txt', 'ok')\"",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('delegated.txt') ? 0 : 1)\"",
      reviewCandidates: [
        {
          agent: "broken-reviewer",
          command: "node -e \"process.exit(9)\""
        },
        {
          agent: "good-reviewer",
          command:
            "node -e \"console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'review passed',findings:[]}))\""
        }
      ],
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });

    const reviewSteps = result.run.states.filter((step) => step.name === "review");

    expect(result.run.status).toBe("succeeded");
    expect(reviewSteps.map((step) => step.status)).toEqual(["failed", "succeeded"]);
    expect(result.run.agent_sessions.filter((session) => session.role === "reviewer").map((session) => session.agent)).toEqual([
      "good-reviewer"
    ]);
    expect(
      result.run.activity_attempts
        .filter((attempt) => attempt.kind === "semantic_review")
        .map((attempt) => attempt.status)
    ).toEqual(["failed", "succeeded"]);
  });

  it("auto-continues a resumable failed review and reruns verification plus review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-auto-continue-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");
    await writeFile(
      join(cwd, "reviewer.js"),
      [
        "const fs = require('fs');",
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  fs.appendFileSync('review-prompts.txt', input + '\\n---\\n');",
        "  if (!input.includes('Goal: create final marker after review feedback')) process.exit(9);",
        "  if (!input.includes('full original goal')) process.exit(10);",
        "  if (fs.existsSync('final.txt')) {",
        "    console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'goal complete',findings:[]}));",
        "    return;",
        "  }",
        "  console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'fail',summary:'goal incomplete',findings:[{severity:'high',title:'Final marker missing',detail:'The original goal requires final.txt after feedback.',target:'final.txt'}]}));",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(cwd, "resume.js"),
      [
        "const fs = require('fs');",
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  fs.writeFileSync('resume-prompt.txt', input);",
        "  if (!input.includes('Final marker missing')) process.exit(8);",
        "  fs.writeFileSync('final.txt', 'done\\n');",
        "  console.log('resumed');",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_auto_continue_test",
      goal: "create final marker after review feedback",
      command: "node -e \"require('fs').writeFileSync('started.txt', 'ok\\n')\"",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('started.txt') ? 0 : 1)\"",
      resumeCommand: "node resume.js",
      reviewCommand: "node reviewer.js",
      autoContinue: true,
      maxIterations: 2,
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });
    const persisted = result.run;
    const resumeAttempt = persisted.activity_attempts.find((attempt) => attempt.kind === "resume_work");
    const openInbox = persisted.inbox.filter((item) => item.status === "open");
    const patchArtifact = [...persisted.artifacts].reverse().find((artifact) => artifact.kind === "worker_patch");

    expect(persisted.status).toBe("succeeded");
    expect(persisted.states.filter((step) => step.name === "verify")).toHaveLength(2);
    expect(persisted.states.filter((step) => step.name === "review")).toHaveLength(2);
    expect(persisted.states.find((step) => step.name === "auto_continue")?.status).toBe("succeeded");
    expect(resumeAttempt?.cwd).toBe(result.worktreePath);
    expect(persisted.inbox[0]?.status).toBe("resolved");
    expect(openInbox).toHaveLength(0);
    await expect(access(join(cwd, "final.txt"))).rejects.toThrow();
    await expect(readFile(join(result.worktreePath, "final.txt"), "utf8")).resolves.toBe("done\n");
    await expect(readFile(join(result.worktreePath, "resume-prompt.txt"), "utf8")).resolves.toContain(
      "Final marker missing"
    );
    expect(patchArtifact).toBeDefined();
    if (!patchArtifact) {
      throw new Error("worker_patch artifact missing");
    }
    expect(await readFile(join(cwd, patchArtifact.path), "utf8")).toContain("final.txt");
  });

  it("uses the named auto_continue activity timeout for auto-continue resume attempts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-auto-continue-timeout-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");
    await writeFile(
      join(cwd, "reviewer.js"),
      [
        "const fs = require('fs');",
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  if (fs.existsSync('final.txt')) {",
        "    console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'goal complete',findings:[]}));",
        "    return;",
        "  }",
        "  console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'fail',summary:'goal incomplete',findings:[{severity:'high',title:'Final marker missing',detail:'Create final.txt during auto-continue.',target:'final.txt'}]}));",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(cwd, "resume.js"),
      [
        "const fs = require('fs');",
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  setTimeout(() => {",
        "    fs.writeFileSync('resume-prompt.txt', input);",
        "    fs.writeFileSync('final.txt', 'done\\n');",
        "    console.log('resumed');",
        "  }, 50);",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );

    const resolved = resolveSimpleWorkflowCliOptions({
      cwd,
      goal: "create final marker after review feedback",
      profile: {
        version: "tychonic.config.v1",
        states: {
          work: {
            type: "work",
            command: "node -e \"require('fs').writeFileSync('started.txt', 'ok\\n')\"",
            resume_command: "node resume.js"
          },
          verify: {
            type: "verify",
            command: "node -e \"process.exit(require('fs').existsSync('started.txt') ? 0 : 1)\""
          },
          review: {
            type: "review",
            command: "node reviewer.js",
            emits: ["tychonic.review.v1"]
          },
          auto_continue: {
            type: "auto_continue",
            agent: "claude",
            timeout: 1
          }
        },
        policies: {
          loop: {
            auto_continue: true,
            max_review_iterations: 2
          }
        }
      }
    });

    expect(resolved.activityTimeouts?.auto_continue).toBe(1);

    const result = await runSimpleWorkflow({
      ...resolved,
      runId: "delegate_auto_continue_timeout_test",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env
    });

    const autoContinueStep = result.run.states.find((step) => step.name === "auto_continue");
    const resumeAttempt = result.run.activity_attempts.find(
      (attempt) => attempt.state_id === autoContinueStep?.id && attempt.kind === "resume_work"
    );

    expect(autoContinueStep?.status).toBe("timed_out");
    expect(resumeAttempt?.timeout_ms).toBe(1);
  });

  it("prefers an explicit work timeout over auto_continue during resumed auto-continue", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-auto-continue-resume-override-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");
    await writeFile(
      join(cwd, "reviewer.js"),
      [
        "const fs = require('fs');",
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  if (fs.existsSync('final.txt')) {",
        "    console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'goal complete',findings:[]}));",
        "    return;",
        "  }",
        "  console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'fail',summary:'goal incomplete',findings:[{severity:'high',title:'Final marker missing',detail:'Create final.txt during auto-continue.',target:'final.txt'}]}));",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(cwd, "resume.js"),
      [
        "const fs = require('fs');",
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  setTimeout(() => {",
        "    fs.writeFileSync('resume-prompt.txt', input);",
        "    fs.writeFileSync('final.txt', 'done\\n');",
        "    console.log('resumed');",
        "  }, 50);",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );

    const resolved = resolveSimpleWorkflowCliOptions({
      cwd,
      goal: "create final marker after review feedback",
      profile: {
        version: "tychonic.config.v1",
        states: {
          work: {
            type: "work",
            command: "node -e \"require('fs').writeFileSync('started.txt', 'ok\\n')\"",
            resume_command: "node resume.js",
            timeout: 250
          },
          verify: {
            type: "verify",
            command: "node -e \"process.exit(require('fs').existsSync('started.txt') ? 0 : 1)\""
          },
          review: {
            type: "review",
            command: "node reviewer.js",
            emits: ["tychonic.review.v1"]
          },
          auto_continue: {
            type: "auto_continue",
            agent: "claude",
            timeout: 1
          }
        },
        policies: {
          loop: {
            auto_continue: true,
            max_review_iterations: 2
          }
        }
      }
    });

    const result = await runSimpleWorkflow({
      ...resolved,
      runId: "delegate_auto_continue_resume_override_test",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env
    });

    const autoContinueStep = result.run.states.find((step) => step.name === "auto_continue");
    const resumeAttempt = result.run.activity_attempts.find(
      (attempt) => attempt.state_id === autoContinueStep?.id && attempt.kind === "resume_work"
    );

    expect(autoContinueStep?.status).toBe("succeeded");
    expect(resumeAttempt?.timeout_ms).toBe(250);
  });

  it("prefers an explicit work timeout over auto_continue for fresh auto-continue work", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-auto-continue-work-override-"));
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
      join(cwd, "fresh-worker.js"),
      [
        "const fs = require('fs');",
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  setTimeout(() => {",
        "    fs.writeFileSync('fresh-prompt.txt', input);",
        "    fs.writeFileSync('final.txt', 'done\\n');",
        "    console.log('fresh worker done');",
        "  }, 50);",
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
      runId: "delegate_auto_continue_work_override_waiting",
      goal: "create final marker after review feedback",
      command: "node initial-worker.js",
      verifyCommand: "node -e \"process.exit(require('fs').existsSync('started.txt') ? 0 : 1)\"",
      reviewCommand: "node reviewer.js",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });
    const triageItem = waiting.run.inbox.find((item) => item.action.kind === "triage" && item.status === "open");
    if (!triageItem) {
      throw new Error("triage inbox item missing");
    }

    const result = await runSimpleWorkflowContinuation({
      cwd,
      run: waiting.run,
      worktreePath: waiting.worktreePath,
      inboxItemId: triageItem.id,
      workerCandidates: [{ agent: "fresh-worker", command: "node fresh-worker.js" }],
      verifyCommand:
        "node -e \"const fs=require('fs'); process.exit(fs.existsSync('started.txt') && fs.existsSync('final.txt') ? 0 : 1)\"",
      reviewCommand: "node reviewer.js",
      activityTimeouts: { auto_continue: 1, work: 250 },
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env
    });

    const latestWorkAttempt = [...result.run.activity_attempts].reverse().find((attempt) => attempt.kind === "work");

    expect(result.run.status).toBe("succeeded");
    expect(latestWorkAttempt?.timeout_ms).toBe(250);
  });

  it("falls back to a fresh worker when auto-continue targets a non-resumable session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-auto-fresh-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");
    await writeFile(
      join(cwd, "worker-a.js"),
      [
        "const fs = require('fs');",
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  fs.appendFileSync('worker-a-prompts.txt', input + '\\n---\\n');",
        "  if (input.includes('Final marker missing')) {",
        "    fs.writeFileSync('contaminated.txt', 'bad\\n');",
        "    process.exit(7);",
        "  }",
        "  fs.writeFileSync('started.txt', 'ok\\n');",
        "  console.log('initial worker done');",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(cwd, "worker-b.js"),
      [
        "const fs = require('fs');",
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  fs.writeFileSync('fresh-prompt.txt', input);",
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

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_auto_fresh_test",
      goal: "create final marker after review feedback",
      workerCandidates: [
        { agent: "first-worker", command: "node worker-a.js" },
        { agent: "fresh-worker", command: "node worker-b.js" }
      ],
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('started.txt') ? 0 : 1)\"",
      reviewCommand: "node reviewer.js",
      autoContinue: true,
      maxIterations: 2,
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });
    const persisted = result.run;
    const openInbox = persisted.inbox.filter((item) => item.status === "open");
    const workAttempts = persisted.activity_attempts.filter((attempt) => attempt.kind === "work");
    const freshPromptArtifact = persisted.artifacts.find((artifact) => artifact.kind === "fresh_work_prompt");
    expect(persisted.status).toBe("succeeded");
    expect(persisted.states.filter((step) => step.name === "work")).toHaveLength(2);
    expect(persisted.states.filter((step) => step.name === "verify")).toHaveLength(2);
    expect(persisted.states.filter((step) => step.name === "review")).toHaveLength(2);
    expect(workAttempts.map((attempt) => attempt.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(persisted.activity_attempts.filter((attempt) => attempt.kind === "resume_work")).toHaveLength(0);
    expect(persisted.inbox[0]?.action.kind).toBe("triage");
    expect(persisted.inbox[0]?.status).toBe("resolved");
    expect(persisted.inbox[0]?.detail).toMatch(/not known to be resumable/);
    expect(openInbox).toHaveLength(0);
    await expect(access(join(cwd, "final.txt"))).rejects.toThrow();
    await expect(readFile(join(result.worktreePath, "started.txt"), "utf8")).resolves.toBe("ok\n");
    await expect(readFile(join(result.worktreePath, "final.txt"), "utf8")).resolves.toBe("done\n");
    await expect(access(join(result.worktreePath, "contaminated.txt"))).rejects.toThrow();
    await expect(readFile(join(result.worktreePath, "fresh-prompt.txt"), "utf8")).resolves.toContain("Final marker missing");
    expect(freshPromptArtifact).toBeDefined();
  });

  it.skip("wraps fresh explicit Codex continuation prompts with the Codex shell guardrails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-codex-fresh-continuation-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");
    await writeFile(
      join(cwd, "worker.js"),
      [
        "const fs = require('fs');",
        "fs.writeFileSync('started.txt', 'ok\\n');",
        "console.log('initial worker done');",
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
      runId: "delegate_codex_fresh_continuation_waiting",
      goal: "create final marker after review feedback",
      command: "node worker.js",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('started.txt') ? 0 : 1)\"",
      reviewCommand: "node reviewer.js",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });
    const triageItem = waiting.run.inbox.find((item) => item.action.kind === "triage" && item.status === "open");
    if (!triageItem) {
      throw new Error("triage inbox item missing");
    }

    const fakeBin = join(cwd, "bin");
    await mkdir(fakeBin);
    await writeFile(
      join(fakeBin, "codex"),
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        "const args = process.argv.slice(2);",
        "const outIndex = args.indexOf('--output-last-message');",
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "if (!args.includes('--sandbox') || args[args.indexOf('--sandbox') + 1] !== 'workspace-write') process.exit(21);",
        "if (!args.includes('--ask-for-approval') || args[args.indexOf('--ask-for-approval') + 1] !== 'never') process.exit(22);",
        "fs.writeFileSync('fresh-codex-prompt.txt', input);",
        "fs.writeFileSync('final.txt', 'done\\n');",
        "if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], 'fresh codex done');",
        "console.log(JSON.stringify({session:{id:'019da55d-35dd-7e6a-a713-a32ccb9b67b1'}}));",
        "console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'fresh codex done'}}));",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(join(fakeBin, "codex"), 0o755);

    const result = await runSimpleWorkflowContinuation({
      cwd,
      run: waiting.run,
      worktreePath: waiting.worktreePath,
      inboxItemId: triageItem.id,
      goal: "create final marker after review feedback",
      command: "codex --ask-for-approval never exec --sandbox workspace-write --skip-git-repo-check --json",
      agent: "codex",
      verifyCommand:
        "node -e \"const fs=require('fs'); process.exit(fs.existsSync('started.txt') && fs.existsSync('final.txt') ? 0 : 1)\"",
      reviewCommand: "node reviewer.js",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      commandTimeoutMs: 10_000
    });

    expect(result.run.status).toBe("succeeded");
    await expect(readFile(join(result.worktreePath, "fresh-codex-prompt.txt"), "utf8")).resolves.toContain(
      "Do not launch multiple shell or tool commands in parallel."
    );
    await expect(readFile(join(result.worktreePath, "fresh-codex-prompt.txt"), "utf8")).resolves.toContain(
      "use exactly one shell invocation at a time."
    );
    await expect(readFile(join(result.worktreePath, "fresh-codex-prompt.txt"), "utf8")).resolves.toContain(
      "Final marker missing"
    );
  });

  it.skip("wraps explicit Codex session resume prompts with the Codex shell guardrails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-codex-session-resume-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const fakeBin = join(cwd, "bin");
    await mkdir(fakeBin);
    await writeFile(
      join(fakeBin, "codex"),
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        "const args = process.argv.slice(2);",
        "const outIndex = args.indexOf('--output-last-message');",
        "const writeLast = (value) => { if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], value); };",
        "const emitSession = (id, text) => {",
        "  console.log(JSON.stringify({session:{id}}));",
        "  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));",
        "};",
        "const readStdin = (callback) => {",
        "  let input = '';",
        "  process.stdin.on('data', chunk => input += chunk);",
        "  process.stdin.on('end', () => callback(input));",
        "};",
        "const isResume = args[0] === 'exec' && args[1] === 'resume';",
        "if (isResume) {",
        "  readStdin((input) => {",
        "    fs.writeFileSync('resume-args.json', JSON.stringify(args));",
        "    fs.writeFileSync('resume-stdin.txt', input);",
        "    if (args[args.length - 1] !== '-') process.exit(31);",
        "    fs.writeFileSync('final.txt', 'done\\n');",
        "    writeLast('resume done');",
        "    emitSession('019da66d-35dd-7e6a-a713-a32ccb9b67a8', 'resume done');",
        "  });",
        "  return;",
        "}",
        "if (!args.includes('--sandbox') || args[args.indexOf('--sandbox') + 1] !== 'workspace-write') process.exit(32);",
        "if (!args.includes('--ask-for-approval') || args[args.indexOf('--ask-for-approval') + 1] !== 'never') process.exit(33);",
        "fs.writeFileSync('worker-prompt.txt', args[args.length - 1]);",
        "fs.writeFileSync('started.txt', 'ok\\n');",
        "writeLast('worker done');",
        "emitSession('019da66d-35dd-7e6a-a713-a32ccb9b67a7', 'worker done');",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(join(fakeBin, "codex"), 0o755);

    const initial = await runSimpleWorkflow({
      cwd,
      runId: "delegate_codex_session_resume_test",
      goal: "create final marker after direct session resume",
      command: "codex --ask-for-approval never exec --sandbox workspace-write --skip-git-repo-check --json",
      agent: "codex",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('started.txt') ? 0 : 1)\"",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      commandTimeoutMs: 10_000
    });
    const workerSession = initial.run.agent_sessions.find((session) => session.role === "worker");
    if (!workerSession) {
      throw new Error("worker session missing");
    }

    const result = await runSimpleWorkflowSessionResume({
      cwd,
      run: initial.run,
      worktreePath: initial.worktreePath,
      sessionId: workerSession.id,
      prompt: "Final marker missing\nCreate final.txt before the task is complete.",
      verifyCommand:
        "node -e \"const fs=require('fs'); process.exit(fs.existsSync('started.txt') && fs.existsSync('final.txt') ? 0 : 1)\"",
      now: () => new Date("2026-04-19T00:00:01.000Z"),
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      commandTimeoutMs: 10_000
    });

    expect(result.run.status).toBe("succeeded");
    await expect(readFile(join(result.worktreePath, "resume-stdin.txt"), "utf8")).resolves.toContain(
      "Do not launch multiple shell or tool commands in parallel."
    );
    await expect(readFile(join(result.worktreePath, "resume-stdin.txt"), "utf8")).resolves.toContain(
      "use exactly one shell invocation at a time."
    );
    await expect(readFile(join(result.worktreePath, "resume-stdin.txt"), "utf8")).resolves.toContain(
      "Prefer direct file inspection and targeted edits over command-based validation."
    );
    await expect(readFile(join(result.worktreePath, "resume-stdin.txt"), "utf8")).resolves.toContain(
      "Final marker missing"
    );
    await expect(readFile(join(result.worktreePath, "resume-stdin.txt"), "utf8")).resolves.toContain(
      "Create final.txt before the task is complete."
    );
  });

  it("keeps continuation inbox items open until verify and re-review succeed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-auto-continue-open-until-pass-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");
    await writeFile(
      join(cwd, "worker.js"),
      [
        "const fs = require('fs');",
        "fs.writeFileSync('started.txt', 'ok\\n');",
        "console.log('initial worker done');",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(cwd, "resume.js"),
      [
        "const fs = require('fs');",
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  fs.writeFileSync('resume-prompt.txt', input);",
        "  fs.writeFileSync('still-missing.txt', 'not fixed\\n');",
        "  console.log('resumed');",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(cwd, "reviewer.js"),
      [
        "console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'fail',summary:'final marker missing',findings:[{severity:'high',title:'Final marker missing',detail:'Create final.txt before the task is complete.',target:'final.txt'}]}));",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_auto_continue_open_until_pass_test",
      goal: "create final marker after review feedback",
      command: "node worker.js",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('started.txt') ? 0 : 1)\"",
      resumeCommand: "node resume.js",
      reviewCommand: "node reviewer.js",
      autoContinue: true,
      maxIterations: 1,
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });

    expect(result.run.status).toBe("waiting_user");
    expect(result.run.inbox[0]?.status).toBe("open");
    expect(result.run.findings[0]?.status).toBe("new");
    expect(result.run.states.find((step) => step.name === "auto_continue")?.status).toBe("succeeded");
    expect(result.run.states.filter((step) => step.name === "review")).toHaveLength(2);
  });

  it("stops auto-continuing when the max iteration limit is reached", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-auto-limit-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");
    await writeFile(
      join(cwd, "reviewer.js"),
      [
        "console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'fail',summary:'still incomplete',findings:[{severity:'high',title:'Still missing',detail:'The goal is still not complete.',target:'final.txt'}]}));",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(cwd, "resume.js"),
      [
        "const fs = require('fs');",
        "const count = fs.existsSync('resume-count.txt') ? Number(fs.readFileSync('resume-count.txt', 'utf8')) : 0;",
        "fs.writeFileSync('resume-count.txt', String(count + 1));",
        "console.log('resumed');",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_auto_limit_test",
      goal: "finish after review",
      command: "node -e \"require('fs').writeFileSync('started.txt', 'ok\\n')\"",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('started.txt') ? 0 : 1)\"",
      resumeCommand: "node resume.js",
      reviewCommand: "node reviewer.js",
      autoContinue: true,
      maxIterations: 1,
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });

    const openResumeItems = result.run.inbox.filter(
      (item) => item.status === "open" && item.action.kind === "resume_work"
    );

    expect(result.run.status).toBe("waiting_user");
    expect(result.run.activity_attempts.filter((attempt) => attempt.kind === "resume_work")).toHaveLength(1);
    expect(result.run.states.filter((step) => step.name === "review")).toHaveLength(2);
    expect(openResumeItems.length).toBeGreaterThanOrEqual(1);
    await expect(readFile(join(result.worktreePath, "resume-count.txt"), "utf8")).resolves.toBe("1");
    await expect(access(join(cwd, "resume-count.txt"))).rejects.toThrow();
  });

  it("defaults auto-continuation to five resume attempts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-auto-default-limit-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");
    await writeFile(
      join(cwd, "reviewer.js"),
      [
        "console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'fail',summary:'still failing',findings:[{severity:'high',title:'Still missing',detail:'The fix is not complete.',target:'final.txt'}]}));",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(cwd, "resume.js"),
      [
        "const fs = require('fs');",
        "const count = fs.existsSync('resume-count.txt') ? Number(fs.readFileSync('resume-count.txt', 'utf8')) : 0;",
        "fs.writeFileSync('resume-count.txt', String(count + 1));",
        "console.log('resumed');",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_auto_default_limit_test",
      goal: "finish after review",
      command: "node -e \"require('fs').writeFileSync('started.txt', 'ok\\n')\"",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('started.txt') ? 0 : 1)\"",
      resumeCommand: "node resume.js",
      reviewCommand: "node reviewer.js",
      autoContinue: true,
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });

    const openResumeItems = result.run.inbox.filter(
      (item) => item.status === "open" && item.action.kind === "resume_work"
    );

    expect(result.run.status).toBe("waiting_user");
    expect(result.run.activity_attempts.filter((attempt) => attempt.kind === "resume_work")).toHaveLength(5);
    expect(result.run.states.filter((step) => step.name === "review")).toHaveLength(6);
    expect(openResumeItems.length).toBeGreaterThanOrEqual(1);
    await expect(readFile(join(result.worktreePath, "resume-count.txt"), "utf8")).resolves.toBe("5");
    await expect(access(join(cwd, "resume-count.txt"))).rejects.toThrow();
  });

  it.skip("records and resumes legacy Kiro worker sessions discovered from list-sessions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-kiro-resume-"));
    const bin = join(cwd, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "kiro-cli"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = 'chat' ] && [ \"$2\" = '--list-sessions' ]; then",
        "  printf 'Chat sessions for %s:\\n\\n' \"$PWD\"",
        "  if [ -f started.txt ]; then",
        "    printf 'Chat SessionId: \\033[m44444444-4444-4444-8444-444444444444\\n'",
        "  fi",
        "  printf 'Chat SessionId: 99999999-9999-4999-8999-999999999999\\n'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = 'chat' ] && [ \"$2\" = '--resume-id' ]; then",
        "  printf '%s\\n' \"$3\" > resumed-session.txt",
        "  printf 'done\\n' > final.txt",
        "  echo resumed",
        "  exit 0",
        "fi",
        "exit 2",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(join(bin, "kiro-cli"), 0o755);
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(
      join(cwd, "worker.js"),
      [
        "const fs = require('fs');",
        "fs.writeFileSync('started.txt', 'ok\\n');",
        "console.log('TYCHONIC-KIRO-ONE');",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(cwd, "reviewer.js"),
      [
        "const fs = require('fs');",
        "if (fs.existsSync('final.txt')) {",
        "  console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'done',findings:[]}));",
        "} else {",
        "  console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'fail',summary:'missing final',findings:[{severity:'high',title:'Final missing',detail:'final.txt is required.',target:'final.txt'}]}));",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_kiro_resume_test",
      goal: "finish after review",
      command: "node worker.js",
      agent: "kiro",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('started.txt') ? 0 : 1)\"",
      reviewCommand: "node reviewer.js",
      autoContinue: true,
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: { ...process.env, [TYCHONIC_AGENT_PATH_ENV]: bin },
      commandTimeoutMs: 10_000
    });

    const workerSession = result.run.agent_sessions.find((session) => session.role === "worker");

    expect(result.run.status).toBe("succeeded");
    expect(workerSession?.external_session_id).toBe("44444444-4444-4444-8444-444444444444");
    expect(workerSession?.resume_command).toContain("kiro-cli");
    expect(result.run.activity_attempts.filter((attempt) => attempt.kind === "resume_work")).toHaveLength(1);
    await expect(readFile(join(result.worktreePath, "resumed-session.txt"), "utf8")).resolves.toBe(
      "44444444-4444-4444-8444-444444444444\n"
    );
  });

  it("does not attach a stale Kiro session id when list-sessions does not change", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-kiro-stale-session-"));
    const bin = join(cwd, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "kiro-cli"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = 'chat' ] && [ \"$2\" = '--list-sessions' ]; then",
        "  printf 'Chat SessionId: 99999999-9999-4999-8999-999999999999\\n'",
        "  exit 0",
        "fi",
        "exit 2",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(join(bin, "kiro-cli"), 0o755);
    await execFileAsync("git", ["init"], { cwd });

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_kiro_stale_session_test",
      command: "node -e \"require('fs').writeFileSync('started.txt', 'ok\\n'); console.log('done')\"",
      agent: "kiro",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('started.txt') ? 0 : 1)\"",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: { ...process.env, [TYCHONIC_AGENT_PATH_ENV]: bin },
      commandTimeoutMs: 10_000
    });

    const workerSession = result.run.agent_sessions.find((session) => session.role === "worker");

    expect(result.run.status).toBe("succeeded");
    expect(workerSession?.external_session_id).toBeUndefined();
    expect(workerSession?.resume_command).toBeUndefined();
  });

  it("triages structured review output missing findings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-review-triage-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_review_triage_test",
      command: "node -e \"require('fs').writeFileSync('delegated.txt', 'ok')\"",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('delegated.txt') ? 0 : 1)\"",
      reviewCommand:
        "node -e \"console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'ok'}))\"",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });

    const reviewStep = result.run.states.find((step) => step.name === "review");
    const inbox = result.run.inbox[0];

    expect(result.run.status).toBe("waiting_user");
    expect(reviewStep?.status).toBe("blocked");
    expect(result.run.findings).toHaveLength(0);
    expect(inbox?.action.kind).toBe("triage");
    expect(inbox?.detail).toMatch(/tychonic\.review\.v1/);
  });

  it.skip("captures explicit Codex worker sessions with a writable workspace sandbox", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-codex-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const fakeBin = join(cwd, "bin");
    await mkdir(fakeBin);
    await writeFile(
      join(fakeBin, "codex"),
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        "const args = process.argv.slice(2);",
        "if (!args.includes('--sandbox') || args[args.indexOf('--sandbox') + 1] !== 'workspace-write') {",
        "  console.error(`missing workspace-write sandbox: ${args.join(' ')}`);",
        "  process.exit(2);",
        "}",
        "if (!args.includes('--ask-for-approval') || args[args.indexOf('--ask-for-approval') + 1] !== 'never') process.exit(3);",
        "const outIndex = args.indexOf('--output-last-message');",
        "if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], 'codex worker done');",
        "fs.writeFileSync('delegated-codex.txt', 'ok\\n');",
        "console.log(JSON.stringify({session:{id:'019da335-e7d6-7cf1-a75c-1b7383514f91'}}));",
        "console.log(JSON.stringify({assistant:{text:'done'}}));",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(join(fakeBin, "codex"), 0o755);

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_codex_test",
      goal: "create delegated-codex.txt",
      command: "codex --ask-for-approval never exec --sandbox workspace-write --skip-git-repo-check --json",
      agent: "codex",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('delegated-codex.txt') ? 0 : 1)\"",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      commandTimeoutMs: 10_000
    });
    const persisted = result.run;
    const session = persisted.agent_sessions[0];
    const patchArtifact = persisted.artifacts.find((artifact) => artifact.kind === "worker_patch");

    expect(result.run.status).toBe("succeeded");
    expect(session?.agent).toBe("codex");
    expect(session?.external_session_id).toBe("019da335-e7d6-7cf1-a75c-1b7383514f91");
    expect(session?.resume_command).toContain("exec resume --full-auto --skip-git-repo-check --json");
    expect(session?.resume_command).toContain("019da335-e7d6-7cf1-a75c-1b7383514f91");
    expect(patchArtifact).toBeDefined();
    if (!patchArtifact) {
      throw new Error("worker_patch artifact missing");
    }
    expect(await readFile(join(cwd, patchArtifact.path), "utf8")).toContain("delegated-codex.txt");
  });

  it.skip("captures explicit Codex review sessions and sends the structured prompt on stdin", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-review-codex-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const fakeBin = join(cwd, "bin");
    await mkdir(fakeBin);
    await writeFile(
      join(fakeBin, "codex"),
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        "const args = process.argv.slice(2);",
        "const outIndex = args.indexOf('--output-last-message');",
        "const isReview = args[args.length - 1] === '-';",
        "if (isReview) {",
        "  let input = '';",
        "  process.stdin.on('data', chunk => input += chunk);",
        "  process.stdin.on('end', () => {",
        "    fs.writeFileSync('review-args.json', JSON.stringify(args));",
        "    fs.writeFileSync('review-stdin.txt', input);",
        "    if (!args.includes('--sandbox') || args[args.indexOf('--sandbox') + 1] !== 'read-only') process.exit(2);",
        "    if (!args.includes('--ask-for-approval') || args[args.indexOf('--ask-for-approval') + 1] !== 'never') process.exit(3);",
        "    const review = {schema_version:'tychonic.review.v1',status:'pass',summary:'codex review passed',findings:[]};",
        "    if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], JSON.stringify(review));",
        "    console.log(JSON.stringify({session:{id:'019da44d-35dd-7e6a-a713-a32ccb9b67a7'}}));",
        "    console.log(JSON.stringify({assistant:{text:JSON.stringify(review)}}));",
        "  });",
        "  return;",
        "}",
        "if (!args.includes('--sandbox') || args[args.indexOf('--sandbox') + 1] !== 'workspace-write') process.exit(4);",
        "if (!args.includes('--ask-for-approval') || args[args.indexOf('--ask-for-approval') + 1] !== 'never') process.exit(5);",
        "if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], 'codex worker done');",
        "fs.writeFileSync('delegated-codex.txt', 'ok\\n');",
        "console.log(JSON.stringify({session:{id:'019da44d-35dd-7e6a-a713-a32ccb9b67a8'}}));",
        "console.log(JSON.stringify({assistant:{text:'done'}}));",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(join(fakeBin, "codex"), 0o755);

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_review_codex_test",
      goal: "create delegated-codex.txt",
      command: "codex --ask-for-approval never exec --sandbox workspace-write --skip-git-repo-check --json",
      agent: "codex",
      reviewCommand: "codex --sandbox read-only --ask-for-approval never exec --skip-git-repo-check --json -",
      reviewAgent: "codex",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('delegated-codex.txt') ? 0 : 1)\"",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      commandTimeoutMs: 10_000
    });
    const persisted = result.run;
    const reviewSession = persisted.agent_sessions.find((session) => session.role === "reviewer");
    const reviewAttempt = persisted.activity_attempts.find((attempt) => attempt.kind === "semantic_review");

    expect(persisted.status).toBe("succeeded");
    expect(persisted.states.find((step) => step.name === "review")?.status).toBe("succeeded");
    expect(reviewSession?.agent).toBe("codex");
    expect(reviewSession?.external_session_id).toBe("019da44d-35dd-7e6a-a713-a32ccb9b67a7");
    expect(reviewSession?.resume_command).toContain("exec resume --skip-git-repo-check --json");
    expect(reviewAttempt?.command).toContain("codex --sandbox read-only --ask-for-approval never exec");
    expect(reviewAttempt?.command).toContain("--output-last-message");
    await expect(readFile(join(result.worktreePath, "review-stdin.txt"), "utf8")).resolves.toContain(
      '"schema_version": "tychonic.review.v1"'
    );
    await expect(readFile(join(result.worktreePath, "review-stdin.txt"), "utf8")).resolves.toContain(
      "Goal: create delegated-codex.txt"
    );
  });

  it.skip("captures Claude stream-json session ids and parses wrapped review output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-claude-stream-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const fakeBin = join(cwd, "bin");
    await mkdir(fakeBin);
    await writeFile(
      join(fakeBin, "claude"),
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        "const args = process.argv.slice(2);",
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  const isReview = fs.existsSync('delegated-claude.txt');",
        "  fs.writeFileSync(isReview ? 'claude-review-args.json' : 'claude-worker-args.json', JSON.stringify(args));",
        "  if (!args.includes('--output-format') || args[args.indexOf('--output-format') + 1] !== 'stream-json') process.exit(2);",
        "  if (isReview) {",
        "    fs.writeFileSync('claude-review-stdin.txt', input);",
        "    const review = {schema_version:'tychonic.review.v1',status:'pass',summary:'claude review passed',findings:[]};",
        "    console.log(JSON.stringify({type:'system',session_id:'11111111-1111-4111-8111-111111111111'}));",
        "    console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:JSON.stringify(review)}]}}));",
        "    return;",
        "  }",
        "  fs.writeFileSync('delegated-claude.txt', 'ok\\n');",
        "  console.log(JSON.stringify({type:'system',session_id:'22222222-2222-4222-8222-222222222222'}));",
        "  console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'worker done'}]}}));",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(join(fakeBin, "claude"), 0o755);

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_claude_stream_test",
      goal: "create delegated-claude.txt",
      command: "claude --print --output-format stream-json --verbose",
      agent: "claude",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('delegated-claude.txt') ? 0 : 1)\"",
      reviewCommand: "claude --print --output-format stream-json --verbose",
      reviewAgent: "claude",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: { HOME: cwd, PATH: "", [TYCHONIC_AGENT_PATH_ENV]: fakeBin },
      commandTimeoutMs: 10_000
    });

    const workerSession = result.run.agent_sessions.find((session) => session.role === "worker");
    const reviewSession = result.run.agent_sessions.find((session) => session.role === "reviewer");

    expect(result.run.status).toBe("succeeded");
    expect(result.run.states.find((step) => step.name === "review")?.status).toBe("succeeded");
    expect(workerSession?.external_session_id).toBe("22222222-2222-4222-8222-222222222222");
    expect(workerSession?.resume_command).toContain("--resume 22222222-2222-4222-8222-222222222222");
    expect(reviewSession?.external_session_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(reviewSession?.resume_command).toBeUndefined();
    await expect(readFile(join(result.worktreePath, "claude-review-stdin.txt"), "utf8")).resolves.toContain(
      '"schema_version": "tychonic.review.v1"'
    );
  });

  it.skip("auto-continues an explicit Codex worker when explicit Codex review fails once", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-codex-auto-review-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const fakeBin = join(cwd, "bin");
    await mkdir(fakeBin);
    await writeFile(
      join(fakeBin, "codex"),
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        "const args = process.argv.slice(2);",
        "const outIndex = args.indexOf('--output-last-message');",
        "const writeLast = (value) => { if (outIndex >= 0) fs.writeFileSync(args[outIndex + 1], value); };",
        "const emitSession = (id, text) => {",
        "  console.log(JSON.stringify({session:{id}}));",
        "  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));",
        "};",
        "const readStdin = (callback) => {",
        "  let input = '';",
        "  process.stdin.on('data', chunk => input += chunk);",
        "  process.stdin.on('end', () => callback(input));",
        "};",
        "const isResume = args[0] === 'exec' && args[1] === 'resume';",
        "const isReview = !isResume && args[args.length - 1] === '-';",
        "if (isResume) {",
        "  readStdin((input) => {",
        "    fs.writeFileSync('resume-args.json', JSON.stringify(args));",
        "    fs.writeFileSync('resume-stdin.txt', input);",
        "    if (args[args.length - 1] !== '-') process.exit(10);",
        "    if (!input.includes('Final marker missing')) process.exit(11);",
        "    fs.writeFileSync('final.txt', 'done\\n');",
        "    writeLast('resume done');",
        "    emitSession('019da55d-35dd-7e6a-a713-a32ccb9b67a8', 'resume done');",
        "  });",
        "  return;",
        "}",
        "if (isReview) {",
        "  readStdin((input) => {",
        "    fs.appendFileSync('review-stdin.txt', input + '\\n---\\n');",
        "    if (!args.includes('--sandbox') || args[args.indexOf('--sandbox') + 1] !== 'read-only') process.exit(12);",
        "    if (!input.includes('Goal: create final marker after review feedback')) process.exit(13);",
        "    const review = fs.existsSync('final.txt')",
        "      ? {schema_version:'tychonic.review.v1',status:'pass',summary:'complete',findings:[]}",
        "      : {schema_version:'tychonic.review.v1',status:'fail',summary:'needs continuation',findings:[{severity:'high',title:'Final marker missing',detail:'Create final.txt before the task is complete.',target:'final.txt'}]};",
        "    const text = JSON.stringify(review);",
        "    writeLast(text);",
        "    emitSession('019da55d-35dd-7e6a-a713-a32ccb9b67a7', text);",
        "  });",
        "  return;",
        "}",
        "if (!args.includes('--sandbox') || args[args.indexOf('--sandbox') + 1] !== 'workspace-write') process.exit(14);",
        "if (!args.includes('--ask-for-approval') || args[args.indexOf('--ask-for-approval') + 1] !== 'never') process.exit(15);",
        "readStdin((input) => {",
        "  fs.writeFileSync('worker-prompt.txt', input);",
        "  fs.writeFileSync('started.txt', 'ok\\n');",
        "  writeLast('worker done');",
        "  emitSession('019da55d-35dd-7e6a-a713-a32ccb9b67a6', 'worker done');",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );
    await chmod(join(fakeBin, "codex"), 0o755);

    const result = await runSimpleWorkflow({
      cwd,
      runId: "delegate_codex_review_auto_test",
      goal: "create final marker after review feedback",
      command: "codex --ask-for-approval never exec --sandbox workspace-write --skip-git-repo-check --json",
      agent: "codex",
      reviewCommand: "codex --sandbox read-only --ask-for-approval never exec --skip-git-repo-check --json -",
      reviewAgent: "codex",
      autoContinue: true,
      maxIterations: 2,
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('started.txt') ? 0 : 1)\"",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      commandTimeoutMs: 10_000
    });
    const persisted = result.run;
    const resumeArgs = JSON.parse(await readFile(join(result.worktreePath, "resume-args.json"), "utf8")) as string[];
    const patchArtifact = [...persisted.artifacts].reverse().find((artifact) => artifact.kind === "worker_patch");

    expect(persisted.status).toBe("succeeded");
    expect(persisted.states.filter((step) => step.name === "review")).toHaveLength(2);
    const verifyArtifacts = persisted.artifacts.filter((artifact) => artifact.kind === "verify_output");
    expect(verifyArtifacts).toHaveLength(2);
    expect(new Set(verifyArtifacts.map((artifact) => artifact.path)).size).toBe(2);
    expect(persisted.states.find((step) => step.name === "auto_continue")?.status).toBe("succeeded");
    expect(persisted.inbox.every((item) => item.status !== "open")).toBe(true);
    expect(resumeArgs[resumeArgs.length - 1]).toBe("-");
    await expect(readFile(join(result.worktreePath, "resume-stdin.txt"), "utf8")).resolves.toContain(
      "Final marker missing"
    );
    await expect(readFile(join(result.worktreePath, "resume-stdin.txt"), "utf8")).resolves.toContain(
      "Do not launch multiple shell or tool commands in parallel."
    );
    await expect(readFile(join(result.worktreePath, "resume-stdin.txt"), "utf8")).resolves.toContain(
      "use exactly one shell invocation at a time."
    );
    await expect(readFile(join(result.worktreePath, "worker-prompt.txt"), "utf8")).resolves.toContain(
      "Do not launch multiple shell or tool commands in parallel."
    );
    await expect(readFile(join(result.worktreePath, "worker-prompt.txt"), "utf8")).resolves.toContain(
      "use exactly one shell invocation at a time."
    );
    await expect(readFile(join(result.worktreePath, "worker-prompt.txt"), "utf8")).resolves.toContain(
      "Prefer direct file inspection and targeted edits over command-based validation."
    );
    await expect(readFile(join(result.worktreePath, "worker-prompt.txt"), "utf8")).resolves.toContain(
      "Do not run npm, pnpm, yarn, vitest, or other package-manager/test/build commands during this work turn unless the goal explicitly requires them."
    );
    await expect(readFile(join(result.worktreePath, "final.txt"), "utf8")).resolves.toBe("done\n");
    expect(patchArtifact).toBeDefined();
    if (!patchArtifact) {
      throw new Error("worker_patch artifact missing");
    }
    expect(await readFile(join(cwd, patchArtifact.path), "utf8")).toContain("final.txt");
  });

  it("rejects conflicting review candidate selection before creating a run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-review-conflict-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    await expect(
      runSimpleWorkflow({
        cwd,
        runId: "delegate_review_conflict_test",
        command: "node -e \"process.exit(0)\"",
        verifyCommand: "node -e \"process.exit(0)\"",
        reviewCommand: "node -e \"process.exit(0)\"",
        reviewCandidates: [{ agent: "reviewer", command: "node reviewer.js" }],
        now: () => new Date("2026-04-19T00:00:00.000Z"),
        env: process.env,
        commandTimeoutMs: 10_000
      })
    ).rejects.toThrow("simple_workflow review candidates own their agent labels and commands");
    await expect(access(join(cwd, ".tychonic"))).rejects.toThrow();
  });

  it("rejects ignored auto-continue loop options", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-auto-ignored-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    await expect(
      runSimpleWorkflow({
        cwd,
        command: "node -e \"process.exit(0)\"",
        verifyCommand: "node -e \"process.exit(0)\"",
        autoContinue: true,
        now: () => new Date("2026-04-19T00:00:00.000Z"),
        env: process.env,
        commandTimeoutMs: 10_000
      })
    ).rejects.toThrow("simple_workflow --auto-continue requires --review-command");

    await expect(
      runSimpleWorkflow({
        cwd,
        command: "node -e \"process.exit(0)\"",
        verifyCommand: "node -e \"process.exit(0)\"",
        maxIterations: 2,
        now: () => new Date("2026-04-19T00:00:00.000Z"),
        env: process.env,
        commandTimeoutMs: 10_000
      })
    ).rejects.toThrow("simple_workflow --max-iterations requires --auto-continue");
  });

  it("rejects removed built-in review flags through the generic run CLI", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-review-cli-conflict-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    await expect(
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          cliPath,
          "run",
          "customWorkflow",
          "--review-codex",
          "--input",
          JSON.stringify({ cwd })
        ],
        { cwd: projectRoot, encoding: "utf8" }
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("unknown option '--review-codex'")
    });
    await expect(access(join(cwd, ".tychonic"))).rejects.toThrow();
  });
});
