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
 * The role is supplied per call for backend behavior that needs work/review
 * context. Agent settings and explicitly supported execution settings are
 * sourced from the validated state config block.
 */

import type {
  ActivityType
} from "../catalog/types.js";

/**
 * Built-in adapter names accepted by validated `states.<name>.agent` blocks.
 */
export type BuiltInAgentName = "claude" | "codex" | "kiro";

/**
 * Roles that the host knows how to map to execution trust flags. Maps directly
 * to the relevant subset of `ActivityType`.
 */
export type AdapterRole = Extract<ActivityType, "work" | "review">;

export type AdapterPermissionMode = "bypassPermissions";

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
 * Agent settings (`model` / `reasoning_effort`) are passed through only when
 * the selected adapter supports the corresponding CLI surface. Execution
 * settings are included only when this adapter contract has an explicit OpenP
 * mapping for them.
 */
export interface AdapterRunInput {
  prompt: string;
  worktreeCwd: string;
  role: AdapterRole;
  executablePaths?: Readonly<Record<string, string>>;
  model?: string;
  reasoningEffort?: string;
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
 * `reportedModel` is set when the CLI reports the concrete model that handled
 * the request. Callers compare it with explicit state config when present.
 */
export interface AdapterRunResult {
  sessionId?: string;
  reportedModel?: string;
}

/**
 * Error class adapters throw when the requested operation is not
 * supported by the underlying CLI. Examples:
 * - kiro `review`: kiro does not currently emit a non-interactive
 *   structured-review surface and requires a normalizer.
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
 *   `input.role` for execution trust flag selection and apply explicit
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
  readonly executables: readonly string[];
  runNew(input: AdapterRunInput): AdapterCommand;
  runResume(input: AdapterResumeInput): AdapterCommand;
  parseResult(stdout: string, stderr: string, exitCode: number): AdapterRunResult;
}
