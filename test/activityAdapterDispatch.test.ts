import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWorkerActivity } from "../src/activities/runWorkerActivity.js";
import { runReviewActivity } from "../src/activities/runReviewActivity.js";
import { TYCHONIC_AGENT_PATH_ENV } from "../src/system/executables.js";
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

let originalAgentPath: string | undefined;
let stubBinDir: string;

beforeEach(async () => {
  originalAgentPath = process.env[TYCHONIC_AGENT_PATH_ENV];
  stubBinDir = await mkdtemp(join(tmpdir(), "tychonic-adapter-dispatch-bin-"));
  await writeStubBinary(join(stubBinDir, "claude"));
  await writeStubBinary(join(stubBinDir, "codex"));
  await writeStubBinary(join(stubBinDir, "gemini"));
  await writeKiroStubBinary(join(stubBinDir, "kiro-cli"));
  process.env[TYCHONIC_AGENT_PATH_ENV] = stubBinDir;
});

afterEach(() => {
  if (originalAgentPath === undefined) {
    delete process.env[TYCHONIC_AGENT_PATH_ENV];
  } else {
    process.env[TYCHONIC_AGENT_PATH_ENV] = originalAgentPath;
  }
});

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
      "claude -p --output-format stream-json --verbose --permission-mode acceptEdits"
    );
    if (result.workerOutcome?.kind !== "executed") throw new Error("expected executed outcome");
    expect(result.workerOutcome.agentSessions[0]?.agent).toBe("claude");
    expect(result.workerOutcome.agentSessions[0]?.id).toBe("stub-session-id");
    expect(result.workerOutcome.agentSessions[0]?.resumable).toBe(true);
    expect(result.delta.activityAttempts?.[0]?.agent_session_id).toBe("stub-session-id");
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

  it("block.agent built-in (kiro) captures same-process exported session id", async () => {
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
    expect(command).toContain("/chat save");
    expect(command).not.toContain("--list-sessions");
    if (result.workerOutcome?.kind !== "executed") throw new Error("expected executed outcome");
    expect(result.workerOutcome.agentSessions[0]?.agent).toBe("kiro");
    expect(result.workerOutcome.agentSessions[0]?.id).toBe("kiro-stub-session-id");
    expect(result.workerOutcome.agentSessions[0]?.resumable).toBe(true);
    expect(result.delta.activityAttempts?.[0]?.agent_session_id).toBe("kiro-stub-session-id");
  });

  it("block.agent built-in (kiro-acp) captures ACP session id", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-kiro-acp-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-worker-kiro-acp-wt-"));

    const result = await runWorkerActivity({
      stateName: WORK_NAME,
      run: baseRun("disp_worker_kiro_acp"),
      cwd,
      profile: workProfile({ agent: "kiro-acp" }),
      worktreePath,
      prompt: "do kiro acp work"
    });

    const command = result.delta.activityAttempts?.[0]?.command ?? "";
    expect(command).toContain("kiro-cli");
    expect(command).toContain("session/new");
    expect(command).toContain("session/prompt");
    expect(command).not.toContain("/chat save");
    if (result.workerOutcome?.kind !== "executed") throw new Error("expected executed outcome");
    expect(result.workerOutcome.agentSessions[0]?.agent).toBe("kiro-acp");
    expect(result.workerOutcome.agentSessions[0]?.id).toBe("kiro-acp-stub-session-id");
    expect(result.workerOutcome.agentSessions[0]?.resumable).toBe(true);
    expect(result.delta.activityAttempts?.[0]?.agent_session_id).toBe("kiro-acp-stub-session-id");
    await expect(readFile(join(worktreePath, "kiro-acp-written.txt"), "utf8")).resolves.toBe(
      "written through ACP fs client"
    );
  });
});

describe("runReviewActivity adapter dispatch", () => {
  it("verbatim block.command path: adapter is NOT called", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-verbatim-"));

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

    // Adapter dispatches `claude ... --permission-mode plan`. The stub claude
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
            agent: "claude"
          }
        }
      },
      prompt: "review please"
    });

    const command = result.delta.activityAttempts?.[0]?.command ?? "";
    expect(command).toContain("claude -p --output-format stream-json --verbose --permission-mode plan");
    expect(command).toContain("--tools Read,Grep,Glob");
    expect(command).toContain("--json-schema");
    expect(command).not.toContain("tychonic.review.v1");
    expect(result.delta.activityAttempts?.[0]?.agent_session_id).toBe("stub-session-id");
    expect(result.reviewOutcome?.kind).toBe("unparseable");
    if (result.reviewOutcome?.kind !== "unparseable") throw new Error("expected unparseable outcome");
    expect(result.reviewOutcome.reviewerSessionId).toBe("stub-session-id");
    expect(result.reviewOutcome.agentSessions[0]?.id).toBe("stub-session-id");
  });

  it("block.agent built-in (claude) parses structured_output through the review activity path", async () => {
    await writeClaudeStructuredReviewStubBinary(join(stubBinDir, "claude"));
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-claude-structured-"));

    const result = await runReviewActivity({
      stateName: REVIEW_NAME,
      run: baseRun("disp_review_claude_structured"),
      cwd,
      profile: reviewProfile({ agent: "claude" }),
      prompt: "review please"
    });

    const command = result.delta.activityAttempts?.[0]?.command ?? "";
    expect(command).toContain("claude -p --output-format stream-json --verbose --permission-mode plan");
    expect(command).toContain("--tools Read,Grep,Glob");
    expect(command).toContain("--json-schema");
    expect(result.delta.states?.[0]?.status).toBe("succeeded");
    expect(result.delta.activityAttempts?.[0]?.agent_session_id).toBe("structured-session-id");
    expect(result.reviewOutcome?.kind).toBe("parsed");
    if (result.reviewOutcome?.kind !== "parsed") throw new Error("expected parsed outcome");
    expect(result.reviewOutcome.result.status).toBe("pass");
    expect(result.reviewOutcome.reviewerSessionId).toBe("structured-session-id");
    expect(result.reviewOutcome.agentSessions[0]?.id).toBe("structured-session-id");

    const parsedArtifact = result.reviewOutcome.artifacts.find(
      (artifact) => artifact.kind === `${REVIEW_NAME}_parsed`
    );
    if (!parsedArtifact) throw new Error("expected parsed review artifact");
    const parsedArtifactText = await readFile(join(cwd, parsedArtifact.path), "utf8");
    expect(JSON.parse(parsedArtifactText)).toMatchObject({
      schema_version: "tychonic.review.v1",
      status: "pass",
      summary: "structured review passed",
      findings: []
    });
  });

  it("block.agent built-in (codex) parses semantic agent_message JSON through the review activity path", async () => {
    await writeCodexSemanticReviewStubBinary(join(stubBinDir, "codex"));
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-codex-semantic-"));

    const result = await runReviewActivity({
      stateName: REVIEW_NAME,
      run: baseRun("disp_review_codex_semantic"),
      cwd,
      profile: reviewProfile({ agent: "codex" }),
      prompt: "review please"
    });

    const command = result.delta.activityAttempts?.[0]?.command ?? "";
    expect(command).toBe("codex -a never exec --skip-git-repo-check --json --sandbox read-only -");
    expect(result.delta.states?.[0]?.status).toBe("succeeded");
    expect(result.delta.activityAttempts?.[0]?.agent_session_id).toBe("codex-structured-thread-id");
    expect(result.reviewOutcome?.kind).toBe("parsed");
    if (result.reviewOutcome?.kind !== "parsed") throw new Error("expected parsed outcome");
    expect(result.reviewOutcome.result.status).toBe("pass");
    expect(result.reviewOutcome.result.schema_version).toBe("tychonic.review.v1");
    expect(result.reviewOutcome.reviewerSessionId).toBe("codex-structured-thread-id");
  });

  it("rejects a partial built-in adapter on a review state without normalizer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-gemini-"));

    await expect(
      runReviewActivity({
        stateName: REVIEW_NAME,
        run: baseRun("disp_review_gemini"),
        cwd,
        profile: {
          version: "tychonic.config.v1",
          states: {
            [REVIEW_NAME]: {
              type: "review",
              agent: "gemini"
            }
          }
        },
        prompt: "review please"
      })
    ).rejects.toThrow(/profile\.states\.review_disp failed schema validation/);
  });

  it("runs a partial review adapter through the declared normalizer", async () => {
    await writeClaudeStructuredReviewWithCwdStubBinary(join(stubBinDir, "claude"));
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-kiro-normalized-"));
    const worktreePath = await mkdtemp(
      join(tmpdir(), "tychonic-disp-review-kiro-normalized-wt-")
    );

    const result = await runReviewActivity({
      stateName: REVIEW_NAME,
      run: baseRun("disp_review_kiro_normalized"),
      cwd,
      worktreePath,
      profile: reviewProfile({ agent: "kiro", normalizer: "claude" }),
      prompt: "review please"
    });

    const command = result.delta.activityAttempts?.[0]?.command ?? "";
    expect(command).toContain("/chat save");
    expect(command).not.toContain("--trust-all-tools");
    expect(result.reviewOutcome?.kind).toBe("parsed");
    if (result.reviewOutcome?.kind !== "parsed") throw new Error("expected parsed outcome");
    expect(result.reviewOutcome.result.status).toBe("pass");
    expect(result.reviewOutcome.reviewerSessionId).toBe("kiro-stub-session-id");
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
    const normalizerOutputText = await readFile(join(cwd, normalizerOutputArtifact.path), "utf8");
    expect(normalizerOutputText).toContain("NORMALIZER_CWD:");
    expect(normalizerOutputText).not.toContain(cwd);
    expect(normalizerOutputText).not.toContain(worktreePath);
    const normalizerSession = result.reviewOutcome.agentSessions.find(
      (session) => session.agent === "claude"
    );
    expect(normalizerSession?.cwd).toContain("tychonic-review-normalizer-");
    expect(normalizerSession?.cwd).not.toBe(cwd);
    expect(normalizerSession?.cwd).not.toBe(worktreePath);
  });

  it("runs a partial review adapter through a codex normalizer", async () => {
    await writeCodexSemanticReviewStubBinary(join(stubBinDir, "codex"));
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-review-gemini-codex-normalized-"));

    const result = await runReviewActivity({
      stateName: REVIEW_NAME,
      run: baseRun("disp_review_gemini_codex_normalized"),
      cwd,
      profile: reviewProfile({ agent: "gemini", normalizer: "codex" }),
      prompt: "review please"
    });

    const command = result.delta.activityAttempts?.[0]?.command ?? "";
    expect(command).toBe('gemini --approval-mode plan --sandbox --output-format stream-json -p ""');
    expect(result.reviewOutcome?.kind).toBe("parsed");
    if (result.reviewOutcome?.kind !== "parsed") throw new Error("expected parsed outcome");
    expect(result.reviewOutcome.result.status).toBe("pass");
    expect(result.reviewOutcome.agentSessions.map((session) => session.agent)).toEqual([
      "gemini",
      "codex"
    ]);
    expect(result.reviewOutcome.agentSessions.at(-1)?.id).toBe("codex-structured-thread-id");

    const normalizerPromptArtifact = result.reviewOutcome.artifacts.find(
      (artifact) => artifact.kind === `${REVIEW_NAME}_normalizer_prompt`
    );
    if (!normalizerPromptArtifact) throw new Error("expected normalizer prompt artifact");
    const normalizerPrompt = await readFile(join(cwd, normalizerPromptArtifact.path), "utf8");
    expect(normalizerPrompt).toContain("Top-level keys are exactly: status, summary, findings.");
    expect(normalizerPrompt).toContain("severity, title, detail");
    expect(normalizerPrompt).toContain("Use the exact key detail");
    expect(normalizerPrompt).toContain('"detail":"..."');
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
              agent: "custom-non-builtin"
            }
          }
        },
        prompt: "review please"
      })
    ).rejects.toThrow(/profile\.states\.review_disp failed schema validation/);
  });
});

function workProfile(args: { agent?: string; command?: string }): TychonicConfig {
  const block: Record<string, unknown> = { type: "work" };
  if (args.agent !== undefined) block.agent = args.agent;
  if (args.command !== undefined) block.command = args.command;
  return {
    version: "tychonic.config.v1",
    states: { [WORK_NAME]: block as never }
  };
}

function reviewProfile(args: { agent?: string; normalizer?: string; command?: string }): TychonicConfig {
  const block: Record<string, unknown> = { type: "review" };
  if (args.agent !== undefined) block.agent = args.agent;
  if (args.normalizer !== undefined) block.normalizer = args.normalizer;
  if (args.command !== undefined) block.command = args.command;
  return {
    version: "tychonic.config.v1",
    states: { [REVIEW_NAME]: block as never }
  };
}

function baseRun(id: string): WorkflowRunRecord {
  return {
    schema_version: "tychonic.run.v1",
    id,
    template: "test_template",
    status: "running",
    cwd: "/ignored",
    created_at: "2026-04-26T00:00:00.000Z",
    updated_at: "2026-04-26T00:00:00.000Z",
    states: [],
    activity_attempts: [],
    agent_sessions: [],
    artifacts: [],
    findings: [],
    inbox: []
  };
}

async function writeStubBinary(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\ncat > /dev/null\necho '{\"session_id\":\"stub-session-id\"}'\n", "utf8");
  await chmod(path, 0o755);
}

async function writeClaudeStructuredReviewStubBinary(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const systemEvent = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "structured-session-id"
  });
  const resultEvent = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "structured review emitted",
    structured_output: {
      status: "pass",
      summary: "structured review passed",
      findings: []
    },
    session_id: "structured-session-id"
  });
  await writeFile(
    path,
    ["#!/bin/sh", "cat > /dev/null", "cat <<'JSON'", systemEvent, resultEvent, "JSON"].join("\n"),
    "utf8"
  );
  await chmod(path, 0o755);
}

async function writeClaudeStructuredReviewWithCwdStubBinary(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const systemEvent = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "structured-session-id"
  });
  const resultEvent = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "structured review emitted",
    structured_output: {
      status: "pass",
      summary: "structured review passed",
      findings: []
    },
    session_id: "structured-session-id"
  });
  await writeFile(
    path,
    [
      "#!/bin/sh",
      "printf 'NORMALIZER_CWD:%s\\n' \"$PWD\" >&2",
      "cat > /dev/null",
      "cat <<'JSON'",
      systemEvent,
      resultEvent,
      "JSON"
    ].join("\n"),
    "utf8"
  );
  await chmod(path, 0o755);
}

async function writeCodexSemanticReviewStubBinary(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const threadEvent = JSON.stringify({
    type: "thread.started",
    thread_id: "codex-structured-thread-id"
  });
  const messageEvent = JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "agent_message",
      text: JSON.stringify({
        status: "pass",
        summary: "codex semantic review passed",
        findings: []
      })
    }
  });
  const completedEvent = JSON.stringify({ type: "turn.completed" });
  await writeFile(
    path,
    ["#!/bin/sh", "cat > /dev/null", "cat <<'JSON'", threadEvent, messageEvent, completedEvent, "JSON"].join("\n"),
    "utf8"
  );
  await chmod(path, 0o755);
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
      "      send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'kiro-acp-stub-session-id' } });",
      "      return;",
      "    }",
      "    if (message.method === 'session/load') {",
      "      workspaceCwd = message.params.cwd;",
      "      send({ jsonrpc: '2.0', id: message.id, result: null });",
      "      return;",
      "    }",
      "    if (message.method === 'session/prompt') {",
      "      promptRequestId = message.id;",
      "      promptSessionId = message.params.sessionId;",
      "      send({ jsonrpc: '2.0', id: 100, method: 'fs/write_text_file', params: { sessionId: promptSessionId, path: path.join(workspaceCwd, 'kiro-acp-written.txt'), content: 'written through ACP fs client' } });",
      "      return;",
      "    }",
      "    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } });",
      "  }",
      "  function handleClientResponse(message) {",
      "    if (message.id === 100) {",
      "      send({ jsonrpc: '2.0', id: 101, method: 'terminal/create', params: { sessionId: promptSessionId, command: 'node', args: ['-e', 'process.stdout.write(\"terminal ok\")'], cwd: workspaceCwd } });",
      "      return;",
      "    }",
      "    if (message.id === 101) {",
      "      send({ jsonrpc: '2.0', id: 102, method: 'terminal/wait_for_exit', params: { sessionId: promptSessionId, terminalId: message.result.terminalId } });",
      "      return;",
      "    }",
      "    if (message.id === 102) {",
      "      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: promptSessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'kiro acp stub ok' } } } });",
      "      send({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'end_turn' } });",
      "    }",
      "  }",
      "} else {",
      "  const input = fs.readFileSync(0, 'utf8');",
      "  const saveLine = input.split(/\\n/).find((line) => line.startsWith('/chat save '));",
      "  const savePath = saveLine ? saveLine.replace('/chat save ', '') : '';",
      "  if (savePath) {",
      "    fs.mkdirSync(path.dirname(savePath), { recursive: true });",
      "    fs.writeFileSync(savePath, JSON.stringify({ conversation_id: 'kiro-stub-session-id' }) + '\\n');",
      "  }",
      "  console.log('kiro stub ok');",
      "}"
    ].join("\n"),
    "utf8"
  );
  await chmod(path, 0o755);
}
