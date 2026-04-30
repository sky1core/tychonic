import { defineQuery, setHandler } from "@temporalio/workflow";
import type { WorkflowRunRecord, WorkflowRunStatus } from "./domain/types.js";
import { tychonicWorkflowStateQueryName } from "./temporal/types.js";
import {
  applyApprovalDecision,
  drainStraySignals,
  effectiveInteractionMode,
  registerInteractionSignals,
  rejectCapInboxItem,
  resolveRejectCap,
  setInteractionPolicy,
  strayInteractionSignalInboxItem,
  waitForStateApproval,
  type ApprovalDecision,
  type PolicyInteraction,
  type StraySignal
} from "./workflows/interactionHook.js";

export interface TychonicWorkflowResult {
  runId: string;
  status: WorkflowRunStatus;
  run: WorkflowRunRecord;
  artifactRoot: string;
  summary?: string;
  worktreePath?: string;
}

export interface TychonicRunStateSnapshotFields {
  artifactRoot?: string;
  summary?: string;
  worktreePath?: string;
}

export interface TychonicRunState {
  update(run: WorkflowRunRecord, fields?: TychonicRunStateSnapshotFields): WorkflowRunRecord;
  result(run: WorkflowRunRecord, fields?: TychonicRunStateSnapshotFields): TychonicWorkflowResult;
  current(): TychonicWorkflowResult | undefined;
}

export interface TychonicInteraction {
  mode(): "auto" | "interactive";
  rejectCap(): number;
  waitForStateApproval(stateName: string): Promise<ApprovalDecision>;
  applyApprovalDecision(
    run: WorkflowRunRecord,
    stateName: string,
    decision: ApprovalDecision
  ): WorkflowRunRecord;
  drainStraySignals(): StraySignal[];
  rejectCapInboxItem: typeof rejectCapInboxItem;
  strayInteractionSignalInboxItem: typeof strayInteractionSignalInboxItem;
}

export function createTychonicRunState(): TychonicRunState {
  let latest: TychonicWorkflowResult | undefined;
  const query = defineQuery<TychonicWorkflowResult | undefined>(tychonicWorkflowStateQueryName);
  setHandler(query, () => latest);

  return {
    update(run, fields) {
      latest = toWorkflowResult(run, fields);
      return run;
    },
    result(run, fields) {
      latest = toWorkflowResult(run, fields);
      return latest;
    },
    current() {
      return latest;
    }
  };
}

export function createTychonicInteraction(policy?: PolicyInteraction): TychonicInteraction {
  registerInteractionSignals();
  setInteractionPolicy(policy);
  return {
    mode: effectiveInteractionMode,
    rejectCap: resolveRejectCap,
    waitForStateApproval,
    applyApprovalDecision,
    drainStraySignals,
    rejectCapInboxItem,
    strayInteractionSignalInboxItem
  };
}

function toWorkflowResult(
  run: WorkflowRunRecord,
  fields: TychonicRunStateSnapshotFields = {}
): TychonicWorkflowResult {
  return {
    runId: run.id,
    status: run.status,
    run,
    artifactRoot: fields.artifactRoot ?? `${run.cwd}/.tychonic/runs/${run.id}`,
    ...(run.summary !== undefined ? { summary: run.summary } : {}),
    ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
    ...(fields.worktreePath !== undefined ? { worktreePath: fields.worktreePath } : {})
  };
}
