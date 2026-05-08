export function reportedModelMismatchMessage(input: {
  agentName: string;
  requestedModel: string | undefined;
  reportedModel: string | undefined;
}): string | undefined {
  if (input.requestedModel === undefined || input.reportedModel === undefined) {
    return undefined;
  }
  if (!requiresExactReportedModel(input.agentName, input.requestedModel)) {
    return undefined;
  }
  if (input.requestedModel === input.reportedModel) {
    return undefined;
  }
  return [
    `agent ${input.agentName} reported model '${input.reportedModel}'`,
    `but state config requested model '${input.requestedModel}'`
  ].join(" ");
}

function requiresExactReportedModel(agentName: string, requestedModel: string): boolean {
  if (agentName === "claude") {
    return requestedModel.startsWith("claude-");
  }
  return true;
}
