export type StoppedWorkflowMessageInput = {
  workflowId: string;
  runId?: string;
  reason: "pending_interaction" | "run_status" | "workflow_closed";
  pendingState?: string;
  status?: string;
  resultError?: string;
};

export type StoppedWorkflowCliPayload = {
  workflowId: string;
  runId: string;
  message: string;
  state?: string;
  status?: string;
  resultError?: string;
};

export function stoppedWorkflowCliPayload(
  result: StoppedWorkflowMessageInput & { runId: string }
): StoppedWorkflowCliPayload {
  return {
    workflowId: result.workflowId,
    runId: result.runId,
    message: stoppedWorkflowMessage(result),
    ...(result.pendingState ? { state: result.pendingState } : {}),
    ...(result.status ? { status: result.status } : {}),
    ...(result.resultError ? { resultError: result.resultError } : {})
  };
}

export function stoppedWorkflowMessage(result: StoppedWorkflowMessageInput): string {
  if (result.reason === "pending_interaction") {
    const state = result.pendingState ?? "<state>";
    return [
      `Workflow is waiting for input at state '${state}'.`,
      `Inspect evidence with \`${statusCommand(result.workflowId)}\`; it lists inbox, artifacts, logs, and sessions.`,
      `Then run \`${interactionCommand("approve", result.workflowId, state)}\`,`,
      `\`${interactionCommand("reject", result.workflowId, state)} --feedback "<feedback>"\`,`,
      `or \`${interactionCommand("modify", result.workflowId, state)} --note "<note>"\`.`
    ].join(" ");
  }
  if (result.reason === "workflow_closed") {
    const detail = result.resultError
      ? `Workflow closed without a usable Tychonic result: ${result.resultError}.`
      : "Workflow closed without a usable Tychonic result.";
    return `${detail} Inspect details with \`${statusCommand(result.workflowId)}\`.`;
  }
  if (result.status === "waiting_user" || result.status === "blocked") {
    return [
      `Workflow needs attention with status '${result.status}'.`,
      `Inspect evidence with \`${statusCommand(result.workflowId)}\` before deciding whether to start a fresh run or use the workflow's documented recovery path.`
    ].join(" ");
  }
  if (result.status) {
    const prefix = `Workflow finished with status '${result.status}'.`;
    if (result.status === "succeeded") {
      return `${prefix} Read the result with \`${statusCommand(result.workflowId)}\`.`;
    }
    return `${prefix} Inspect evidence with \`${statusCommand(result.workflowId)}\` before reporting the outcome.`;
  }
  return `Workflow is not ready to continue, but no Tychonic status was available. Inspect details with \`${statusCommand(result.workflowId)}\`.`;
}

function statusCommand(workflowId: string): string {
  return `tychonic status --workflow-id ${shellArg(workflowId)}`;
}

function interactionCommand(command: "approve" | "reject" | "modify", workflowId: string, state: string): string {
  return `tychonic ${command} ${shellArg(workflowId)} --state ${shellArg(state)}`;
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
