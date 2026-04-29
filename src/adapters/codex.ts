/**
 * Codex built-in adapter.
 *
 * CLI surface verified against `codex --help` and `codex exec --help`
 * (Codex CLI):
 * - `codex [-a <approval>] exec --skip-git-repo-check --json --sandbox <s> -`
 *   Prompt is read from stdin when the trailing argument is `-` (or when
 *   stdin is piped and no prompt arg is given). `--json` emits JSONL.
 * - `--model <model>` is included only when the state config declares
 *   `model`.
 * - `-c model_reasoning_effort="<level>"` is included only when the state
 *   config declares `reasoning_effort`.
 * - `-a/--ask-for-approval <APPROVAL_POLICY>` is a TOP-LEVEL flag, NOT a
 *   subflag of `exec`. Choices: `untrusted`, `on-failure`, `on-request`,
 *   `never`. Worker default → `never`; reviewer default → `never` as
 *   well (read-only sandbox already constrains writes).
 * - `--sandbox` choices: `read-only`, `workspace-write`,
 *   `danger-full-access`. Worker → `workspace-write`, reviewer →
 *   `read-only`.
 * - Resume: `codex exec resume --skip-git-repo-check --json <thread-id> -`.
 *   Top-level options like `-a` apply identically. The current resume
 *   subcommand does not accept `--sandbox`.
 *
 * Session id capture: codex `--json` emits a JSONL stream whose first
 * meaningful event is currently `{"type":"thread.started",
 * "thread_id":"<uuid>"}`. Older builds emitted `session_configured` or
 * `session_meta`; we accept all three shapes.
 */

import type {
  AdapterApproval,
  AdapterCommand,
  AdapterResumeInput,
  AdapterRunInput,
  AdapterRunResult,
  AdapterSandbox,
  AgentAdapter
} from "./types.js";
import { shellQuote } from "./shell.js";

const BIN = "codex";

function roleSandbox(role: AdapterRunInput["role"]): AdapterSandbox {
  return role === "review" ? "read-only" : "workspace-write";
}

function defaultApproval(): AdapterApproval {
  return "never";
}

function buildTopLevelArgs(input: AdapterRunInput): string[] {
  const approval = input.approval ?? defaultApproval();
  const args = [BIN, "-a", approval];
  if (input.model !== undefined) {
    args.push("--model", shellQuote(input.model));
  }
  if (input.reasoningEffort !== undefined) {
    args.push("-c", shellQuote(`model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`));
  }
  return args;
}

function buildExecArgs(input: AdapterRunInput): string[] {
  const sandbox = input.sandbox ?? roleSandbox(input.role);
  return ["exec", "--skip-git-repo-check", "--json", "--sandbox", sandbox];
}

function joinArgs(args: string[]): string {
  return args.join(" ");
}

export const codexAdapter: AgentAdapter = {
  name: "codex",

  runNew(input: AdapterRunInput): AdapterCommand {
    const args = [...buildTopLevelArgs(input), ...buildExecArgs(input), "-"];
    return { command: joinArgs(args) };
  },

  runResume(input: AdapterResumeInput): AdapterCommand {
    // `codex exec resume <id> -`  — top-level approval still applies; the
    // current resume subcommand does not accept `--sandbox`.
    const args = [
      ...buildTopLevelArgs(input),
      "exec",
      "resume",
      "--skip-git-repo-check",
      "--json",
      shellQuote(input.sessionId),
      "-"
    ];
    return { command: joinArgs(args) };
  },

  parseResult(stdout: string, _stderr: string, _exitCode: number): AdapterRunResult {
    const sessionId = extractSessionId(stdout);
    return sessionId === undefined ? {} : { sessionId };
  }
};

function extractSessionId(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/, 128);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("{")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const id = readSessionId(parsed);
    if (id !== undefined) {
      return id;
    }
  }
  return undefined;
}

function readSessionId(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  // Flat shape: `{"session_id":"..."}` or `{"type":"session_meta", "session_id":"..."}`
  if (typeof obj.session_id === "string" && obj.session_id.length > 0) {
    return obj.session_id;
  }
  if (typeof obj.thread_id === "string" && obj.thread_id.length > 0) {
    return obj.thread_id;
  }
  // Nested shape: `{"msg": {"type":"session_configured", "session_id":"..."}}`
  const msg = obj.msg;
  if (typeof msg === "object" && msg !== null) {
    const inner = msg as Record<string, unknown>;
    if (typeof inner.session_id === "string" && inner.session_id.length > 0) {
      return inner.session_id;
    }
  }
  return undefined;
}
