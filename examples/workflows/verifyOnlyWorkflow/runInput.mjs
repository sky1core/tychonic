export function validateRunInput(input) {
  if (!isPlainObject(input)) throw new Error("workflow input must be an object");
  const allowedFields = new Set(["cwd", "profile"]);
  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) throw new Error(`unsupported input field: ${field}`);
  }
  if (typeof input.cwd !== "string" || input.cwd.trim() === "") throw new Error("cwd must be a non-empty string");
  if (input.profile !== undefined && !isPlainObject(input.profile)) throw new Error("profile must be an object");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
