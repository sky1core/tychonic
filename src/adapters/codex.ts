/**
 * Codex built-in adapter.
 *
 * CLI surface verified against `codex --help` and `codex exec --help`
 * (Codex CLI):
 * - `codex [-a <approval>] exec --skip-git-repo-check --json --sandbox <s> -`
 *   Prompt is read from stdin when the trailing argument is `-` (or when
 *   stdin is piped and no prompt arg is given). `--json` emits JSONL.
 * - `--output-last-message <file>` is used and appended to stdout by a
 *   small shell wrapper so review parsing can rely on the final answer even
 *   when JSONL contains verbose tool events.
 * - `--output-schema <file>` is used for review runs. Codex's structured
 *   output accepts the semantic review payload schema when every declared
 *   property is required, so the schema intentionally omits optional target
 *   fields instead of asking the model for host bookkeeping.
 * - `--model <model>` is included only when the state config declares
 *   `model`.
 * - `-c model_reasoning_effort="<level>"` is included only when the state
 *   config declares `reasoning_effort`.
 * - `-a/--ask-for-approval <APPROVAL_POLICY>` is a TOP-LEVEL flag, NOT a
 *   subflag of `exec`. Choices: `untrusted`, `on-failure`, `on-request`,
 *   `never`. Worker default → `never`; reviewer default → `never` as well.
 * - `--sandbox` choices: `read-only`, `workspace-write`,
 *   `danger-full-access`. Worker and reviewer both default to
 *   `workspace-write`; the activity-level review mutation guard blocks source
 *   edits while still allowing review commands to create temporary files.
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

const REVIEW_FINDING_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["severity", "title", "detail"],
  properties: {
    severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
    title: { type: "string" },
    detail: { type: "string" }
  }
} as const;

const TYCHONIC_REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "findings"],
  properties: {
    status: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: REVIEW_FINDING_JSON_SCHEMA
    }
  }
} as const;

function defaultSandbox(): AdapterSandbox {
  return "workspace-write";
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
  const sandbox = input.sandbox ?? defaultSandbox();
  return ["exec", "--skip-git-repo-check", "--json", "--sandbox", sandbox];
}

function joinArgs(args: string[]): string {
  return args.join(" ");
}

export const codexAdapter: AgentAdapter = {
  name: "codex",

  runNew(input: AdapterRunInput): AdapterCommand {
    const useReviewSchema = input.role === "review";
    const args = [...buildTopLevelArgs(input), ...buildExecArgs(input)];
    if (useReviewSchema) {
      args.push("--output-schema", '"$review_schema"');
    }
    args.push("--output-last-message", '"$last_message"', "-");
    return { command: wrapWithLastMessageCapture(args, { reviewSchema: useReviewSchema }) };
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
      "--output-last-message",
      '"$last_message"',
      shellQuote(input.sessionId),
      "-"
    ];
    return { command: wrapWithLastMessageCapture(args) };
  },

  parseResult(stdout: string, _stderr: string, _exitCode: number): AdapterRunResult {
    const sessionId = extractSessionId(stdout);
    return sessionId === undefined ? {} : { sessionId };
  }
};

function wrapWithLastMessageCapture(args: string[], options: { reviewSchema?: boolean } = {}): string {
  const command = joinArgs(args);
  const script = [
    "last_message=$(mktemp \"${TMPDIR:-/tmp}/tychonic-codex-last.XXXXXX\") || exit 1",
    ...(options.reviewSchema
      ? [
          "review_schema=$(mktemp \"${TMPDIR:-/tmp}/tychonic-codex-review-schema.XXXXXX\") || exit 1",
          "cat > \"$review_schema\" <<'TYCHONIC_CODEX_REVIEW_SCHEMA'",
          JSON.stringify(TYCHONIC_REVIEW_JSON_SCHEMA, null, 2),
          "TYCHONIC_CODEX_REVIEW_SCHEMA"
        ]
      : []),
    options.reviewSchema
      ? "cleanup() { rm -f \"$last_message\" \"$review_schema\"; }"
      : "cleanup() { rm -f \"$last_message\"; }",
    "trap cleanup EXIT INT TERM",
    `${command}`,
    "status=$?",
    "if [ -s \"$last_message\" ]; then",
    "  printf '\\n'",
    "  cat \"$last_message\"",
    "  printf '\\n'",
    "fi",
    "exit \"$status\""
  ].join("\n");
  return `sh -c ${shellQuote(script)}`;
}

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
