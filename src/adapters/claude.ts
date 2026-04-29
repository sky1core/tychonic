/**
 * Claude built-in adapter.
 *
 * CLI surface verified against `claude --help` (Claude Code v2.x):
 * - `claude -p [prompt]`         — non-interactive print mode. Required.
 * - `--model <model>` / `--effort <level>` are included only when the
 *   state config declares `model` / `reasoning_effort`.
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
import { shellQuote } from "./shell.js";

const BIN = "claude";
const REVIEW_FINDING_JSON_SCHEMA = {
  type: "object",
  description: "One actionable problem. Do not use findings for evidence, confirmations, or passing notes.",
  additionalProperties: false,
  properties: {
    severity: { enum: ["critical", "high", "medium", "low"], description: "Severity of the problem." },
    title: { type: "string", minLength: 1, description: "Short problem title." },
    detail: { type: "string", minLength: 1, description: "Actionable explanation of the problem." },
    target: { type: "string", minLength: 1, description: "File, state, or session target when known." },
    target_session_id: { type: "string", description: "Worker session id when the problem targets one." }
  },
  required: ["severity", "title", "detail"]
} as const;

// Claude StructuredOutput currently rejects top-level oneOf/allOf/anyOf.
// The adapter asks for the semantic payload only; the parser normalizes
// schema_version and ReviewResultSchema validates host invariants.
const TYCHONIC_REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      enum: ["pass", "fail"],
      description: "Use pass only when there are no actionable findings. Use fail when any actionable finding exists."
    },
    summary: { type: "string", minLength: 1, description: "Concise verdict summary." },
    findings: {
      type: "array",
      description: "Actionable problems only. If status is pass, this must be an empty array.",
      items: REVIEW_FINDING_JSON_SCHEMA
    }
  },
  required: ["status", "summary", "findings"]
} as const;

function rolePermissionMode(role: AdapterRunInput["role"]): AdapterPermissionMode {
  return role === "review" ? "plan" : "acceptEdits";
}

function buildBaseArgs(input: AdapterRunInput): string[] {
  const permissionMode = input.permissionMode ?? rolePermissionMode(input.role);
  const args = [
    BIN,
    "-p"
  ];
  if (input.model !== undefined) {
    args.push("--model", shellQuote(input.model));
  }
  if (input.reasoningEffort !== undefined) {
    args.push("--effort", shellQuote(input.reasoningEffort));
  }
  args.push(
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    permissionMode
  );
  if (input.role === "review") {
    args.push(
      "--tools",
      "Read,Grep,Glob",
      "--json-schema",
      shellQuote(JSON.stringify(TYCHONIC_REVIEW_JSON_SCHEMA))
    );
  }
  return args;
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
    args.push("--resume", shellQuote(input.sessionId));
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
