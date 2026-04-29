/**
 * Built-in agent adapter contract.
 *
 * An `AgentAdapter` translates a host-level intent ("run a worker / reviewer
 * session against agent X with role Y") into the concrete
 * shell command and stdin layout the underlying CLI expects, and translates
 * the CLI's stdout back into a normalised result the host can attach to a
 * `AgentSessionRecord`.
 *
 * The adapter is pure and transport-independent. It does NOT spawn anything,
 * touch the filesystem, or hold state between calls. Spawning, heartbeating,
 * artifact write, and timeout enforcement remain the responsibility of
 * `bootstrap/workerActivityBody.ts` and `bootstrap/commandRunner.ts`.
 *
 * Role mapping ("work" / "review") drives permission flag
 * selection inside each adapter. The role is supplied per call and is the
 * sole source of permission policy unless the caller explicitly overrides
 * via `model` / `reasoning_effort` / `sandbox` / `approval` /
 * `permission_mode` / `trust_all_tools`.
 */

import type {
  ActivityType
} from "../catalog/types.js";

/**
 * Built-in adapter names accepted by validated `states.<name>.agent` blocks.
 */
export type BuiltInAgentName = "claude" | "codex" | "gemini" | "kiro";

/**
 * Roles that the host knows how to map to permission flags. Maps directly
 * to the relevant subset of `ActivityType`.
 */
export type AdapterRole = Extract<ActivityType, "work" | "review">;

export type AdapterSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type AdapterApproval = "never" | "on-request" | "on-failure" | "untrusted";
export type AdapterPermissionMode =
  | "plan"
  | "default"
  | "acceptEdits"
  | "bypassPermissions";

/**
 * Inputs every `runNew` / `runResume` call shares.
 *
 * `prompt` is the verbatim text the activity will pipe on stdin. The host
 * provides it through `runCommand`'s `stdin` field. If an underlying CLI
 * requires a positional prompt, that adapter must build an internal wrapper
 * that reads stdin and passes the prompt to the CLI without creating a second
 * prompt channel in the activity contract.
 *
 * `worktreeCwd` is informational. The host already chdirs the spawn into
 * the worktree before invoking the command; adapters do not insert `cd`.
 *
 * Orchestration overrides (`sandbox` / `approval` / `permission_mode` /
 * `trust_all_tools`) are applied verbatim and replace the role-derived
 * default. Agent settings (`model` / `reasoning_effort`) are passed through
 * only when the selected adapter supports the corresponding CLI surface.
 * They are sourced from the validated state config block.
 */
export interface AdapterRunInput {
  prompt: string;
  worktreeCwd: string;
  role: AdapterRole;
  model?: string;
  reasoningEffort?: string;
  sandbox?: AdapterSandbox;
  approval?: AdapterApproval;
  permissionMode?: AdapterPermissionMode;
  trustAllTools?: boolean;
}

export interface AdapterResumeInput extends AdapterRunInput {
  /** Opaque session id returned earlier by `parseResult`. */
  sessionId: string;
}

/**
 * Concrete invocation produced by an adapter.
 *
 * `command` is a shell-ready string, identical in shape to what a user
 * would write in a bundle's `command:` field. The host passes it to
 * `runCommand`, which handles spawning.
 *
 */
export interface AdapterCommand {
  command: string;
}

/**
 * Normalised result of parsing the CLI's stdout (and stderr, exit code).
 *
 * `sessionId` is set when the CLI exposed a stable id we can use
 * for adapter-owned resume. `undefined` means this session is non-resumable.
 */
export interface AdapterRunResult {
  sessionId?: string;
}

/**
 * Error class adapters throw when the requested operation is not
 * supported by the underlying CLI. Examples:
 * - gemini `runResume`: gemini's `--resume` takes a project-relative
 *   index, not a stable UUID, so it cannot be safely scripted.
 * - gemini `review`: gemini does not currently emit a non-interactive
 *   structured-review surface.
 *
 * Activity dispatch catches this and surfaces it as a workflow-level error.
 */
export class AdapterUnsupported extends Error {
  readonly adapter: BuiltInAgentName;
  readonly operation: "runNew" | "runResume" | "review";

  constructor(
    adapter: BuiltInAgentName,
    operation: "runNew" | "runResume" | "review",
    detail: string
  ) {
    super(`adapter ${adapter} does not support ${operation}: ${detail}`);
    this.name = "AdapterUnsupported";
    this.adapter = adapter;
    this.operation = operation;
  }
}

/**
 * Adapter contract.
 *
 * - `runNew(input)`: produce the argv for a fresh session. Must respect
 *   `input.role` for permission flag selection and apply explicit
 *   orchestration overrides.
 * - `runResume(input)`: produce the argv that resumes
 *   `input.sessionId`. Throw `AdapterUnsupported` if the CLI has
 *   no stable resume-by-id surface.
 * - `parseResult(stdout, stderr, exitCode)`: extract `sessionId`
 *   from the CLI's output. Pure; never throws on missing id (returns
 *   `undefined`). Throw only on hard parse errors that should fail the
 *   activity.
 */
export interface AgentAdapter {
  readonly name: BuiltInAgentName;
  runNew(input: AdapterRunInput): AdapterCommand;
  runResume(input: AdapterResumeInput): AdapterCommand;
  parseResult(stdout: string, stderr: string, exitCode: number): AdapterRunResult;
}
