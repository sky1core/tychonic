/**
 * Claude built-in adapter.
 *
 * CLI surface verified against `claude --help` (Claude Code v2.x):
 * - `claude -p [prompt]`         — non-interactive print mode. Required.
 * - `--output-format stream-json --verbose` — emits JSONL events; the
 *   first `system.init` event contains `session_id` (UUID).
 * - `--permission-mode <mode>`   — choices include `acceptEdits`,
 *   `plan`, `bypassPermissions`. Worker → `acceptEdits`, reviewer →
 *   `plan`. `--continue` is intentionally not used (it picks the most
 *   recent unrelated session in the cwd).
 * - `--resume <session-id>`      — resume by stable UUID.
 *
 * Prompt is delivered on stdin (the `--print` mode reads stdin when the
 * positional prompt is absent). The adapter argv therefore omits the
 * positional prompt; the host's `runCommand` pipes `input.prompt` on
 * stdin.
 */

import type {
  AdapterCommand,
  AdapterPermissionMode,
  AdapterResumeInput,
  AdapterRunInput,
  AdapterRunResult,
  AgentAdapter
} from "./types.js";

const BIN = "claude";

function rolePermissionMode(role: AdapterRunInput["role"]): AdapterPermissionMode {
  return role === "review" ? "plan" : "acceptEdits";
}

function buildBaseArgs(input: AdapterRunInput): string[] {
  const permissionMode = input.permissionMode ?? rolePermissionMode(input.role);
  return [
    BIN,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    permissionMode
  ];
}

function joinArgs(args: string[]): string {
  return args.join(" ");
}

export const claudeAdapter: AgentAdapter = {
  name: "claude",

  runNew(input: AdapterRunInput): AdapterCommand {
    return { command: joinArgs(buildBaseArgs(input)) };
  },

  runResume(input: AdapterResumeInput): AdapterCommand {
    const args = buildBaseArgs(input);
    args.push("--resume", input.sessionId);
    return { command: joinArgs(args) };
  },

  /**
   * Claude's `stream-json` output is a JSONL stream where the first event
   * is `{"type":"system","subtype":"init","session_id":"<uuid>", ... }`.
   * We scan the first ~16 lines for that event; falling back to a top-level
   * `session_id` field on any line covers minor format drift between
   * versions.
   */
  parseResult(stdout: string, _stderr: string, _exitCode: number): AdapterRunResult {
    const sessionId = extractSessionId(stdout);
    return sessionId === undefined ? {} : { sessionId };
  }
};

function extractSessionId(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/, 64);
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
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.session_id === "string" && obj.session_id.length > 0) {
      return obj.session_id;
    }
  }
  return undefined;
}
