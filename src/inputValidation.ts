import type { TychonicConfig } from "./catalog/types.js";

export interface TychonicWorkflowRuntimeInput {
  cwd: string;
  profile?: TychonicConfig;
  goal?: string;
  promptAdditions?: Record<string, string>;
}

export interface TaskWorkflowInputContract {
  allowGoal?: boolean;
  requireCwd?: boolean;
}

const PROMPTABLE_STATE_TYPES = new Set(["work", "review"]);

export function derivePromptableStates(
  profile: Record<string, unknown> | undefined
): string[] {
  if (!isPlainObject(profile)) return [];
  const states = profile.states;
  if (!isPlainObject(states)) return [];
  const result: string[] = [];
  for (const [name, block] of Object.entries(states)) {
    if (isPlainObject(block) && PROMPTABLE_STATE_TYPES.has(block.type as string)) {
      result.push(name);
    }
  }
  return result;
}

export function validateTaskWorkflowInput(
  input: unknown,
  contract: TaskWorkflowInputContract = {}
): asserts input is TychonicWorkflowRuntimeInput {
  if (!isPlainObject(input)) {
    throw new Error("workflow input must be an object");
  }

  const allowGoal = contract.allowGoal ?? true;
  const requireCwd = contract.requireCwd ?? true;
  const allowedFields = new Set(["cwd", "profile", "promptAdditions"]);
  if (allowGoal) {
    allowedFields.add("goal");
  }

  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) {
      throw new Error(`unsupported input field: ${field}`);
    }
  }

  if (requireCwd && (typeof input.cwd !== "string" || input.cwd.trim() === "")) {
    throw new Error("cwd must be a non-empty string");
  }
  if (input.cwd !== undefined && typeof input.cwd !== "string") {
    throw new Error("cwd must be a non-empty string");
  }
  if (input.profile !== undefined && !isPlainObject(input.profile)) {
    throw new Error("profile must be an object");
  }
  if (input.goal !== undefined) {
    if (!allowGoal) {
      throw new Error("unsupported input field: goal");
    }
    if (typeof input.goal !== "string" || input.goal.trim() === "") {
      throw new Error("goal must be a non-empty string");
    }
  }
  if (input.promptAdditions !== undefined) {
    validatePromptAdditions(input);
  }
}

function validatePromptAdditions(input: Record<string, unknown>): void {
  const additions = input.promptAdditions;
  if (!isPlainObject(additions)) {
    throw new Error("promptAdditions must be an object keyed by state name");
  }

  const profile = input.profile;
  const states = isPlainObject(profile) && isPlainObject(profile.states)
    ? profile.states
    : undefined;

  if (states === undefined) {
    throw new Error("promptAdditions requires effective profile.states");
  }

  const promptableStates = new Set(derivePromptableStates(profile as Record<string, unknown>));

  for (const stateName of Object.keys(additions)) {
    if (!promptableStates.has(stateName)) {
      throw new Error(`unsupported promptAdditions state: ${stateName}`);
    }
    const addition = additions[stateName];
    if (typeof addition !== "string" || addition.trim() === "") {
      throw new Error(`promptAdditions.${stateName} must be a non-empty string`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
