import type { WorkflowRunRecord } from "./types.js";

export interface DismissDecisionInboxItemInput {
  run: WorkflowRunRecord;
  inboxItemId: string;
  reason?: string;
  dismissedAt: string;
}

export function dismissDecisionInboxItem(input: DismissDecisionInboxItemInput): WorkflowRunRecord {
  const run = structuredClone(input.run);
  const item = run.inbox.find((candidate) => candidate.id === input.inboxItemId);
  if (!item) {
    throw new Error(`inbox item not found: ${input.inboxItemId}`);
  }
  if (item.status !== "open") {
    throw new Error(`inbox item is not open: ${input.inboxItemId}`);
  }

  item.status = "dismissed";
  const reason = input.reason?.trim();
  if (reason) {
    item.detail = appendDismissReason(item.detail, reason, input.dismissedAt);
  }

  if (item.finding_id) {
    const finding = run.findings.find((candidate) => candidate.id === item.finding_id);
    if (finding && finding.status !== "fixed") {
      finding.status = "rejected";
    }
  }

  recomputeWorkflowRunStatus(run);
  run.updated_at = input.dismissedAt;
  return run;
}

export function recomputeWorkflowRunStatus(run: WorkflowRunRecord): void {
  const latestStates = new Map<string, WorkflowRunRecord["states"][number]>();
  for (const state of run.states) {
    latestStates.set(state.name, state);
  }

  if (run.inbox.some((item) => item.status === "open")) {
    run.status = "waiting_user";
  } else if ([...latestStates.values()].some((state) => state.status === "failed" || state.status === "timed_out")) {
    run.status = "failed";
  } else if ([...latestStates.values()].some((state) => state.status === "blocked")) {
    run.status = "blocked";
  } else {
    run.status = "succeeded";
  }
}

function appendDismissReason(detail: string, reason: string, dismissedAt: string): string {
  const suffix = `Dismissed at ${dismissedAt}: ${reason}`;
  return detail ? `${detail}\n\n${suffix}` : suffix;
}
