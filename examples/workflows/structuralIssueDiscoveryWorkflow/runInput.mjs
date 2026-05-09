const PROMPTABLE_STATES = new Set([
  "workflow_review",
  "adapter_review",
  "docs_review",
  "finding_audit"
]);

export function validateRunInput(input) {
  if (!isPlainObject(input)) throw new Error("workflow input must be an object");
  const allowedFields = new Set(["cwd", "profile", "goal", "promptAdditions"]);
  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) throw new Error(`unsupported input field: ${field}`);
  }
  if (typeof input.cwd !== "string" || input.cwd.trim() === "") {
    throw new Error("cwd must be a non-empty string");
  }
  if (input.profile !== undefined && !isPlainObject(input.profile)) {
    throw new Error("profile must be an object");
  }
  if (input.goal !== undefined && (typeof input.goal !== "string" || input.goal.trim() === "")) {
    throw new Error("goal must be a non-empty string");
  }
  if (input.promptAdditions !== undefined) {
    validatePromptAdditions(input.promptAdditions);
  }
}

function validatePromptAdditions(promptAdditions) {
  if (!isPlainObject(promptAdditions)) {
    throw new Error("promptAdditions must be an object keyed by promptable state name");
  }
  for (const [stateName, addition] of Object.entries(promptAdditions)) {
    if (!PROMPTABLE_STATES.has(stateName)) {
      throw new Error(`unsupported promptAdditions key: ${stateName}`);
    }
    if (typeof addition !== "string" || addition.trim() === "") {
      throw new Error(`promptAdditions.${stateName} must be a non-empty string`);
    }
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
