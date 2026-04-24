import {
  Client,
  Connection,
  type WorkflowExecutionDescription,
  type WorkflowExecutionInfo
} from "@temporalio/client";
import { arrayFromPayloads, defaultDataConverter } from "@temporalio/common";
import { assertNoInlineSecrets } from "../security/inlineSecrets.js";
import { normalizeTemporalConfig, type TemporalConfig } from "./manager.js";
import type {
  SimpleWorkflowDismissInboxSignalInput,
  SimpleWorkflowExtendIterationsSignalInput,
  SimpleWorkflowRegisterSessionSignalInput,
  SimpleWorkflowResumeSessionSignalInput,
  SimpleWorkflowContinuationSignalInput
} from "./types.js";
import {
  interactionApproveStateSignalName,
  interactionModifyStateSignalName,
  interactionPendingStateQueryName,
  interactionRejectStateSignalName,
  simpleWorkflowContinueSignalName,
  simpleWorkflowDismissInboxSignalName,
  simpleWorkflowExtendIterationsSignalName,
  simpleWorkflowRegisterSessionSignalName,
  simpleWorkflowResumeSessionSignalName,
  tychonicWorkflowStateQueryName,
  type InteractionApproveStatePayload,
  type InteractionModifyStatePayload,
  type InteractionRejectStatePayload,
  type StateRecordPatch
} from "./types.js";
import type { WorkflowStateRecord, WorkflowStateStatus } from "../domain/types.js";

const RUNNING_WORKFLOW_QUERY_TIMEOUT_MS = 2_000;

export interface StartNamedTemporalWorkflowOptions extends TemporalConfig {
  workflowType: string;
  input?: unknown;
  workflowId?: string;
  wait?: boolean;
}

export interface StartNamedTemporalWorkflowResult {
  workflowId: string;
  firstExecutionRunId: string;
  result?: unknown;
}

export interface SignalSimpleWorkflowContinuationOptions extends TemporalConfig, SimpleWorkflowContinuationSignalInput {
  workflowId: string;
  runId?: string;
}

export interface SignalSimpleWorkflowSignalResult {
  workflowId: string;
  runId?: string;
  signaled: true;
}

export interface SignalSimpleWorkflowInboxDismissOptions extends TemporalConfig, SimpleWorkflowDismissInboxSignalInput {
  workflowId: string;
  runId?: string;
}

export interface SignalSimpleWorkflowRegisterSessionOptions extends TemporalConfig, SimpleWorkflowRegisterSessionSignalInput {
  workflowId: string;
  runId?: string;
}

export interface SignalSimpleWorkflowResumeSessionOptions extends TemporalConfig, SimpleWorkflowResumeSessionSignalInput {
  workflowId: string;
  runId?: string;
}

export interface SignalSimpleWorkflowExtendIterationsOptions
  extends TemporalConfig,
    SimpleWorkflowExtendIterationsSignalInput {
  workflowId: string;
  runId?: string;
}

export interface SignalInteractionApproveStateOptions extends TemporalConfig {
  workflowId: string;
  runId?: string;
  state: string;
}

export interface SignalInteractionRejectStateOptions extends TemporalConfig {
  workflowId: string;
  runId?: string;
  state: string;
  feedback: string;
}

export interface SignalInteractionModifyStateOptions extends TemporalConfig {
  workflowId: string;
  runId?: string;
  state: string;
  patch: StateRecordPatch;
}

export interface QueryInteractionPendingStateOptions extends TemporalConfig {
  workflowId: string;
  runId?: string;
}

export interface InteractionPendingStateResult {
  pendingState?: string;
  resultError?: string;
}

export interface DescribeTychonicTemporalWorkflowOptions extends TemporalConfig {
  workflowId: string;
  runId?: string;
  includeResult?: boolean;
}

export interface ListTychonicTemporalWorkflowsOptions extends TemporalConfig {
  limit?: number;
  query?: string;
}

export interface TychonicTemporalWorkflowSummary {
  workflowId: string;
  runId: string;
  type: string;
  taskQueue: string;
  status: string;
  historyLength?: number;
  startTime: string;
  executionTime?: string;
  closeTime?: string;
}

export interface TychonicTemporalPendingActivity {
  activityId: string;
  activityType?: string;
  state?: number;
  attempt?: number;
  maximumAttempts?: number;
  lastHeartbeatTime?: string;
  lastStartedTime?: string;
  heartbeatDetails?: unknown[];
  lastFailureMessage?: string;
  lastWorkerIdentity?: string;
}

export interface TychonicTemporalPendingWorkflowTask {
  state?: "unspecified" | "scheduled" | "started";
  attempt?: number;
  scheduledTime?: string;
  originalScheduledTime?: string;
  startedTime?: string;
}

export interface TychonicTemporalWorkflowStatus extends TychonicTemporalWorkflowSummary {
  pendingActivities: TychonicTemporalPendingActivity[];
  pendingWorkflowTask?: TychonicTemporalPendingWorkflowTask;
  result?: unknown;
  resultError?: string;
}

export interface TychonicTemporalWorkflowList {
  address: string;
  namespace: string;
  taskQueue: string;
  workflows: TychonicTemporalWorkflowSummary[];
}

type WorkflowExecutionInfoForSummary = Pick<
  WorkflowExecutionInfo,
  | "workflowId"
  | "runId"
  | "type"
  | "taskQueue"
  | "status"
  | "historyLength"
  | "startTime"
  | "executionTime"
  | "closeTime"
>;

export async function startNamedTemporalWorkflow(
  options: StartNamedTemporalWorkflowOptions
): Promise<StartNamedTemporalWorkflowResult> {
  const config = normalizeTemporalConfig(options);
  const connection = await Connection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const workflowId = options.workflowId ?? createNamedWorkflowId(options.workflowType);
  const handle = await client.workflow.start(options.workflowType, {
    ...(Object.prototype.hasOwnProperty.call(options, "input") ? { args: [options.input] } : {}),
    taskQueue: config.taskQueue,
    workflowId
  });

  if (!options.wait) {
    return { workflowId: handle.workflowId, firstExecutionRunId: handle.firstExecutionRunId };
  }

  return {
    workflowId: handle.workflowId,
    firstExecutionRunId: handle.firstExecutionRunId,
    result: await handle.result()
  };
}

export async function describeTychonicTemporalWorkflow(
  options: DescribeTychonicTemporalWorkflowOptions
): Promise<TychonicTemporalWorkflowStatus> {
  const config = normalizeTemporalConfig(options);
  const connection = await Connection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const handle = client.workflow.getHandle(options.workflowId, options.runId);
  const description = await handle.describe();
  const status = summarizeTemporalWorkflowDescription(description);

  if (!options.includeResult) {
    return status;
  }

  if (status.status === "RUNNING") {
    if (!shouldQueryRunningWorkflowState(status)) {
      return status;
    }
    const queriedState = await queryTychonicWorkflowState(handle);
    return {
      ...status,
      ...(queriedState.result ? { result: queriedState.result } : {}),
      ...(queriedState.resultError ? { resultError: queriedState.resultError } : {})
    };
  }

  try {
    return {
      ...status,
      result: await handle.result()
    };
  } catch (error) {
    return {
      ...status,
      resultError: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function signalSimpleWorkflowContinuation(
  options: SignalSimpleWorkflowContinuationOptions
): Promise<SignalSimpleWorkflowSignalResult> {
  validateSignalCommandOptions(options, "simple_workflow continuation");
  const config = normalizeTemporalConfig(options);
  const connection = await Connection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const handle = client.workflow.getHandle(options.workflowId, options.runId);
  await handle.signal(simpleWorkflowContinueSignalName, {
    inboxItemId: options.inboxItemId,
    ...(options.command ? { command: options.command } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.resumeCommand ? { resumeCommand: options.resumeCommand } : {}),
    ...(options.workerCandidates ? { workerCandidates: options.workerCandidates } : {}),
    ...(options.goal ? { goal: options.goal } : {}),
    ...(options.verifyCommand ? { verifyCommand: options.verifyCommand } : {}),
    ...(options.reviewCommand ? { reviewCommand: options.reviewCommand } : {}),
    ...(options.reviewAgent ? { reviewAgent: options.reviewAgent } : {}),
    ...(options.reviewCandidates ? { reviewCandidates: options.reviewCandidates } : {}),
    ...(options.commandTimeoutMs ? { commandTimeoutMs: options.commandTimeoutMs } : {}),
    ...(options.activityTimeouts ? { activityTimeouts: options.activityTimeouts } : {})
  });
  return {
    workflowId: options.workflowId,
    ...(options.runId ? { runId: options.runId } : {}),
    signaled: true
  };
}

export async function signalSimpleWorkflowInboxDismiss(
  options: SignalSimpleWorkflowInboxDismissOptions
): Promise<SignalSimpleWorkflowSignalResult> {
  const config = normalizeTemporalConfig(options);
  const connection = await Connection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const handle = client.workflow.getHandle(options.workflowId, options.runId);
  await handle.signal(simpleWorkflowDismissInboxSignalName, {
    inboxItemId: options.inboxItemId,
    ...(options.reason ? { reason: options.reason } : {})
  });
  return {
    workflowId: options.workflowId,
    ...(options.runId ? { runId: options.runId } : {}),
    signaled: true
  };
}

export async function signalSimpleWorkflowRegisterSession(
  options: SignalSimpleWorkflowRegisterSessionOptions
): Promise<SignalSimpleWorkflowSignalResult> {
  assertOptionalCommandHasNoInlineSecrets(options.resumeCommand, "registered resume command");
  const config = normalizeTemporalConfig(options);
  const connection = await Connection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const handle = client.workflow.getHandle(options.workflowId, options.runId);
  await handle.signal(simpleWorkflowRegisterSessionSignalName, {
    id: options.id,
    agent: options.agent,
    role: options.role,
    cwd: options.cwd,
    ...(options.status ? { status: options.status } : {}),
    ...(options.externalSessionId ? { externalSessionId: options.externalSessionId } : {}),
    ...(options.resumeCommand ? { resumeCommand: options.resumeCommand } : {}),
    startedAt: options.startedAt
  });
  return {
    workflowId: options.workflowId,
    ...(options.runId ? { runId: options.runId } : {}),
    signaled: true
  };
}

export async function signalSimpleWorkflowResumeSession(
  options: SignalSimpleWorkflowResumeSessionOptions
): Promise<SignalSimpleWorkflowSignalResult> {
  validateSignalCommandOptions(options, "session resume");
  const config = normalizeTemporalConfig(options);
  const connection = await Connection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const handle = client.workflow.getHandle(options.workflowId, options.runId);
  await handle.signal(simpleWorkflowResumeSessionSignalName, {
    sessionId: options.sessionId,
    prompt: options.prompt,
    verifyCommand: options.verifyCommand,
    ...(options.reviewCommand ? { reviewCommand: options.reviewCommand } : {}),
    ...(options.reviewAgent ? { reviewAgent: options.reviewAgent } : {}),
    ...(options.reviewCandidates ? { reviewCandidates: options.reviewCandidates } : {}),
    ...(options.commandTimeoutMs ? { commandTimeoutMs: options.commandTimeoutMs } : {}),
    ...(options.activityTimeouts ? { activityTimeouts: options.activityTimeouts } : {})
  });
  return {
    workflowId: options.workflowId,
    ...(options.runId ? { runId: options.runId } : {}),
    signaled: true
  };
}

export async function signalSimpleWorkflowExtendIterations(
  options: SignalSimpleWorkflowExtendIterationsOptions
): Promise<SignalSimpleWorkflowSignalResult> {
  validateSignalCommandOptions(options, "simple_workflow extend iterations");
  if (options.maxIterations !== undefined) {
    if (!Number.isInteger(options.maxIterations) || options.maxIterations < 1) {
      throw new Error("simple_workflow extend iterations maxIterations must be a positive integer");
    }
  }
  const config = normalizeTemporalConfig(options);
  const connection = await Connection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const handle = client.workflow.getHandle(options.workflowId, options.runId);
  await handle.signal(simpleWorkflowExtendIterationsSignalName, {
    ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
    ...(options.command ? { command: options.command } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.resumeCommand ? { resumeCommand: options.resumeCommand } : {}),
    ...(options.workerCandidates ? { workerCandidates: options.workerCandidates } : {}),
    ...(options.goal ? { goal: options.goal } : {}),
    ...(options.verifyCommand ? { verifyCommand: options.verifyCommand } : {}),
    ...(options.reviewCommand ? { reviewCommand: options.reviewCommand } : {}),
    ...(options.reviewAgent ? { reviewAgent: options.reviewAgent } : {}),
    ...(options.reviewCandidates ? { reviewCandidates: options.reviewCandidates } : {}),
    ...(options.commandTimeoutMs ? { commandTimeoutMs: options.commandTimeoutMs } : {}),
    ...(options.activityTimeouts ? { activityTimeouts: options.activityTimeouts } : {})
  });
  return {
    workflowId: options.workflowId,
    ...(options.runId ? { runId: options.runId } : {}),
    signaled: true
  };
}

/**
 * Terminal state statuses that an external `modifyState` payload may
 * carry. Matches the runMerge contract (`applyModifyStateDecision`).
 */
const INTERACTION_MODIFY_TERMINAL_STATUSES: readonly WorkflowStateStatus[] = [
  "succeeded",
  "failed",
  "skipped",
  "blocked",
  "timed_out"
];

export async function signalInteractionApproveState(
  options: SignalInteractionApproveStateOptions
): Promise<SignalSimpleWorkflowSignalResult> {
  validateInteractionStateName(options.state, "approveState");
  const config = normalizeTemporalConfig(options);
  const connection = await Connection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const handle = client.workflow.getHandle(options.workflowId, options.runId);
  const payload: InteractionApproveStatePayload = { state: options.state };
  await handle.signal(interactionApproveStateSignalName, payload);
  return {
    workflowId: options.workflowId,
    ...(options.runId ? { runId: options.runId } : {}),
    signaled: true
  };
}

export async function signalInteractionRejectState(
  options: SignalInteractionRejectStateOptions
): Promise<SignalSimpleWorkflowSignalResult> {
  validateInteractionStateName(options.state, "rejectState");
  if (typeof options.feedback !== "string" || options.feedback.length === 0) {
    throw new Error("rejectState feedback must be a non-empty string");
  }
  const config = normalizeTemporalConfig(options);
  const connection = await Connection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const handle = client.workflow.getHandle(options.workflowId, options.runId);
  const payload: InteractionRejectStatePayload = {
    state: options.state,
    feedback: options.feedback
  };
  await handle.signal(interactionRejectStateSignalName, payload);
  return {
    workflowId: options.workflowId,
    ...(options.runId ? { runId: options.runId } : {}),
    signaled: true
  };
}

export async function signalInteractionModifyState(
  options: SignalInteractionModifyStateOptions
): Promise<SignalSimpleWorkflowSignalResult> {
  validateInteractionStateName(options.state, "modifyState");
  validateInteractionModifyPayload(options.state, options.patch);
  const config = normalizeTemporalConfig(options);
  const connection = await Connection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const handle = client.workflow.getHandle(options.workflowId, options.runId);
  const payload: InteractionModifyStatePayload = {
    state: options.state,
    patch: options.patch
  };
  await handle.signal(interactionModifyStateSignalName, payload);
  return {
    workflowId: options.workflowId,
    ...(options.runId ? { runId: options.runId } : {}),
    signaled: true
  };
}

export async function queryInteractionPendingState(
  options: QueryInteractionPendingStateOptions
): Promise<InteractionPendingStateResult> {
  const config = normalizeTemporalConfig(options);
  const connection = await Connection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const handle = client.workflow.getHandle(options.workflowId, options.runId);
  try {
    const result = await withTimeout(
      handle.query<string | undefined>(interactionPendingStateQueryName),
      RUNNING_WORKFLOW_QUERY_TIMEOUT_MS,
      `pending-state query timed out after ${RUNNING_WORKFLOW_QUERY_TIMEOUT_MS}ms`
    );
    return result === undefined || result === null ? {} : { pendingState: result };
  } catch (error) {
    return {
      resultError: error instanceof Error ? error.message : String(error)
    };
  }
}

function validateInteractionStateName(state: unknown, signalLabel: string): void {
  if (typeof state !== "string" || state.length === 0) {
    throw new Error(`${signalLabel} 'state' must be a non-empty string`);
  }
}

/**
 * SPEC Edit 3 requires `modifyState` payloads to carry a full
 * `WorkflowStateRecord` whose `name === state` and whose `status` is
 * terminal. The worker-side `applyModifyStateDecision` re-validates
 * the same contract (defense in depth against non-CLI callers), but
 * client callers get a cleaner error here before the signal is sent.
 *
 * `WorkflowStateRecord` does not currently carry a command string (see
 * `src/domain/types.ts` lines 46-57), so there is no inline-secret
 * surface to guard today. If the shape ever grows a command field,
 * extend this guard with `assertOptionalCommandHasNoInlineSecrets`.
 */
function validateInteractionModifyPayload(_state: string, patch: unknown): void {
  if (!patch || typeof patch !== "object") {
    throw new Error("modifyState patch must be a StateRecordPatch object");
  }
  const p = patch as Partial<StateRecordPatch>;
  if (
    p.status !== undefined &&
    !INTERACTION_MODIFY_TERMINAL_STATUSES.includes(p.status as (typeof INTERACTION_MODIFY_TERMINAL_STATUSES)[number])
  ) {
    throw new Error(
      `modifyState patch.status must be terminal (one of ${INTERACTION_MODIFY_TERMINAL_STATUSES.join(", ")}), got '${String(p.status)}'`
    );
  }
  if (p.reason !== undefined && typeof p.reason !== "string") {
    throw new Error("modifyState patch.reason must be a string");
  }
  if (p.note !== undefined && typeof p.note !== "string") {
    throw new Error("modifyState patch.note must be a string");
  }
  if (p.artifacts !== undefined && !Array.isArray(p.artifacts)) {
    throw new Error("modifyState patch.artifacts must be an array");
  }
  if (p.findings !== undefined && !Array.isArray(p.findings)) {
    throw new Error("modifyState patch.findings must be an array");
  }
}

function validateSignalCommandOptions(
  options: {
    command?: string;
    verifyCommand?: string;
    resumeCommand?: string;
    workerCandidates?: { agent: string; command?: string; resumeCommand?: string }[];
    reviewCommand?: string;
    reviewCandidates?: { agent: string; command?: string; resumeCommand?: string }[];
  },
  label: string
): void {
  assertOptionalCommandHasNoInlineSecrets(options.command, `${label} worker command`);
  assertOptionalCommandHasNoInlineSecrets(options.verifyCommand, `${label} verify command`);
  assertOptionalCommandHasNoInlineSecrets(options.resumeCommand, `${label} resume command`);
  assertOptionalCommandHasNoInlineSecrets(options.reviewCommand, `${label} review command`);
  for (const candidate of options.workerCandidates ?? []) {
    assertOptionalCommandHasNoInlineSecrets(candidate.command, `${label} worker candidate ${candidate.agent} command`);
    assertOptionalCommandHasNoInlineSecrets(
      candidate.resumeCommand,
      `${label} worker candidate ${candidate.agent} resume command`
    );
  }
  for (const candidate of options.reviewCandidates ?? []) {
    assertOptionalCommandHasNoInlineSecrets(candidate.command, `${label} review candidate ${candidate.agent} command`);
    if (candidate.resumeCommand) {
      throw new Error(`${label} review candidate ${candidate.agent} must not set resumeCommand`);
    }
  }
}

function assertOptionalCommandHasNoInlineSecrets(command: string | undefined, label: string): void {
  if (command) {
    assertNoInlineSecrets(command, label);
  }
}

export async function listTychonicTemporalWorkflows(
  options: ListTychonicTemporalWorkflowsOptions = {}
): Promise<TychonicTemporalWorkflowList> {
  const config = normalizeTemporalConfig(options);
  const connection = await Connection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const limit = Math.max(1, options.limit ?? 20);
  const workflows: TychonicTemporalWorkflowSummary[] = [];

  for await (const info of client.workflow.list({
    pageSize: Math.max(limit, 1),
    ...(options.query ? { query: options.query } : {})
  })) {
    if (!options.query && !isTychonicWorkflow(info)) {
      continue;
    }
    workflows.push(summarizeTemporalWorkflowInfo(info));
    if (workflows.length >= limit) {
      break;
    }
  }

  return {
    address: config.address,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflows
  };
}

export function summarizeTemporalWorkflowDescription(
  description: WorkflowExecutionDescription
): TychonicTemporalWorkflowStatus {
  const summary = summarizeTemporalWorkflowInfo(description);
  return {
    ...summary,
    pendingActivities: (description.raw.pendingActivities ?? []).map(summarizePendingActivity),
    ...(summary.status === "RUNNING" && description.raw.pendingWorkflowTask
      ? { pendingWorkflowTask: summarizePendingWorkflowTask(description.raw.pendingWorkflowTask) }
      : {})
  };
}

export function summarizeTemporalWorkflowInfo(
  info: WorkflowExecutionInfoForSummary
): TychonicTemporalWorkflowSummary {
  return {
    workflowId: info.workflowId,
    runId: info.runId,
    type: info.type,
    taskQueue: info.taskQueue,
    status: info.status.name,
    ...(!(info.status.name === "RUNNING" && info.historyLength === 0) ? { historyLength: info.historyLength } : {}),
    startTime: info.startTime.toISOString(),
    ...(info.executionTime ? { executionTime: info.executionTime.toISOString() } : {}),
    ...(info.closeTime ? { closeTime: info.closeTime.toISOString() } : {})
  };
}

function createNamedWorkflowId(workflowType: string): string {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "_").replace("Z", "");
  const suffix = Math.random().toString(36).slice(2, 8);
  const safeType = workflowType.replace(/[^A-Za-z0-9_]+/g, "_") || "workflow";
  return `tychonic_${safeType}_${timestamp}_${suffix}`;
}

function isTychonicWorkflow(info: WorkflowExecutionInfo): boolean {
  return info.workflowId.startsWith("tychonic_");
}

async function queryTychonicWorkflowState(
  handle: ReturnType<Client["workflow"]["getHandle"]>
): Promise<{
  result?: unknown;
  resultError?: string;
}> {
  try {
    const result = await withTimeout(
      handle.query<unknown>(tychonicWorkflowStateQueryName),
      RUNNING_WORKFLOW_QUERY_TIMEOUT_MS,
      `running workflow state query timed out after ${RUNNING_WORKFLOW_QUERY_TIMEOUT_MS}ms`
    );
    return result ? { result } : {};
  } catch (error) {
    return {
      resultError: error instanceof Error ? error.message : String(error)
    };
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function summarizePendingActivity(
  activity: NonNullable<WorkflowExecutionDescription["raw"]["pendingActivities"]>[number]
): TychonicTemporalPendingActivity {
  const heartbeatDetails = decodePayloads(activity.heartbeatDetails?.payloads);
  return {
    activityId: activity.activityId ?? "",
    ...(activity.activityType?.name ? { activityType: activity.activityType.name } : {}),
    ...(activity.state !== undefined && activity.state !== null ? { state: activity.state } : {}),
    ...(activity.attempt !== undefined && activity.attempt !== null ? { attempt: activity.attempt } : {}),
    ...(activity.maximumAttempts !== undefined && activity.maximumAttempts !== null
      ? { maximumAttempts: activity.maximumAttempts }
      : {}),
    ...(activity.lastHeartbeatTime ? { lastHeartbeatTime: timestampToISO(activity.lastHeartbeatTime) } : {}),
    ...(activity.lastStartedTime ? { lastStartedTime: timestampToISO(activity.lastStartedTime) } : {}),
    ...(heartbeatDetails.length > 0 ? { heartbeatDetails } : {}),
    ...(activity.lastFailure?.message ? { lastFailureMessage: activity.lastFailure.message } : {}),
    ...(activity.lastWorkerIdentity ? { lastWorkerIdentity: activity.lastWorkerIdentity } : {})
  };
}

function shouldQueryRunningWorkflowState(status: TychonicTemporalWorkflowStatus): boolean {
  if (!status.pendingWorkflowTask) {
    return true;
  }
  return (status.historyLength ?? 0) > 2;
}

function summarizePendingWorkflowTask(
  task: NonNullable<WorkflowExecutionDescription["raw"]["pendingWorkflowTask"]>
): TychonicTemporalPendingWorkflowTask {
  return {
    ...(task.state !== undefined && task.state !== null ? { state: summarizePendingWorkflowTaskState(task.state) } : {}),
    ...(task.attempt !== undefined && task.attempt !== null ? { attempt: task.attempt } : {}),
    ...(task.scheduledTime ? { scheduledTime: timestampToISO(task.scheduledTime) } : {}),
    ...(task.originalScheduledTime ? { originalScheduledTime: timestampToISO(task.originalScheduledTime) } : {}),
    ...(task.startedTime ? { startedTime: timestampToISO(task.startedTime) } : {})
  };
}

function summarizePendingWorkflowTaskState(
  state: number
): NonNullable<TychonicTemporalPendingWorkflowTask["state"]> {
  switch (state) {
    case 1:
      return "scheduled";
    case 2:
      return "started";
    default:
      return "unspecified";
  }
}

function decodePayloads(
  payloads:
    | NonNullable<
        NonNullable<WorkflowExecutionDescription["raw"]["pendingActivities"]>[number]["heartbeatDetails"]
      >["payloads"]
    | null
    | undefined
): unknown[] {
  if (!payloads?.length) {
    return [];
  }
  try {
    return arrayFromPayloads(defaultDataConverter.payloadConverter, payloads);
  } catch {
    return [];
  }
}

function timestampToISO(timestamp: { seconds?: unknown; nanos?: unknown }): string {
  const seconds = Number(timestamp.seconds ?? 0);
  const nanos = Number(timestamp.nanos ?? 0);
  return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000)).toISOString();
}
