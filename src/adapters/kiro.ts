/**
 * Kiro built-in adapter (binary `kiro-cli`) — PARTIAL: no reviewer role.
 *
 * CLI surface verified against `kiro-cli chat --help`:
 * - Fresh worker runs use interactive `kiro-cli chat` with a positional
 *   prompt plus piped `/chat save` and `/quit` commands. This keeps the
 *   session id process-bound: the same process that handled the prompt
 *   exports its own conversation JSON, and `conversation_id` becomes the
 *   `AgentSessionRecord.id`.
 * - Resume runs use `kiro-cli chat --no-interactive --resume-id <id>`.
 * - `--trust-all-tools` enables write access; the worker role keeps it
 *   on so the agent can mutate the worktree.
 * - `--resume-id <SESSION_ID>` resumes by stable conversation id.
 *
 * Reviewer role: kiro-cli chat does not produce a non-interactive
 * structured-review surface — its output is free-form chat text, not a
 * machine-readable `tychonic.review.v1` object. `runNew` and
 * `runResume` both throw `AdapterUnsupported` when called with
 * `role: "review"`. Operators must pick `claude` or `codex` for review
 * states (the host schema also rejects `agent: "kiro"` on review states
 * at install time).
 *
 * Session id capture: Tychonic does not infer identity from
 * `--list-sessions` before/after diffs because that does not prove which
 * process created the session. The only accepted fresh-run id for this
 * adapter is the `conversation_id` exported by the same kiro process after
 * the prompt completes.
 */

import type {
  AdapterCommand,
  AdapterResumeInput,
  AdapterRunInput,
  AdapterRunResult,
  AgentAdapter
} from "./types.js";
import { AdapterUnsupported } from "./types.js";

// `kiro` is the registered adapter name (architect §4 enum), but the
// underlying binary on disk is `kiro-cli`. SKILL prose may keep saying
// "kiro" — the binary name is an implementation detail of this adapter.
const BIN = "kiro-cli";
const SESSION_EXPORT_START = "__TYCHONIC_KIRO_SESSION_EXPORT_START__";
const SESSION_EXPORT_END = "__TYCHONIC_KIRO_SESSION_EXPORT_END__";

function shouldTrustAllTools(input: AdapterRunInput): boolean {
  if (input.trustAllTools !== undefined) {
    return input.trustAllTools;
  }
  return input.role !== "review";
}

function buildFreshArgs(input: AdapterRunInput): string[] {
  const args: string[] = [BIN, "chat"];
  if (shouldTrustAllTools(input)) {
    args.push("--trust-all-tools");
  }
  args.push("--wrap", "never");
  return args;
}

function buildResumeArgs(input: AdapterRunInput): string[] {
  const args: string[] = [BIN, "chat", "--no-interactive"];
  if (shouldTrustAllTools(input)) {
    args.push("--trust-all-tools");
  }
  return args;
}

function joinArgs(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildFreshCommand(input: AdapterRunInput): string {
  const args = joinArgs(buildFreshArgs(input));
  return [
    'tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/tychonic-kiro-session.XXXXXX")',
    'prompt_file="$tmpdir/prompt.txt"',
    'export_file="$tmpdir/session.json"',
    'cleanup() { rm -rf -- "$tmpdir"; }',
    "trap cleanup EXIT",
    'cat > "$prompt_file"',
    "status=0",
    `printf '/chat save %s\\n/quit\\n' "$export_file" | ${args} "$(cat "$prompt_file")" || status=$?`,
    'if [ -f "$export_file" ]; then',
    'node - "$export_file" <<\'NODE\'',
    'const fs = require("node:fs");',
    "const path = process.argv[2];",
    'const exported = JSON.parse(fs.readFileSync(path, "utf8"));',
    "const conversationId = exported.conversation_id;",
    'if (typeof conversationId === "string" && conversationId.length > 0) {',
    '  console.log("");',
    `  console.log(${JSON.stringify(SESSION_EXPORT_START)});`,
    "  console.log(JSON.stringify({ conversation_id: conversationId }));",
    `  console.log(${JSON.stringify(SESSION_EXPORT_END)});`,
    "}",
    "NODE",
    "fi",
    'exit "$status"'
  ].join("\n");
}

function extractSessionId(stdout: string): string | undefined {
  const start = stdout.indexOf(SESSION_EXPORT_START);
  if (start < 0) {
    return undefined;
  }
  const jsonStart = start + SESSION_EXPORT_START.length;
  const end = stdout.indexOf(SESSION_EXPORT_END, jsonStart);
  if (end < 0) {
    throw new Error("kiro session export marker start was present without an end marker");
  }
  const jsonText = stdout.slice(jsonStart, end).trim();
  const parsed = JSON.parse(jsonText) as { conversation_id?: unknown };
  return typeof parsed.conversation_id === "string" && parsed.conversation_id.length > 0
    ? parsed.conversation_id
    : undefined;
}

export const kiroAdapter: AgentAdapter = {
  name: "kiro",

  runNew(input: AdapterRunInput): AdapterCommand {
    if (input.role === "review") {
      throw new AdapterUnsupported(
        "kiro",
        "review",
        "kiro-cli chat does not emit a non-interactive structured-review surface; configure the review state with `agent: \"claude\"` or `agent: \"codex\"`, or use an explicit `command`"
      );
    }
    return { command: buildFreshCommand(input) };
  },

  runResume(input: AdapterResumeInput): AdapterCommand {
    if (input.role === "review") {
      throw new AdapterUnsupported(
        "kiro",
        "review",
        "kiro-cli chat does not emit a non-interactive structured-review surface; configure the review state with `agent: \"claude\"` or `agent: \"codex\"`, or use an explicit `command`"
      );
    }
    const args = buildResumeArgs(input);
    args.push("--resume-id", input.sessionId);
    return { command: joinArgs(args) };
  },

  parseResult(stdout: string, _stderr: string, _exitCode: number): AdapterRunResult {
    const sessionId = extractSessionId(stdout);
    return sessionId === undefined ? {} : { sessionId };
  }
};
