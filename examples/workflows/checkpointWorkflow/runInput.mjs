import { validateIntegrationPolicy } from "./integrationPolicy.mjs";

export function validateRunInput(input) {
  validateTaskInput(input);
  validateIntegrationPolicy(input.profile?.policies);
}

function validateTaskInput(input) {
  if (!isPlainObject(input)) throw new Error("workflow input must be an object");
  const allowedFields = new Set(["cwd", "profile", "goal"]);
  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) throw new Error(`unsupported input field: ${field}`);
  }
  if (typeof input.cwd !== "string" || input.cwd.trim() === "") throw new Error("cwd must be a non-empty string");
  if (input.profile !== undefined && !isPlainObject(input.profile)) throw new Error("profile must be an object");
  if (input.goal !== undefined && (typeof input.goal !== "string" || input.goal.trim() === "")) throw new Error("goal must be a non-empty string");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
