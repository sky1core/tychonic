import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWorkerActivity } from "../src/activities/runWorkerActivity.js";
import { runReviewActivity } from "../src/activities/runReviewActivity.js";
import { runAutoContinueActivity } from "../src/activities/runAutoContinueActivity.js";
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
const AUTO_NAME = "auto_disp";

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
    // binary exits 0 with empty output, so the review body returns
    // `command_failed` (no review payload to parse). What we care about is
    // that the SPAWNED command came from the adapter, which we read off the
    // attempt record regardless of outcome.
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
    expect(command).toBe(
      "claude -p --output-format stream-json --verbose --permission-mode plan"
    );
  });

  it("rejects a partial built-in adapter on a review state before dispatch", async () => {
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

describe("runAutoContinueActivity adapter dispatch", () => {
  it("verbatim block.command path: adapter is NOT called", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-auto-verbatim-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-auto-verbatim-wt-"));

    const result = await runAutoContinueActivity({
      stateName: AUTO_NAME,
      run: baseRun("disp_auto_verbatim"),
      cwd,
      profile: autoProfile({ command: "node -e \"console.log('verbatim auto')\"" }),
      worktreePath,
      prompt: "continue"
    });

    const command = result.delta.activityAttempts?.[0]?.command;
    expect(command).toBe("node -e \"console.log('verbatim auto')\"");
  });

  it("block.agent built-in (codex) with no command -> dispatches via codexAdapter.runNew", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-auto-codex-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-auto-codex-wt-"));

    const result = await runAutoContinueActivity({
      stateName: AUTO_NAME,
      run: baseRun("disp_auto_codex"),
      cwd,
      profile: autoProfile({ agent: "codex" }),
      worktreePath,
      prompt: "continue"
    });

    const command = result.delta.activityAttempts?.[0]?.command;
    expect(command).toBe(
      "codex -a never exec --skip-git-repo-check --json --sandbox workspace-write -"
    );
    if (result.workerOutcome?.kind !== "executed") throw new Error("expected executed outcome");
    expect(result.workerOutcome.agentSessions[0]?.id).toBe("stub-session-id");
    expect(result.workerOutcome.agentSessions[0]?.resumable).toBe(true);
    expect(result.delta.activityAttempts?.[0]?.agent_session_id).toBe("stub-session-id");
  });

  it("rejects an unvalidated auto_continue agent before command resolution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-disp-auto-missing-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "tychonic-disp-auto-missing-wt-"));

    await expect(
      runAutoContinueActivity({
        stateName: AUTO_NAME,
        run: baseRun("disp_auto_missing"),
        cwd,
        profile: autoProfile({ agent: "custom-non-builtin" }),
        worktreePath,
        prompt: ""
      })
    ).rejects.toThrow(/profile\.states\.auto_disp failed schema validation/);
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

function reviewProfile(args: { agent?: string; command?: string }): TychonicConfig {
  const block: Record<string, unknown> = { type: "review" };
  if (args.agent !== undefined) block.agent = args.agent;
  if (args.command !== undefined) block.command = args.command;
  return {
    version: "tychonic.config.v1",
    states: { [REVIEW_NAME]: block as never }
  };
}

function autoProfile(args: { agent?: string; command?: string }): TychonicConfig {
  const block: Record<string, unknown> = { type: "auto_continue" };
  if (args.agent !== undefined) block.agent = args.agent;
  if (args.command !== undefined) block.command = args.command;
  return {
    version: "tychonic.config.v1",
    states: { [AUTO_NAME]: block as never }
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

async function writeKiroStubBinary(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    [
      "#!/bin/sh",
      "input=$(cat)",
      "save_path=$(printf '%s\\n' \"$input\" | awk '/^\\/chat save / { sub(/^\\/chat save /, \"\"); print; exit }')",
      "if [ -n \"$save_path\" ]; then",
      "  mkdir -p \"$(dirname \"$save_path\")\"",
      "  printf '%s\\n' '{\"conversation_id\":\"kiro-stub-session-id\"}' > \"$save_path\"",
      "fi",
      "echo 'kiro stub ok'"
    ].join("\n"),
    "utf8"
  );
  await chmod(path, 0o755);
}
