import type { TychonicConfig } from "../catalog/types.js";

export function applyWorkflowCommandTimeout(
  profile: TychonicConfig,
  commandTimeoutMs: number | undefined,
  stateNames: string[]
): TychonicConfig {
  if (commandTimeoutMs === undefined) {
    return profile;
  }

  const nextStates = { ...(profile.states ?? {}) };
  for (const stateName of stateNames) {
    const block = nextStates[stateName];
    if (!block) {
      continue;
    }
    nextStates[stateName] = { ...block, timeout: commandTimeoutMs };
  }

  return { ...profile, states: nextStates };
}
