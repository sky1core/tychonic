/**
 * Unified OpenP adapter for all built-in agent backends.
 *
 * All built-in agents (claude, codex, kiro) are dispatched through
 * `openp <backend>`. This module creates one adapter instance per
 * backend from shared command-building and result-parsing logic.
 *
 * CLI surface follows the OpenP public contract:
 * - `openp <backend>` selects the backend.
 * - `--timeout 0` disables OpenP's own turn timeout so Tychonic's
 *   activity timeout remains the authoritative wall-clock budget.
 * - `--model <model>` / `--effort <level>` are included only when declared.
 * - `--output-format stream-json` emits JSONL whose public payload is the
 *   nested `openp` object. Result records use `openp.form: "result"` and
 *   aggregate output arrays under `openp.output`.
 * - `--dangerously-skip-permissions` trusts backend tool execution.
 * - `--json-schema <json>` is used only where the selected OpenP backend and
 *   turn type support it.
 * - `--resume <session-id>` resumes by stable OpenP backend session id.
 *
 * Prompt is delivered on stdin.
 */

import type {
  AdapterCommand,
  AdapterResumeInput,
  AdapterRunInput,
  AdapterRunResult,
  AgentAdapter,
  BuiltInAgentName
} from "./types.js";
import { FINDING_SEVERITIES } from "../domain/types.js";
import { shellQuote } from "./shell.js";

const BIN = "openp";

// OpenP remains the only command Tychonic invokes. The backend executable
// names are declared so service/worker preflight can build a runtime PATH
// where OpenP's selected backend can start its own child process.
const BACKEND_EXECUTABLES: Record<BuiltInAgentName, string> = {
  claude: "claude",
  codex: "codex",
  kiro: "kiro-cli"
};

const REVIEW_FINDING_JSON_SCHEMA = {
  type: "object",
  description: "One actionable problem. Do not use findings for evidence, confirmations, or passing notes.",
  additionalProperties: false,
  properties: {
    severity: { enum: FINDING_SEVERITIES, description: "Severity of the problem." },
    title: { type: "string", minLength: 1, description: "Short problem title." },
    detail: { type: "string", minLength: 1, description: "Actionable explanation of the problem." },
    target: {
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
      description: "File, state, or session target when known; null when unknown."
    },
    target_session_id: {
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
      description: "Worker session id when the problem targets one; null when unknown."
    }
  },
  required: ["severity", "title", "detail", "target", "target_session_id"]
} as const;

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

function createOpenPAdapter(backend: BuiltInAgentName): AgentAdapter {
  return {
    name: backend,
    executables: [BIN, BACKEND_EXECUTABLES[backend]],

    runNew(input: AdapterRunInput): AdapterCommand {
      const args = buildArgs(backend, input);
      if (shouldAttachReviewJsonSchema(backend, "runNew", input.role)) {
        args.push("--json-schema", shellQuote(JSON.stringify(TYCHONIC_REVIEW_JSON_SCHEMA)));
      }
      return { command: args.join(" ") };
    },

    runResume(input: AdapterResumeInput): AdapterCommand {
      const args = buildArgs(backend, input);
      if (shouldAttachReviewJsonSchema(backend, "runResume", input.role)) {
        args.push("--json-schema", shellQuote(JSON.stringify(TYCHONIC_REVIEW_JSON_SCHEMA)));
      }
      args.push("--resume", shellQuote(input.sessionId));
      return { command: args.join(" ") };
    },

    parseResult(stdout: string, _stderr: string, _exitCode: number): AdapterRunResult {
      return extractStreamJsonFields(stdout);
    }
  };
}

function buildArgs(backend: BuiltInAgentName, input: AdapterRunInput): string[] {
  const executable = input.executablePaths?.[BIN] ? shellQuote(input.executablePaths[BIN]!) : BIN;
  const args = [executable, backend, "--timeout", "0"];

  if (input.model !== undefined) {
    args.push("--model", shellQuote(input.model));
  }
  if (input.reasoningEffort !== undefined) {
    args.push("--effort", shellQuote(input.reasoningEffort));
  }

  args.push("--output-format", "stream-json");
  args.push(...resolvePermissionArgs(backend, input));
  return args;
}

function resolvePermissionArgs(backend: BuiltInAgentName, input: AdapterRunInput): string[] {
  switch (backend) {
    case "claude": {
      return input.permissionMode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : [];
    }
    case "codex": {
      return ["--dangerously-skip-permissions"];
    }
    case "kiro": {
      const trust = input.trustAllTools ?? (input.role !== "review");
      return trust ? ["--dangerously-skip-permissions"] : [];
    }
  }
}

function shouldAttachReviewJsonSchema(
  backend: BuiltInAgentName,
  operation: "runNew" | "runResume",
  role: AdapterRunInput["role"]
): boolean {
  if (role !== "review") return false;
  if (backend === "kiro") return false;
  if (backend === "codex" && operation === "runResume") return false;
  return true;
}

function extractStreamJsonFields(stdout: string): AdapterRunResult {
  const lines = stdout.split(/\r?\n/);
  const result: AdapterRunResult = {};
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
    const openp = openpRecord(obj);
    if (!openp) {
      continue;
    }
    if (result.sessionId === undefined && typeof openp.sessionId === "string" && openp.sessionId.length > 0) {
      result.sessionId = openp.sessionId;
    }
    const metadata = recordValue(openp.metadata);
    if (
      openp.form === "result" &&
      openp.scope === "active" &&
      metadata !== undefined &&
      typeof metadata.model === "string" &&
      metadata.model.length > 0
    ) {
      result.reportedModel = metadata.model;
    }
  }
  return result;
}

function openpRecord(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  return recordValue(obj.openp);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export const claudeAdapter = createOpenPAdapter("claude");
export const codexAdapter = createOpenPAdapter("codex");
export const kiroAdapter = createOpenPAdapter("kiro");
