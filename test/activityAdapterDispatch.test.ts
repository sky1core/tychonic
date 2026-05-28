import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkerActivity } from "../src/activities/runWorkerActivity.js";
import { runReviewActivity } from "../src/activities/runReviewActivity.js";
import { claudeAdapter } from "../src/adapters/openp.js";
import { TYCHONIC_AGENT_PATH_ENV } from "../src/bootstrap/executables.js";
import type { TychonicConfig } from "../src/catalog/types.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";

/**
 * Activity-side tests for adapter selector dispatch.
 *
 * Valid selector paths under test:
 *   - block.command -> verbatim. Adapter NOT called.
 *   - block.agent   -> adapter dispatch.
 *
 * Each test asserts the spawned `attempt.command` because that string is
 * exactly what the activity passed to `runCommand`. The stub binaries
 * planted on `TYCHONIC_AGENT_PATH` keep tests hermetic — adapter dispatch
 * resolves to our stubs, never to a real CLI on the developer machine.
 */

const WORK_NAME = "work_disp";
const REVIEW_NAME = "review_disp";
const execFileAsync = promisify(execFile);

let originalAgentPath: string | undefined;
let stubBinDir: string;

beforeEach(async () => {
  originalAgentPath = process.env[TYCHONIC_AGENT_PATH_ENV];
  stubBinDir = await mkdtemp(join(tmpdir(), "tychonic-adapter-dispatch-bin-"));
  await writeStubBinary(join(stubBinDir, "openp"));
  await writeStubBinary(join(stubBinDir, "claude"));
  await writeStubBinary(join(stubBinDir, "codex"));
  await writeStubBinary(join(stubBinDir, "kiro-cli"));
  process.env[TYCHONIC_AGENT_PATH_ENV] = stubBinDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalAgentPath === undefined) {
    delete process.env[TYCHONIC_AGENT_PATH_ENV];
  } else {
    process.env[TYCHONIC_AGENT_PATH_ENV] = originalAgentPath;
  }
});

function quotedStub(name: string): string {
  return `'${join(stubBinDir, name)}'`;
}

describe("runWorkerActivity adapter dispatch", () => {
  it("verbatim block.command path: adapter is NOT called", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-verbatim-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-verbatim-wt-"));

    const result = await runWorkerActivity({
      stateName: WORK_NAME,
      run: baseRun("disp_worker_verbatim"),
      cwd,
      profile: workProfile({ command: "node -e \"console.log('verbatim ok')\"" }),
      worktreePath,
      prompt: ""
    });

    const command = result.delta.activityAttempts?.[0]?.command;
    expect(command).toBe("node -e \"console.log('verbatim ok')\"");
    // Verbatim path must not generate adapter argv:
    expect(command).not.toContain("--output-format");
    expect(command).not.toContain("--permission-mode");
  });

  it("block.agent built-in (claude) with no command -> dispatches via claudeAdapter.runNew", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-claude-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-claude-wt-"));

    const result = await runWorkerActivity({
      stateName: WORK_NAME,
      run: baseRun("disp_worker_claude"),
      cwd,
      profile: workProfile({ agent: "claude" }),
      worktreePath,
      prompt: "do work"
    });

    const command = result.delta.activityAttempts?.[0]?.command;
    expect(command).toBe(
      `${quotedStub("openp")} claude --timeout 0 --output-format stream-json`
    );
    if (result.workerOutcome?.kind !== "executed") throw new Error("expected executed outcome");
    expect(result.workerOutcome.agentSessions[0]?.agent).toBe("claude");
    expect(result.workerOutcome.agentSessions[0]?.id).toBe("stub-session-id");
    expect(result.workerOutcome.agentSessions[0]?.resumable).toBe(true);
    expect(result.delta.activityAttempts?.[0]?.agent_session_id).toBe("stub-session-id");
  });

  it("passes declared agent model and reasoning effort into adapter dispatch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-agent-settings-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-agent-settings-wt-"));

    const result = await runWorkerActivity({
      stateName: WORK_NAME,
      run: baseRun("disp_worker_agent_settings"),
      cwd,
      profile: workProfile({
        agent: "claude",
        model: "opus",
        reasoning_effort: "max"
      }),
      worktreePath,
      prompt: "do work"
    });

    expect(result.delta.activityAttempts?.[0]?.command).toContain(
      "--model 'opus' --effort 'max'"
    );
  });

  it("fails a Claude worker when the reported model differs from the requested model", async () => {
    await writeClaudeModelReportingStubBinary(join(stubBinDir, "openp"), "claude-opus-4-5");
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-model-mismatch-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-model-mismatch-wt-"));

    const result = await runWorkerActivity({
      stateName: WORK_NAME,
      run: baseRun("disp_worker_model_mismatch"),
      cwd,
      profile: workProfile({
        agent: "claude",
        model: "claude-opus-4-8"
      }),
      worktreePath,
      prompt: "do work"
    });

    expect(result.delta.activityAttempts?.[0]?.command).toContain("--model 'claude-opus-4-8'");
    expect(result.delta.states?.[0]?.status).toBe("failed");
    expect(result.delta.states?.[0]?.reason).toContain(
      "reported model 'claude-opus-4-5' but state config requested model 'claude-opus-4-8'"
    );
    if (result.workerOutcome?.kind !== "executed") throw new Error("expected executed outcome");
    expect(result.workerOutcome.status).toBe("failed");
    expect(result.workerOutcome.agentSessions[0]?.id).toBe("stub-session-id");
    expect(result.workerOutcome.agentSessions[0]?.status).toBe("failed");
  });

  it("does not reject Claude alias model names when the CLI reports a concrete version", async () => {
    await writeClaudeModelReportingStubBinary(join(stubBinDir, "openp"), "claude-opus-4-8");
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-model-alias-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-model-alias-wt-"));

    const result = await runWorkerActivity({
      stateName: WORK_NAME,
      run: baseRun("disp_worker_model_alias"),
      cwd,
      profile: workProfile({
        agent: "claude",
        model: "opus"
      }),
      worktreePath,
      prompt: "do work"
    });

    expect(result.delta.activityAttempts?.[0]?.command).toContain("--model 'opus'");
    expect(result.delta.states?.[0]?.status).toBe("succeeded");
    if (result.workerOutcome?.kind !== "executed") throw new Error("expected executed outcome");
    expect(result.workerOutcome.agentSessions[0]?.id).toBe("stub-session-id");
    expect(result.workerOutcome.agentSessions[0]?.status).toBe("succeeded");
  });

  it("rejects an unvalidated non-built-in agent before command resolution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-missing-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-missing-wt-"));

    await expect(
      runWorkerActivity({
        stateName: WORK_NAME,
        run: baseRun("disp_worker_missing"),
        cwd,
        profile: workProfile({ agent: "custom-non-builtin" }),
        worktreePath,
        prompt: ""
      })
    ).rejects.toThrow(/profile\.states\.work_disp failed schema validation/);
  });

  it("block.agent built-in (kiro) dispatches via openp kiro with dangerously-skip-permissions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-kiro-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-kiro-wt-"));

    const result = await runWorkerActivity({
      stateName: WORK_NAME,
      run: baseRun("disp_worker_kiro"),
      cwd,
      profile: workProfile({ agent: "kiro" }),
      worktreePath,
      prompt: "do kiro work"
    });

    const command = result.delta.activityAttempts?.[0]?.command ?? "";
    expect(command).toBe(
      `${quotedStub("openp")} kiro --timeout 0 --output-format stream-json --dangerously-skip-permissions`
    );
    if (result.workerOutcome?.kind !== "executed") throw new Error("expected executed outcome");
    expect(result.workerOutcome.agentSessions[0]?.agent).toBe("kiro");
    expect(result.workerOutcome.agentSessions[0]?.id).toBe("stub-session-id");
    expect(result.workerOutcome.agentSessions[0]?.resumable).toBe(true);
    expect(result.delta.activityAttempts?.[0]?.agent_session_id).toBe("stub-session-id");
  });

  it("resumes a Kiro worker session through openp kiro --resume", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-kiro-resume-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-kiro-resume-wt-"));
    const run = baseRun("disp_worker_kiro_resume");
    run.agent_sessions.push({
      id: "kiro-prev-session",
      agent: "kiro",
      role: "worker",
      cwd: worktreePath,
      status: "succeeded",
      resumable: true,
      started_at: "2026-04-26T00:00:00.000Z",
      finished_at: "2026-04-26T00:00:01.000Z"
    });

    const result = await runWorkerActivity({
      stateName: WORK_NAME,
      run,
      cwd,
      profile: workProfile({ agent: "kiro" }),
      worktreePath,
      prompt: "resume kiro work",
      sessionId: "kiro-prev-session"
    });

    const command = result.delta.activityAttempts?.[0]?.command ?? "";
    expect(command).toBe(
      `${quotedStub("openp")} kiro --timeout 0 --output-format stream-json --dangerously-skip-permissions --resume 'kiro-prev-session'`
    );
    expect(result.delta.activityAttempts?.[0]?.kind).toBe("resume_work");
    expect(result.workerOutcome?.kind).toBe("executed");
    if (result.workerOutcome?.kind !== "executed") throw new Error("expected executed outcome");
    expect(result.workerOutcome.resumedSessionId).toBe("kiro-prev-session");
  });
});

describe("runReviewActivity adapter dispatch", () => {
  it("verbatim block.command path: adapter is NOT called", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-verbatim-"));
    await initGitWorktree(cwd);

    const result = await runReviewActivity({
      stateName: REVIEW_NAME,
      run: baseRun("disp_review_verbatim"),
      cwd,
      profile: reviewProfile({
        command:
          "node -e \"console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'ok',findings:[]}))\""
      }),
      prompt: "review please"
    });

    const command = result.delta.activityAttempts?.[0]?.command ?? "";
    expect(command.startsWith("node -e ")).toBe(true);
    expect(command).not.toContain("--permission-mode");
  });

  it("block.agent built-in (claude) with no command -> dispatches via claudeAdapter.runNew with role review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-claude-"));
    await initGitWorktree(cwd);

    // Adapter dispatches the resolved OpenP executable with Claude backend.
    // The stub OpenP
    // binary emits a session id but no review payload, so the review body
    // blocks on parsing while still preserving the adapter-owned session id.
    const result = await runReviewActivity({
      stateName: REVIEW_NAME,
      run: baseRun("disp_review_claude"),
      cwd,
      profile: {
        version: "tychonic.config.v1",
        states: {
          [REVIEW_NAME]: {
            type: "review",
            on_fail_return_to: WORK_NAME,
            agent: "claude"
          }
        }
      },
      prompt: "review please"
    });

    const command = result.delta.activityAttempts?.[0]?.command ?? "";
    expect(command).toContain(`${quotedStub("openp")} claude --timeout 0 --output-format stream-json`);
    expect(command).not.toContain("--permission-mode");
    expect(command).not.toContain("--verbose");
    expect(command).not.toContain("--tools");
    expect(command).toContain("--json-schema");
    expect(command).not.toContain("tychonic.review.v1");
    expect(result.delta.activityAttempts?.[0]?.agent_session_id).toBe("stub-session-id");
    expect(result.reviewOutcome?.kind).toBe("unparseable");
    if (result.reviewOutcome?.kind !== "unparseable") throw new Error("expected unparseable outcome");
    expect(result.reviewOutcome.reviewerSessionId).toBe("stub-session-id");
    expect(result.reviewOutcome.agentSessions[0]?.id).toBe("stub-session-id");
  });

  it("block.agent built-in (claude) parses structuredOutput through the review activity path", async () => {
    await writeClaudeStructuredReviewStubBinary(join(stubBinDir, "openp"));
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-claude-structured-"));
    await initGitWorktree(cwd);
    const run = baseRun("disp_review_claude_structured", cwd);

    const result = await runReviewActivity({
      stateName: REVIEW_NAME,
      run,
      cwd,
      profile: reviewProfile({ agent: "claude" }),
      prompt: "review please"
    });

    const command = result.delta.activityAttempts?.[0]?.command ?? "";
    expect(command).toContain(`${quotedStub("openp")} claude --timeout 0 --output-format stream-json`);
    expect(command).not.toContain("--permission-mode");
    expect(command).not.toContain("--verbose");
    expect(command).not.toContain("--tools");
    expect(command).toContain("--json-schema");
    expect(result.delta.states?.[0]?.status).toBe("succeeded");
    expect(result.delta.activityAttempts?.[0]?.agent_session_id).toBe("structured-session-id");
    expect(result.reviewOutcome?.kind).toBe("parsed");
    if (result.reviewOutcome?.kind !== "parsed") throw new Error("expected parsed outcome");
    expect(result.reviewOutcome.result.status).toBe("pass");
    expect(result.reviewOutcome.reviewerSessionId).toBe("structured-session-id");
    expect(result.reviewOutcome.agentSessions[0]?.id).toBe("structured-session-id");

    const promptArtifact = result.reviewOutcome.artifacts.find(
      (artifact) => artifact.kind === `${REVIEW_NAME}_prompt`
    );
    if (!promptArtifact) throw new Error("expected review prompt artifact");
    const promptArtifactText = await readFile(join(run.artifact_root!, promptArtifact.path), "utf8");
    expect(promptArtifactText).toContain("review please");
    expect(promptArtifactText).toContain("Tychonic structured review output contract");
    expect(promptArtifactText).toContain("Return exactly one JSON object only");
    expect(promptArtifactText).toContain("Use null for target or target_session_id when unknown");
    expect(promptArtifactText).toContain("findings are actionable problems only");

    const parsedArtifact = result.reviewOutcome.artifacts.find(
      (artifact) => artifact.kind === `${REVIEW_NAME}_parsed`
    );
    if (!parsedArtifact) throw new Error("expected parsed review artifact");
    const parsedArtifactText = await readFile(join(run.artifact_root!, parsedArtifact.path), "utf8");
    expect(JSON.parse(parsedArtifactText)).toMatchObject({
      schema_version: "tychonic.review.v1",
      status: "pass",
      summary: "structured review passed",
      findings: []
    });
  });

  it("block.agent built-in (claude) parses terminal structuredOutput after large tool output", async () => {
    await writeClaudeStructuredReviewStubBinary(join(stubBinDir, "openp"), undefined, 1_100_000);
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-claude-structured-large-"));
    await initGitWorktree(cwd);

    const result = await runReviewActivity({
      stateName: REVIEW_NAME,
      run: baseRun("disp_review_claude_structured_large"),
      cwd,
      profile: reviewProfile({ agent: "claude" }),
      prompt: "review please"
    });

    expect(result.delta.states?.[0]?.status).toBe("succeeded");
    expect(result.reviewOutcome?.kind).toBe("parsed");
    if (result.reviewOutcome?.kind !== "parsed") throw new Error("expected parsed outcome");
    expect(result.reviewOutcome.result.status).toBe("pass");
  });

  it("fails a Claude review when the reported model differs from the requested model", async () => {
    await writeClaudeStructuredReviewStubBinary(join(stubBinDir, "openp"), "claude-opus-4-5");
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-model-mismatch-"));
    await initGitWorktree(cwd);

    const result = await runReviewActivity({
      stateName: REVIEW_NAME,
      run: baseRun("disp_review_model_mismatch"),
      cwd,
      profile: reviewProfile({
        agent: "claude",
        model: "claude-opus-4-8"
      }),
      prompt: "review please"
    });

    expect(result.delta.activityAttempts?.[0]?.command).toContain("--model 'claude-opus-4-8'");
    expect(result.delta.states?.[0]?.status).toBe("failed");
    expect(result.delta.states?.[0]?.reason).toContain(
      "reported model 'claude-opus-4-5' but state config requested model 'claude-opus-4-8'"
    );
    expect(result.reviewOutcome?.kind).toBe("command_failed");
    if (result.reviewOutcome?.kind !== "command_failed") throw new Error("expected command_failed outcome");
    expect(result.reviewOutcome.reviewerSessionId).toBe("structured-session-id");
    expect(result.reviewOutcome.agentSessions[0]?.status).toBe("failed");
  });

  it("block.agent built-in (codex) parses OpenP structuredOutput through the review activity path", async () => {
    await writeCodexSemanticReviewStubBinary(join(stubBinDir, "openp"));
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-codex-semantic-"));
    await initGitWorktree(cwd);

    const result = await runReviewActivity({
      stateName: REVIEW_NAME,
      run: baseRun("disp_review_codex_semantic"),
      cwd,
      profile: reviewProfile({ agent: "codex" }),
      prompt: "review please"
    });

    const command = result.delta.activityAttempts?.[0]?.command ?? "";
    expect(command).toContain(
      `${quotedStub("openp")} codex --timeout 0 --output-format stream-json --dangerously-skip-permissions --json-schema`
    );
    expect(command).not.toContain("--permission-mode");
    expect(result.delta.states?.[0]?.status).toBe("succeeded");
    expect(result.delta.activityAttempts?.[0]?.agent_session_id).toBe("codex-structured-thread-id");
    expect(result.reviewOutcome?.kind).toBe("parsed");
    if (result.reviewOutcome?.kind !== "parsed") throw new Error("expected parsed outcome");
    expect(result.reviewOutcome.result.status).toBe("pass");
    expect(result.reviewOutcome.result.schema_version).toBe("tychonic.review.v1");
    expect(result.reviewOutcome.reviewerSessionId).toBe("codex-structured-thread-id");
  });

  it("runs a partial review adapter through the declared normalizer", async () => {
    await writeClaudeStructuredReviewWithCwdStubBinary(join(stubBinDir, "openp"));
    const normalizerSpy = vi.spyOn(claudeAdapter, "runNew");
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-kiro-normalized-"));
    const worktreePath = await mkdtemp(
      join(tmpdir(), "tychonic-disp-review-kiro-normalized-wt-")
    );
    await initGitWorktree(worktreePath);
    const run = baseRun("disp_review_kiro_normalized", cwd);

    const result = await runReviewActivity({
      stateName: REVIEW_NAME,
      run,
      cwd,
      worktreePath,
      profile: reviewProfile({ agent: "kiro", normalizer: "claude" }),
      prompt: "review please"
    });

    const command = result.delta.activityAttempts?.[0]?.command ?? "";
    expect(command).toContain(`${quotedStub("openp")} kiro --timeout 0 --output-format stream-json`);
    expect(command).not.toContain("--dangerously-skip-permissions");
    expect(normalizerSpy.mock.calls.at(-1)?.[0].executablePaths?.openp).toBe(
      join(stubBinDir, "openp")
    );
    expect(result.reviewOutcome?.kind).toBe("parsed");
    if (result.reviewOutcome?.kind !== "parsed") throw new Error("expected parsed outcome");
    expect(result.reviewOutcome.result.status).toBe("pass");
    expect(result.reviewOutcome.reviewerSessionId).toBe("structured-session-id");
    expect(result.reviewOutcome.agentSessions.map((session) => session.agent)).toEqual([
      "kiro",
      "claude"
    ]);
    expect(result.reviewOutcome.artifacts.map((artifact) => artifact.kind)).toEqual([
      `${REVIEW_NAME}_prompt`,
      `${REVIEW_NAME}_output`,
      `${REVIEW_NAME}_normalizer_prompt`,
      `${REVIEW_NAME}_normalizer_output`,
      `${REVIEW_NAME}_parsed`
    ]);
    const normalizerOutputArtifact = result.reviewOutcome.artifacts.find(
      (artifact) => artifact.kind === `${REVIEW_NAME}_normalizer_output`
    );
    if (!normalizerOutputArtifact) throw new Error("expected normalizer output artifact");
    const normalizerOutputText = await readFile(join(run.artifact_root!, normalizerOutputArtifact.path), "utf8");
    expect(normalizerOutputText).toContain("NORMALIZER_CWD:");
    expect(normalizerOutputText).toContain("ARGV:claude --timeout 0 --model haiku --output-format");
    expect(normalizerOutputText).not.toContain(cwd);
    expect(normalizerOutputText).not.toContain(worktreePath);
    const normalizerSession = result.reviewOutcome.agentSessions.find(
      (session) => session.agent === "claude"
    );
    expect(normalizerSession?.cwd).toContain("tychonic-review-normalizer-");
    expect(normalizerSession?.cwd).not.toBe(cwd);
    expect(normalizerSession?.cwd).not.toBe(worktreePath);
  });

  it("maps trust_all_tools to --dangerously-skip-permissions for Kiro review", async () => {
    await writeClaudeStructuredReviewWithCwdStubBinary(join(stubBinDir, "openp"));
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-kiro-tool-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-review-kiro-tool-wt-"));
    await initGitWorktree(worktreePath);

    const result = await runReviewActivity({
      stateName: REVIEW_NAME,
      run: baseRun("disp_review_kiro_tool_boundary"),
      cwd,
      worktreePath,
      profile: reviewProfile({
        agent: "kiro",
        normalizer: "claude",
        trust_all_tools: true
      }),
      prompt: "review and run checks"
    });

    const command = result.delta.activityAttempts?.[0]?.command ?? "";
    expect(command).toContain("--dangerously-skip-permissions");
    expect(result.reviewOutcome?.kind).toBe("parsed");
  });

  it("keeps review mutation guard active when PATH points at the git executable directory", async () => {
    const { stdout: gitPathOutput } = await execFileAsync("/bin/sh", ["-lc", "command -v git"]);
    const gitPath = gitPathOutput.trim();
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-git-path-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-review-git-path-wt-"));
    await initGitWorktree(worktreePath);
    const run = baseRun("disp_review_git_path_guard");
    const originalPath = process.env.PATH;
    process.env.PATH = dirname(gitPath);
    try {
      const result = await runReviewActivity({
        stateName: REVIEW_NAME,
        run,
        cwd,
        worktreePath,
        profile: reviewProfile({
          command: `'${process.execPath}' -e "require('node:fs').writeFileSync('README.md', 'mutated by review\\\\n'); console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'ok',findings:[]}))"`
        }),
        prompt: "review please"
      });

      if (result.reviewOutcome?.kind !== "command_failed") {
        throw new Error("expected command_failed outcome");
      }
      const outputArtifact = result.reviewOutcome.artifacts.find(
        (artifact) => artifact.kind === `${REVIEW_NAME}_output`
      );
      if (!outputArtifact) throw new Error("expected output artifact");
      const outputText = await readFile(join(run.artifact_root!, outputArtifact.path), "utf8");
      expect(result.delta.states?.[0]?.reason).toContain("review mutation guard failed");
      expect(outputText).toContain("review mutation guard failed: review changed the git worktree");
      expect(result.delta.activityAttempts?.[0]?.status).toBe("failed");
    } finally {
      restoreEnv("PATH", originalPath);
    }
  });

  it("fails a git worktree review before running the reviewer when git is unavailable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-git-missing-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-review-git-missing-wt-"));
    await initGitWorktree(worktreePath);
    const run = baseRun("disp_review_git_missing_guard");
    const originalPath = process.env.PATH;
    process.env.PATH = "/definitely/missing";
    try {
      const result = await runReviewActivity({
        stateName: REVIEW_NAME,
        run,
        cwd,
        worktreePath,
        profile: reviewProfile({
          command: `'${process.execPath}' -e "require('node:fs').writeFileSync('review-ran.txt', 'ran'); console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'ok',findings:[]}))"`
        }),
        prompt: "review please"
      });

      if (result.reviewOutcome?.kind !== "command_failed") {
        throw new Error("expected command_failed outcome");
      }
      const outputArtifact = result.reviewOutcome.artifacts.find(
        (artifact) => artifact.kind === `${REVIEW_NAME}_output`
      );
      if (!outputArtifact) throw new Error("expected output artifact");
      const outputText = await readFile(join(run.artifact_root!, outputArtifact.path), "utf8");
      expect(outputText).toContain("review mutation guard failed before reviewer command");
      expect(outputText).toContain("git executable was not found");
      expect(result.delta.states?.[0]?.reason).toContain("review mutation guard failed before reviewer command");
      expect(result.reviewOutcome.reason).toContain("git executable was not found");
      await expect(readFile(join(worktreePath, "review-ran.txt"), "utf8")).rejects.toThrow();
    } finally {
      restoreEnv("PATH", originalPath);
    }
  });

  it("fails a git worktree review before running the reviewer when PATH git is not executable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-git-not-exec-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-review-git-not-exec-wt-"));
    await initGitWorktree(worktreePath);
    const run = baseRun("disp_review_git_not_exec_guard");
    const gitDir = join(cwd, "bad-bin");
    const gitPath = join(gitDir, "git");
    const originalPath = process.env.PATH;
    process.env.PATH = gitDir;
    try {
      await mkdir(gitDir, { recursive: true });
      await writeFile(gitPath, "#!/bin/sh\n", "utf8");
      const result = await runReviewActivity({
        stateName: REVIEW_NAME,
        run,
        cwd,
        worktreePath,
        profile: reviewProfile({
          command: `'${process.execPath}' -e "require('node:fs').writeFileSync('review-ran.txt', 'ran'); console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'ok',findings:[]}))"`
        }),
        prompt: "review please"
      });

      if (result.reviewOutcome?.kind !== "command_failed") {
        throw new Error("expected command_failed outcome");
      }
      const outputArtifact = result.reviewOutcome.artifacts.find(
        (artifact) => artifact.kind === `${REVIEW_NAME}_output`
      );
      if (!outputArtifact) throw new Error("expected output artifact");
      const outputText = await readFile(join(run.artifact_root!, outputArtifact.path), "utf8");
      expect(outputText).toContain("review mutation guard failed before reviewer command");
      expect(outputText).toContain("git executable was not found");
      expect(result.delta.states?.[0]?.reason).toContain("review mutation guard failed before reviewer command");
      expect(result.reviewOutcome.reason).toContain("git executable was not found");
      await expect(readFile(join(worktreePath, "review-ran.txt"), "utf8")).rejects.toThrow();
    } finally {
      restoreEnv("PATH", originalPath);
    }
  });

  it("fails a git worktree review before running the reviewer when PATH git is not git", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-git-fake-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-review-git-fake-wt-"));
    await initGitWorktree(worktreePath);
    const run = baseRun("disp_review_git_fake_guard");
    const gitDir = join(cwd, "fake-bin");
    const gitPath = join(gitDir, "git");
    const originalPath = process.env.PATH;
    process.env.PATH = gitDir;
    try {
      await mkdir(gitDir, { recursive: true });
      await writeFile(gitPath, "#!/bin/sh\necho not-git\n", "utf8");
      await chmod(gitPath, 0o755);
      const result = await runReviewActivity({
        stateName: REVIEW_NAME,
        run,
        cwd,
        worktreePath,
        profile: reviewProfile({
          command: `'${process.execPath}' -e "require('node:fs').writeFileSync('review-ran.txt', 'ran'); console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'ok',findings:[]}))"`
        }),
        prompt: "review please"
      });

      if (result.reviewOutcome?.kind !== "command_failed") {
        throw new Error("expected command_failed outcome");
      }
      const outputArtifact = result.reviewOutcome.artifacts.find(
        (artifact) => artifact.kind === `${REVIEW_NAME}_output`
      );
      if (!outputArtifact) throw new Error("expected output artifact");
      const outputText = await readFile(join(run.artifact_root!, outputArtifact.path), "utf8");
      expect(outputText).toContain("review mutation guard failed before reviewer command");
      expect(outputText).toContain("git executable did not report a git version");
      expect(result.delta.states?.[0]?.reason).toContain("review mutation guard failed before reviewer command");
      expect(result.reviewOutcome.reason).toContain("git executable did not report a git version");
      await expect(readFile(join(worktreePath, "review-ran.txt"), "utf8")).rejects.toThrow();
    } finally {
      restoreEnv("PATH", originalPath);
    }
  });

  it("fails a non-git review cwd before running the reviewer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-non-git-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-review-non-git-wt-"));
    const run = baseRun("disp_review_non_git_guard");

    const result = await runReviewActivity({
      stateName: REVIEW_NAME,
      run,
      cwd,
      worktreePath,
      profile: reviewProfile({
        command: `'${process.execPath}' -e "require('node:fs').writeFileSync('review-ran.txt', 'ran'); console.log(JSON.stringify({schema_version:'tychonic.review.v1',status:'pass',summary:'ok',findings:[]}))"`
      }),
      prompt: "review please"
    });

    if (result.reviewOutcome?.kind !== "command_failed") {
      throw new Error("expected command_failed outcome");
    }
    const outputArtifact = result.reviewOutcome.artifacts.find(
      (artifact) => artifact.kind === `${REVIEW_NAME}_output`
    );
    if (!outputArtifact) throw new Error("expected output artifact");
    const outputText = await readFile(join(run.artifact_root!, outputArtifact.path), "utf8");
    expect(outputText).toContain("review mutation guard failed before reviewer command");
    expect(outputText).toContain("git metadata was not found under review cwd");
    expect(result.delta.states?.[0]?.reason).toContain("review mutation guard failed before reviewer command");
    expect(result.reviewOutcome.reason).toContain("git metadata was not found under review cwd");
    await expect(readFile(join(worktreePath, "review-ran.txt"), "utf8")).rejects.toThrow();
  });

  it("rejects an unvalidated review agent before skip handling", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-skip-"));

    await expect(
      runReviewActivity({
        stateName: REVIEW_NAME,
        run: baseRun("disp_review_skip"),
        cwd,
        profile: {
          version: "tychonic.config.v1",
          states: {
            [REVIEW_NAME]: {
              type: "review",
              on_fail_return_to: WORK_NAME,
              agent: "custom-non-builtin"
            }
          }
        },
        prompt: "review please"
      })
    ).rejects.toThrow(/profile\.states\.review_disp failed schema validation/);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function workProfile(args: {
  agent?: string;
  command?: string;
  model?: string;
  reasoning_effort?: string;
  trust_all_tools?: boolean;
}): TychonicConfig {
  const block: Record<string, unknown> = { type: "work" };
  if (args.agent !== undefined) block.agent = args.agent;
  if (args.command !== undefined) block.command = args.command;
  if (args.model !== undefined) block.model = args.model;
  if (args.reasoning_effort !== undefined) block.reasoning_effort = args.reasoning_effort;
  if (args.trust_all_tools !== undefined) block.trust_all_tools = args.trust_all_tools;
  return {
    version: "tychonic.config.v1",
    states: { [WORK_NAME]: block as never }
  };
}

function reviewProfile(args: {
  agent?: string;
  normalizer?: string;
  command?: string;
  model?: string;
  reasoning_effort?: string;
  trust_all_tools?: boolean;
}): TychonicConfig {
  const block: Record<string, unknown> = { type: "review", on_fail_return_to: WORK_NAME };
  if (args.agent !== undefined) block.agent = args.agent;
  if (args.normalizer !== undefined) block.normalizer = args.normalizer;
  if (args.command !== undefined) block.command = args.command;
  if (args.model !== undefined) block.model = args.model;
  if (args.reasoning_effort !== undefined) block.reasoning_effort = args.reasoning_effort;
  if (args.trust_all_tools !== undefined) block.trust_all_tools = args.trust_all_tools;
  return {
    version: "tychonic.config.v1",
    states: { [REVIEW_NAME]: block as never }
  };
}

function baseRun(id: string, cwd = "/ignored"): WorkflowRunRecord {
  const run: WorkflowRunRecord = {
    schema_version: "tychonic.run.v1",
    id,
    template: "test_template",
    status: "running",
    cwd,
    artifact_root: join(tmpdir(), "tychonic-test-runs", id),
    created_at: "2026-04-26T00:00:00.000Z",
    updated_at: "2026-04-26T00:00:00.000Z",
    states: [],
    activity_attempts: [],
    agent_sessions: [],
    artifacts: [],
    findings: [],
    inbox: []
  };
  return run;
}

async function initGitWorktree(path: string): Promise<void> {
  await writeFile(join(path, "README.md"), "baseline\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: path });
  await execFileAsync("git", ["add", "README.md"], { cwd: path });
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
    { cwd: path }
  );
}

async function writeStubBinary(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const resultEvent = openPResultLine({ sessionId: "stub-session-id" });
  await writeFile(
    path,
    ["#!/bin/sh", "cat > /dev/null", "cat <<'JSON'", resultEvent, "JSON"].join("\n"),
    "utf8"
  );
  await chmod(path, 0o755);
}

async function writeClaudeModelReportingStubBinary(path: string, reportedModel: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const resultEvent = JSON.stringify({
    openp: {
      version: 1,
      form: "result",
      scope: "active",
      sessionId: "stub-session-id",
      output: openPResultOutput(),
      structuredOutput: null,
      metadata: { model: reportedModel }
    }
  });
  await writeFile(
    path,
    ["#!/bin/sh", "cat > /dev/null", "cat <<'JSON'", resultEvent, "JSON"].join("\n"),
    "utf8"
  );
  await chmod(path, 0o755);
}

async function writeClaudeStructuredReviewStubBinary(
  path: string,
  reportedModel?: string,
  largePrefixBytes = 0
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const resultEvent = openPResultLine({
    sessionId: "structured-session-id",
    answer: "structured review emitted",
    structuredOutput: {
      status: "pass",
      summary: "structured review passed",
      findings: []
    },
    metadata: reportedModel !== undefined ? { model: reportedModel } : undefined
  });
  const largePrefixEvent = largePrefixBytes > 0
    ? openPStreamingAnswerLine("structured-session-id", "x".repeat(largePrefixBytes))
    : undefined;
  await writeFile(
    path,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      "cat <<'JSON'",
      ...(largePrefixEvent ? [largePrefixEvent] : []),
      resultEvent,
      "JSON"
    ].join("\n"),
    "utf8"
  );
  await chmod(path, 0o755);
}

async function writeClaudeStructuredReviewWithCwdStubBinary(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const resultEvent = openPResultLine({
    sessionId: "structured-session-id",
    answer: "structured review emitted",
    structuredOutput: {
      status: "pass",
      summary: "structured review passed",
      findings: []
    }
  });
  await writeFile(
    path,
    [
      "#!/bin/sh",
      "printf 'NORMALIZER_CWD:%s\\n' \"$PWD\" >&2",
      "printf 'ARGV:%s\\n' \"$*\" >&2",
      "cat > /dev/null",
      "cat <<'JSON'",
      resultEvent,
      "JSON"
    ].join("\n"),
    "utf8"
  );
  await chmod(path, 0o755);
}

async function writeCodexSemanticReviewStubBinary(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const progressEvent = openPStreamingAnswerLine("codex-structured-thread-id", JSON.stringify({
    status: "fail",
    summary: "starting review",
    findings: [{ severity: "low", title: "progress", detail: "not final" }]
  }));
  const resultEvent = openPResultLine({
    sessionId: "codex-structured-thread-id",
    structuredOutput: {
      status: "pass",
      summary: "codex semantic review passed",
      findings: []
    }
  });
  await writeFile(
    path,
    [
      "#!/bin/sh",
      "printf 'ARGV:%s\\n' \"$*\" >&2",
      "cat > /dev/null",
      "cat <<'JSON'",
      progressEvent,
      resultEvent,
      "JSON"
    ].join("\n"),
    "utf8"
  );
  await chmod(path, 0o755);
}

function openPResultLine(input: {
  sessionId: string;
  answer?: string;
  structuredOutput?: unknown;
  metadata?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    openp: {
      version: 1,
      form: "result",
      scope: "active",
      sessionId: input.sessionId,
      output: openPResultOutput(input.answer),
      structuredOutput: input.structuredOutput ?? null,
      metadata: input.metadata ?? {}
    }
  });
}

function openPStreamingAnswerLine(sessionId: string, answer: string): string {
  return JSON.stringify({
    openp: {
      version: 1,
      form: "streaming",
      scope: "active",
      sessionId,
      output: { answer },
      structuredOutput: null,
      metadata: {}
    }
  });
}

function openPResultOutput(answer?: string): Record<string, unknown[]> {
  return {
    answer: answer && answer.length > 0 ? [answer] : [],
    reasoning: [],
    toolCall: [],
    toolResult: []
  };
}

async function writeKiroStubBinary(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "if (process.argv[2] === 'acp') {",
      "  const trustAllTools = process.argv.includes('--trust-all-tools');",
      "  const mutateTerminal = process.env.TYCHONIC_KIRO_STUB_TERMINAL_MUTATE === '1';",
      "  let buffer = '';",
      "  let workspaceCwd = process.cwd();",
      "  let promptRequestId = undefined;",
      "  let promptSessionId = undefined;",
      "  process.stdin.setEncoding('utf8');",
      "  process.stdin.on('data', (chunk) => {",
      "    buffer += chunk;",
      "    for (;;) {",
      "      const newline = buffer.indexOf('\\n');",
      "      if (newline < 0) break;",
      "      const line = buffer.slice(0, newline).trim();",
      "      buffer = buffer.slice(newline + 1);",
      "      if (line) handle(JSON.parse(line));",
      "    }",
      "  });",
      "  function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }",
      "  function handle(message) {",
      "    if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {",
      "      handleClientResponse(message);",
      "      return;",
      "    }",
      "    if (message.method === 'initialize') {",
      "      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, agentInfo: { name: 'kiro-cli-stub', version: '0.0.0' } } });",
      "      return;",
      "    }",
      "    if (message.method === 'session/new') {",
      "      workspaceCwd = message.params.cwd;",
      "      send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kiro-stub-session-id' } });",
      "      return;",
      "    }",
    "    if (message.method === 'session/load') {",
    "      workspaceCwd = message.params.cwd;",
    "      fs.writeFileSync(path.join(workspaceCwd, 'kiro-loaded.txt'), message.params.sessionId);",
    "      send({ jsonrpc: '2.0', id: message.id, result: null });",
      "      return;",
      "    }",
      "    if (message.method === 'session/prompt') {",
      "      promptRequestId = message.id;",
      "      promptSessionId = message.params.sessionId;",
      "      if (!trustAllTools) {",
      "        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: promptSessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'kiro stub ok' } } } });",
      "        send({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'end_turn' } });",
      "        return;",
      "      }",
      "      send({ jsonrpc: '2.0', id: 100, method: 'fs/write_text_file', params: { sessionId: promptSessionId, path: path.join(workspaceCwd, 'kiro-written.txt'), content: 'written through ACP fs client' } });",
      "      return;",
      "    }",
      "    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } });",
      "  }",
      "  function handleClientResponse(message) {",
      "    if (message.id === 100) {",
      "      const terminalCode = mutateTerminal ? 'require(\"node:fs\").writeFileSync(\"README.md\", \"mutated by review\\\\n\"); process.stdout.write(\"terminal mutated\")' : 'process.stdout.write(\"terminal ok\")';",
      "      send({ jsonrpc: '2.0', id: 101, method: 'terminal/create', params: { sessionId: promptSessionId, command: 'node', args: ['-e', terminalCode], cwd: workspaceCwd } });",
      "      return;",
      "    }",
      "    if (message.id === 101) {",
      "      send({ jsonrpc: '2.0', id: 102, method: 'terminal/wait_for_exit', params: { sessionId: promptSessionId, terminalId: message.result.terminalId } });",
      "      return;",
      "    }",
      "    if (message.id === 102) {",
      "      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: promptSessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'kiro stub ok' } } } });",
      "      send({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'end_turn' } });",
      "    }",
      "  }",
      "} else {",
      "  console.error('kiro stub only supports acp');",
      "  process.exit(2);",
      "}"
    ].join("\n"),
    "utf8"
  );
  await chmod(path, 0o755);
}
