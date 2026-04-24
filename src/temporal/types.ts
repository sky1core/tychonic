import type { AgentSessionRecord, ArtifactRecord, WorkflowRunRecord, WorkflowStateRecord, WorkflowRunStatus } from "../domain/types.js";
import type { ActivityTimeoutOverrides, ActivityType, TychonicConfig } from "../catalog/types.js";
import type { WorkflowRunDelta } from "../domain/runDelta.js";
import type { ParsedReviewResult, ReviewActivityOutcome } from "../review/outcome.js";
import type { WorkerActivityOutcome } from "../worker/outcome.js";

export type { ParsedReviewResult, ReviewActivityOutcome } from "../review/outcome.js";
export type { WorkerActivityOutcome } from "../worker/outcome.js";

export const tychonicWorkflowStateQueryName = "tychonic.workflow_state";
export const simpleWorkflowContinueSignalName = "tychonic.simple_workflow.continue";
export const simpleWorkflowRegisterSessionSignalName = "tychonic.simple_workflow.register_session";
export const simpleWorkflowResumeSessionSignalName = "tychonic.simple_workflow.resume_session";
export const simpleWorkflowDismissInboxSignalName = "tychonic.simple_workflow.dismiss_inbox";
export const simpleWorkflowExtendIterationsSignalName = "tychonic.simple_workflow.extend_iterations";

export const interactionApproveStateSignalName = "tychonic.interaction.approve_state";
export const interactionRejectStateSignalName = "tychonic.interaction.reject_state";
export const interactionModifyStateSignalName = "tychonic.interaction.modify_state";

export const interactionPendingStateQueryName = "tychonic.interaction.pending_state";

export interface InteractionApproveStatePayload {
  state: string;
}

export interface InteractionRejectStatePayload {
  state: string;
  feedback: string;
}

export interface StateRecordPatch {
  /** Terminal status to set on the state (optional; existing status kept if absent). */
  status?: import("../domain/types.js").WorkflowStateStatus;
  /** Replace the state's `reason`. */
  reason?: string;
  /**
   * Short annotation. If `reason` is also patched (or already present),
   * the note is appended as `<reason> — note: <text>`. Otherwise the
   * note becomes the reason.
   */
  note?: string;
  /** Artifacts appended to `run.artifacts` and to `state.artifact_ids`. */
  artifacts?: import("../domain/types.js").ArtifactRecord[];
  /** Findings appended to `run.findings` and to `state.finding_ids`. */
  findings?: import("../domain/types.js").FindingRecord[];
}

export interface InteractionModifyStatePayload {
  state: string;
  patch: StateRecordPatch;
}

export type InteractionSignalPayload =
  | ({ kind: "approve" } & InteractionApproveStatePayload)
  | ({ kind: "reject" } & InteractionRejectStatePayload)
  | ({ kind: "modify" } & InteractionModifyStatePayload);

export interface ActivityExtrasBase {
  command?: string;
  prompt?: string;
  worktreePath?: string;
  verificationCommands?: string[];
}

export interface ExtrasByType {
  lint: {
    command?: string;
    worktreePath?: string;
    // TODO(stage 3): add deterministic-command inputs that move out of bootstrap/checkpointRunner.ts.
  };
  unit_test: {
    command?: string;
    worktreePath?: string;
    // TODO(stage 3): add skip-condition inputs once unit-test execution moves into a dedicated activity.
  };
  integration: {
    command?: string;
    worktreePath?: string;
    // TODO(stage 3): add integration-policy inputs when policy handling moves into the activity body.
  };
  work: {
    command?: string;
    prompt?: string;
    goal?: string;
    worktreePath?: string;
    sessionId?: string;
    // TODO(stage 4): add worker candidate metadata.
  };
  verify: {
    command?: string;
    worktreePath?: string;
    // TODO(stage 3): add verify-specific execution metadata.
  };
  review: {
    prompt?: string;
    verificationCommands?: string[];
    worktreePath?: string;
    // TODO(stage 2): add review execution metadata after the common review body lands.
  };
  auto_continue: {
    prompt?: string;
    worktreePath?: string;
    verificationCommands?: string[];
    /**
     * When present the activity runs in resume mode: invokes the existing
     * worker session referenced by `sessionId` (which must already live in
    * `input.run.agent_sessions` and carry a `resume_command`). When absent
     * the activity runs in fresh mode using `command` + `prompt`.
     */
    sessionId?: string;
    command?: string;
    agent?: string;
  };
}

/**
 * Input contract for a Tychonic TYPE-per-activity call (stage 1+).
 *
 * All typed activities share this shape and receive the target activity's
 * name explicitly. The activity reads `profile.states[name]`, validates
 * that the block's type matches `T`, and executes the contract for `T`.
 *
 * @field name   The NAME of the activity block to execute. User-chosen
 *               identifier, not a slot key. The activity never hardcodes it.
 * @field run    The Tychonic `WorkflowRunRecord` at call time. Its `run.id`
 *               is the sole run identifier across the whole system — used
 *               for `.tychonic/runs/<id>/` paths, artifact/session records,
 *               inbox references, and cross-activity linkage. Temporal's
 *               own run id is an SDK concern and not surfaced here; if an
 *               activity needs it, read it from
 *               `Context.current().info.runId` inside the activity body.
 * @field profile
 *               The immutable workflow profile snapshot captured at
 *               workflow start. Activities read configuration through this.
 *               Workflows must not re-read config files after start.
 * @field cwd    The project root the workflow is operating on. Activities
 *               that need an isolated worktree receive that path through
 *               `extras.worktreePath`, not via `cwd`.
 * @field extras Per-TYPE input supplied by the workflow call site. See
 *               `ExtrasByType[T]` for the shape. Extras carry call-specific
 *               data (prompts, verification commands, worktree paths, etc.)
 *               while `profile.states[name]` carries configuration.
 */
export interface ActivityInput<T extends ActivityType> {
  stateName: string;
  run: WorkflowRunRecord;
  profile: TychonicConfig;
  cwd: string;
  extras: ExtrasByType[T];
}

/**
 * Output contract for a Tychonic TYPE-per-activity call.
 *
 * Activities never mutate `input.run`. They return a `WorkflowRunDelta`
 * describing what the call appended, plus optional TYPE-specific outcome
 * payloads for callers that need artifact/session/finding/inbox details
 * without re-walking the delta.
 *
 * @field delta              The run-record changes this call produced. See
 *                           `WorkflowRunDelta` for the five supported fields.
 *                           The caller merges the delta into its own run copy
 *                           (workflow state, existing runner, or a test shim).
 * @field reviewOutcome      Present only for review-type activities. 4-way
 *                           discriminated union pinned in SPEC §Finding and
 *                           inbox routing. Callers switch on `kind` to decide
 *                           whether to push inbox items or append findings;
 *                           `artifacts` / `agentSessions` carry full records
 *                           (not ids) that the caller appends to
 *                           `run.artifacts` / `run.agent_sessions`.
 * @field commandOutcome     Present only for deterministic-command activities
 *                           (`lint`, `unit_test`, `integration`, `verify`).
 *                           Carries the single `ArtifactRecord` the body
 *                           produced (command output). The caller appends it
 *                           to `run.artifacts`. The artifact exists regardless
 *                           of command success — `state.status` reflects the
 *                           command result.
 */
export interface ActivityResult {
  delta: WorkflowRunDelta;
  reviewOutcome?: ReviewActivityOutcome;
  commandOutcome?: { artifact: ArtifactRecord };
  workerOutcome?: WorkerActivityOutcome;
}

export interface CheckpointWorkflowInput {
  cwd: string;
  profile: TychonicConfig;
  goal?: string;
  targetSessionId?: string;
  autonomy?: "observe" | "check" | "review";
  commandTimeoutMs?: number;
  runId?: string;
}

export interface CheckpointWorkflowResult {
  runId: string;
  status: WorkflowRunStatus;
  run: WorkflowRunRecord;
  artifactRoot: string;
  summary?: string;
}

export interface SelfRepairWorkflowInput {
  cwd: string;
  profile: TychonicConfig;
  goal?: string;
  targetSessionId?: string;
  autonomy?: "observe" | "check" | "review";
  commandTimeoutMs?: number;
  runId?: string;
}

export interface SelfRepairWorkflowResult {
  runId: string;
  status: WorkflowRunStatus;
  run: WorkflowRunRecord;
  artifactRoot: string;
  worktreePath: string;
  summary?: string;
}

export interface SimpleWorkflowInput {
  cwd: string;
  command?: string;
  verifyCommand: string;
  goal?: string;
  agent?: string;
  resumeCommand?: string;
  workerCandidates?: AgentCandidateInput[];
  reviewCommand?: string;
  reviewAgent?: string;
  reviewCandidates?: AgentCandidateInput[];
  autoContinue?: boolean;
  maxIterations?: number;
  commandTimeoutMs?: number;
  activityTimeouts?: ActivityTimeoutOverrides;
  profile?: TychonicConfig;
  runId?: string;
  holdOpenOnWaiting?: boolean;
}

export interface AgentCandidateInput {
  agent: string;
  command?: string;
  resumeCommand?: string;
}

export interface SimpleWorkflowResult {
  runId: string;
  status: WorkflowRunStatus;
  run: WorkflowRunRecord;
  artifactRoot: string;
  worktreePath: string;
}

export interface SimpleWorkflowContinuationSignalInput {
  inboxItemId: string;
  command?: string;
  agent?: string;
  resumeCommand?: string;
  workerCandidates?: AgentCandidateInput[];
  goal?: string;
  verifyCommand?: string;
  reviewCommand?: string;
  reviewAgent?: string;
  reviewCandidates?: AgentCandidateInput[];
  commandTimeoutMs?: number;
  activityTimeouts?: ActivityTimeoutOverrides;
}

export interface SimpleWorkflowContinuationInput extends Omit<SimpleWorkflowContinuationSignalInput, "verifyCommand"> {
  cwd: string;
  run: WorkflowRunRecord;
  worktreePath: string;
  verifyCommand: string;
}

export interface SimpleWorkflowRegisterSessionSignalInput {
  id: string;
  agent: string;
  role: AgentSessionRecord["role"];
  cwd: string;
  status?: AgentSessionRecord["status"];
  externalSessionId?: string;
  resumeCommand?: string;
  startedAt: string;
}

export interface SimpleWorkflowResumeSessionSignalInput {
  sessionId: string;
  prompt: string;
  verifyCommand: string;
  reviewCommand?: string;
  reviewAgent?: string;
  reviewCandidates?: AgentCandidateInput[];
  commandTimeoutMs?: number;
  activityTimeouts?: ActivityTimeoutOverrides;
}

export interface SimpleWorkflowResumeSessionInput extends SimpleWorkflowResumeSessionSignalInput {
  cwd: string;
  run: WorkflowRunRecord;
  worktreePath: string;
}

export interface SimpleWorkflowDismissInboxSignalInput {
  inboxItemId: string;
  reason?: string;
}

export interface SimpleWorkflowExtendIterationsSignalInput {
  maxIterations?: number;
  command?: string;
  agent?: string;
  resumeCommand?: string;
  workerCandidates?: AgentCandidateInput[];
  goal?: string;
  verifyCommand?: string;
  reviewCommand?: string;
  reviewAgent?: string;
  reviewCandidates?: AgentCandidateInput[];
  commandTimeoutMs?: number;
  activityTimeouts?: ActivityTimeoutOverrides;
}

export interface SimpleWorkflowExtendIterationsInput extends Omit<SimpleWorkflowExtendIterationsSignalInput, "verifyCommand"> {
  cwd: string;
  run: WorkflowRunRecord;
  worktreePath: string;
  verifyCommand: string;
  maxIterations: number;
}

export interface SimpleWorkflowDismissInboxInput extends SimpleWorkflowDismissInboxSignalInput {
  cwd: string;
  run: WorkflowRunRecord;
  worktreePath: string;
}

export const DEFAULT_EXTEND_ITERATIONS_BUDGET = 5;

export interface TemporalConnectionOptions {
  address?: string;
  namespace?: string;
  taskQueue?: string;
}
