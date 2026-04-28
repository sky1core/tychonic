import type { ArtifactRecord, WorkflowRunRecord } from "../domain/types.js";
import type { ActivityType, TychonicConfig } from "../catalog/types.js";
import type { WorkflowRunDelta } from "../domain/runDelta.js";
import type { ReviewActivityOutcome } from "../review/outcome.js";
import type { WorkerActivityOutcome } from "../worker/outcome.js";

export type { ParsedReviewResult, ReviewActivityOutcome } from "../review/outcome.js";
export type { WorkerActivityOutcome } from "../worker/outcome.js";

export const tychonicWorkflowStateQueryName = "tychonic.workflow_state";

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

export interface ActivityCallFieldsByType {
  work: {
    prompt?: string;
    goal?: string;
    worktreePath?: string;
    sessionId?: string;
  };
  verify: {
    worktreePath?: string;
  };
  review: {
    prompt?: string;
    verificationCommands?: string[];
    worktreePath?: string;
  };
}

/**
 * Input contract for a Tychonic TYPE-per-activity call.
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
 *               the explicit `worktreePath` call field, not via `cwd`.
 *
 * Per-TYPE call fields are flattened onto the input object. They carry
 * runtime data (prompts, verification commands, worktree paths, session ids).
 * Execution selection stays in `profile.states[name]`; there is no per-call
 * command or agent selector.
 */
export type ActivityInput<T extends ActivityType> = {
  stateName: string;
  run: WorkflowRunRecord;
  profile: TychonicConfig;
  cwd: string;
} & ActivityCallFieldsByType[T];

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
 *                           (`verify`).
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

export interface TemporalConnectionOptions {
  address?: string;
  namespace?: string;
  taskQueue?: string;
}
