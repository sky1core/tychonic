import {
  Client,
  Connection,
  type WorkflowExecutionDescription,
  type WorkflowExecutionInfo
} from "@temporalio/client";
import { arrayFromPayloads, defaultDataConverter } from "@temporalio/common";
import { normalizeTemporalConfig, type TemporalConfig } from "./manager.js";
import {
  interactionApproveStateSignalName,
  interactionModifyStateSignalName,
  interactionPendingStateQueryName,
  interactionRejectStateSignalName,
  tychonicWorkflowStateQueryName,
  type InteractionApproveStatePayload,
  type InteractionModifyStatePayload,
  type InteractionRejectStatePayload,
  type StateRecordPatch
} from "./types.js";
import type { WorkflowStateRecord, WorkflowStateStatus } from "../domain/types.js";
import type { WorkflowRunStatus } from "../domain/types.js";

const RUNNING_WORKFLOW_QUERY_TIMEOUT_MS = 2_000;
const WAIT_STOPPED_POLL_INTERVAL_MS = 2_000;
const STOPPED_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  "waiting_user",
  "blocked",
  "failed",
  "succeeded",
  "cancelled"
]);

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

export interface WorkflowSignalResult {
  workflowId: string;
  runId?: string;
  signaled: true;
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

export interface WaitForTychonicWorkflowStoppedOptions extends TemporalConfig {
  workflowId: string;
  runId?: string;
  pollIntervalMs?: number;
}

export interface TychonicWorkflowStoppedResult {
  event: "stopped";
  reason: "pending_interaction" | "run_status" | "workflow_closed";
  workflowId: string;
  runId: string;
  status?: WorkflowRunStatus;
  pendingState?: string;
  workflow: TychonicTemporalWorkflowStatus;
  result?: unknown;
  resultError?: string;
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

export async function waitForTychonicWorkflowStopped(
  options: WaitForTychonicWorkflowStoppedOptions
): Promise<TychonicWorkflowStoppedResult> {
  const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? WAIT_STOPPED_POLL_INTERVAL_MS);
  for (;;) {
    const current = await describeTychonicTemporalWorkflow({
      workflowId: options.workflowId,
      ...(options.runId ? { runId: options.runId } : {}),
      ...normalizeTemporalConfig(options)
    });
    const pendingInteraction =
      current.status === "RUNNING"
        ? await queryInteractionPendingState({
            workflowId: options.workflowId,
            ...(options.runId ? { runId: options.runId } : {}),
            ...normalizeTemporalConfig(options)
          })
        : {};
    if (pendingInteraction.pendingState) {
      return {
        event: "stopped",
        reason: "pending_interaction",
        workflowId: current.workflowId,
        runId: current.runId,
        pendingState: pendingInteraction.pendingState,
        workflow: current
      };
    }
    const workflow = await describeTychonicTemporalWorkflow({
      workflowId: options.workflowId,
      ...(options.runId ? { runId: options.runId } : {}),
      includeResult: true,
      ...normalizeTemporalConfig(options)
    });
    const status = readTychonicRunStatus(workflow.result);
    if (status && STOPPED_RUN_STATUSES.has(status)) {
      return {
        event: "stopped",
        reason: "run_status",
        workflowId: workflow.workflowId,
        runId: workflow.runId,
        status,
        workflow,
        ...(workflow.result !== undefined ? { result: workflow.result } : {}),
        ...(workflow.resultError ? { resultError: workflow.resultError } : {})
      };
    }
    if (workflow.status !== "RUNNING") {
      return {
        event: "stopped",
        reason: "workflow_closed",
        workflowId: workflow.workflowId,
        runId: workflow.runId,
        ...(status ? { status } : {}),
        workflow,
        ...(workflow.result !== undefined ? { result: workflow.result } : {}),
        ...(workflow.resultError ? { resultError: workflow.resultError } : {})
      };
    }
    await sleep(pollIntervalMs);
  }
}

export interface SignalNamedWorkflowOptions extends TemporalConfig {
  workflowId: string;
  runId?: string;
  signalName: string;
  payload?: unknown;
}

/**
 * Workflow-agnostic Temporal signal dispatch. Used by the generic
 * `tychonic signal` CLI verb and by any host caller that needs to send
 * an arbitrary signal name to a running workflow without participating
 * in a workflow-specific payload schema.
 *
 * Validation here is intentionally minimal: the host has no opinion on
 * the signal name (each bundle owns its own) and no opinion on payload
 * shape. Unknown signal names surface as Temporal-side errors verbatim;
 * payload shape mismatches surface from the workflow's signal handler.
 * The only host-level rule is that `workflowId` and `signalName` are
 * non-empty strings.
 */
export async function signalNamedWorkflow(
  options: SignalNamedWorkflowOptions
): Promise<WorkflowSignalResult> {
  if (typeof options.workflowId !== "string" || options.workflowId.length === 0) {
    throw new Error("signalNamedWorkflow workflowId must be a non-empty string");
  }
  if (typeof options.signalName !== "string" || options.signalName.length === 0) {
    throw new Error("signalNamedWorkflow signalName must be a non-empty string");
  }
  const config = normalizeTemporalConfig(options);
  const connection = await Connection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const handle = client.workflow.getHandle(options.workflowId, options.runId);
  if (options.payload === undefined) {
    await handle.signal(options.signalName);
  } else {
    await handle.signal(options.signalName, options.payload);
  }
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
): Promise<WorkflowSignalResult> {
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
): Promise<WorkflowSignalResult> {
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
): Promise<WorkflowSignalResult> {
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
 * SPEC §Interaction Signal Contract requires `modifyState` payloads to carry
 * a `StateRecordPatch` whose optional `status` is terminal. The workflow-side
 * patch application re-validates the same contract (defense in depth against
 * non-CLI callers), but client callers get a cleaner error here before the
 * signal is sent.
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

function readTychonicRunStatus(result: unknown): WorkflowRunStatus | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const status = (result as { status?: unknown }).status;
  return typeof status === "string" && isWorkflowRunStatus(status) ? status : undefined;
}

function isWorkflowRunStatus(status: string): status is WorkflowRunStatus {
  return (
    status === "created" ||
    status === "running" ||
    status === "waiting_user" ||
    status === "blocked" ||
    status === "failed" ||
    status === "succeeded" ||
    status === "cancelled"
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
