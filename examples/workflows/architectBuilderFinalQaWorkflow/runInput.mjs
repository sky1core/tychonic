const PROMPT_ADDITION_STATES = ["architect", "builder", "qa"];

export function validateRunInput(input) {
  validateTaskInput(input, { promptAdditionStates: PROMPT_ADDITION_STATES });
}

function validateTaskInput(input, contract = {}) {
  if (!isPlainObject(input)) throw new Error("workflow input must be an object");
  const allowedFields = new Set(["cwd", "profile", "goal"]);
  if (contract.promptAdditionStates !== undefined) allowedFields.add("promptAdditions");
  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) throw new Error(`unsupported input field: ${field}`);
  }
  if (typeof input.cwd !== "string" || input.cwd.trim() === "") throw new Error("cwd must be a non-empty string");
  if (input.profile !== undefined && !isPlainObject(input.profile)) throw new Error("profile must be an object");
  if (input.goal !== undefined && (typeof input.goal !== "string" || input.goal.trim() === "")) {
    throw new Error("goal must be a non-empty string");
  }
  if (input.promptAdditions !== undefined) validatePromptAdditions(input, contract.promptAdditionStates);
}

function validatePromptAdditions(input, allowedStateNames) {
  if (!isPlainObject(input.promptAdditions)) throw new Error("promptAdditions must be an object keyed by state name");
  const allowedStates = new Set(allowedStateNames ?? []);
  const states = isPlainObject(input.profile) && isPlainObject(input.profile.states) ? input.profile.states : undefined;
  for (const stateName of Object.keys(input.promptAdditions)) {
    if (!allowedStates.has(stateName)) throw new Error(`unsupported promptAdditions state: ${stateName}`);
    const addition = input.promptAdditions[stateName];
    if (typeof addition !== "string" || addition.trim() === "") throw new Error(`promptAdditions.${stateName} must be a non-empty string`);
  }
  if (states === undefined) throw new Error("promptAdditions requires effective profile.states");
  for (const stateName of Object.keys(input.promptAdditions)) {
    if (!Object.prototype.hasOwnProperty.call(states, stateName)) throw new Error(`promptAdditions.${stateName} does not match a configured state`);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
