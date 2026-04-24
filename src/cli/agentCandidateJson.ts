import type { AgentCandidateInput } from "../temporal/types.js";

export function parseAgentCandidatesJSON(raw: string, optionName: string): AgentCandidateInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${optionName} must be a JSON array: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${optionName} must be a JSON array`);
  }

  return parsed.map((item, index) => parseAgentCandidate(item, `${optionName}[${index}]`));
}

function parseAgentCandidate(value: unknown, label: string): AgentCandidateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(["agent", "command", "resumeCommand", "resume_command"]);
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) {
      throw new Error(`${label}.${key} is not supported`);
    }
  }

  const agent = requiredString(candidate.agent, `${label}.agent`);
  const command = optionalString(candidate.command, `${label}.command`);
  const camelResume = optionalString(candidate.resumeCommand, `${label}.resumeCommand`);
  const snakeResume = optionalString(candidate.resume_command, `${label}.resume_command`);
  if (camelResume && snakeResume) {
    throw new Error(`${label} accepts resumeCommand or resume_command, not both`);
  }
  const resumeCommand = camelResume ?? snakeResume;

  return {
    agent,
    ...(command ? { command } : {}),
    ...(resumeCommand ? { resumeCommand } : {})
  };
}

function requiredString(value: unknown, label: string): string {
  const parsed = optionalString(value, label);
  if (!parsed) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return parsed;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}
