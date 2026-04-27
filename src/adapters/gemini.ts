/**
 * Gemini built-in adapter (PARTIAL — `runNew` only).
 *
 * Open-question resolution from architect §10.8:
 *
 *   `gemini --help` exposes `-r/--resume <value>` but `<value>` is a
 *   1-based INDEX into `--list-sessions` (or the literal string
 *   `"latest"`). It is not a stable session UUID. `--list-sessions`
 *   itself does print UUIDs, but `--resume <uuid>` is rejected.
 *   Indices are project-relative and shift whenever sessions are added
 *   or deleted, so they cannot be safely persisted in
 *   `AgentSessionRecord.id`.
 *
 *   Conclusion: ship a partial gemini adapter — `runNew` works for the
 *   worker / auto_continue role, `runResume` throws
 *   `AdapterUnsupported`, and `review` also throws because gemini does
 *   not currently produce a non-interactive structured-review surface.
 *   `parseResult` returns `{}` so the host marks the session
 *   non-resumable. The workflow decides what recovery path to expose
 *   when it needs to continue.
 *
 * CLI surface verified against `gemini --help`:
 * - `gemini --approval-mode yolo --sandbox --output-format stream-json -p ""`
 *   `-p, --prompt <string>` enters non-interactive headless mode. The
 *   help line says "Appended to input on stdin (if any)", so passing
 *   `-p ""` lets us deliver the actual prompt on stdin uniformly with
 *   the other adapters.
 * - `--approval-mode`: `default | auto_edit | yolo | plan`. Worker uses
 *   `yolo`; an explicit `permissionMode` override of `plan` is honoured
 *   (architect §5.5 leaves the orchestration override path open).
 * - `--sandbox` is a boolean flag in gemini (no policy value).
 */

import type {
  AdapterCommand,
  AdapterResumeInput,
  AdapterRunInput,
  AdapterRunResult,
  AgentAdapter
} from "./types.js";
import { AdapterUnsupported } from "./types.js";

const BIN = "gemini";

function roleApprovalMode(input: AdapterRunInput): string {
  if (input.permissionMode === "plan") {
    return "plan";
  }
  // Worker / auto_continue default. `review` should never reach here
  // because `runNew` rejects it below.
  return "yolo";
}

function buildBaseArgs(input: AdapterRunInput): string[] {
  const args: string[] = [BIN, "--approval-mode", roleApprovalMode(input)];
  // Gemini's `--sandbox` is boolean, not a policy enum. Workers run with
  // sandbox enabled so model-issued shell commands are constrained.
  args.push("--sandbox");
  args.push("--output-format", "stream-json");
  // `-p ""` enters non-interactive mode; real prompt is delivered on stdin.
  args.push("-p", '""');
  return args;
}

function joinArgs(args: string[]): string {
  return args.join(" ");
}

export const geminiAdapter: AgentAdapter = {
  name: "gemini",

  runNew(input: AdapterRunInput): AdapterCommand {
    if (input.role === "review") {
      throw new AdapterUnsupported(
        "gemini",
        "review",
        "gemini has no non-interactive structured-review surface; configure the review state with explicit `command` or a different agent"
      );
    }
    return { command: joinArgs(buildBaseArgs(input)) };
  },

  runResume(_input: AdapterResumeInput): AdapterCommand {
    // `gemini --resume` accepts an index, not a stable session id; see
    // file header. Throwing here is the safe option per architect §10.8.
    throw new AdapterUnsupported(
      "gemini",
      "runResume",
      "gemini --resume takes a project-relative index, not a stable session id"
    );
  },

  /**
   * Gemini's stream-json output does not surface a session id we can
   * trust for resume (see file header). Parsing is intentionally a
   * no-op so the host marks the session non-resumable.
   */
  parseResult(_stdout: string, _stderr: string, _exitCode: number): AdapterRunResult {
    return {};
  }
};
