export function validateRunInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("workflow input must be an object");
  }
  const allowedFields = new Set(["cwd", "profile"]);
  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) {
      throw new Error(`unsupported input field: ${field}`);
    }
  }
  if (typeof input.cwd !== "string" || input.cwd.trim() === "") {
    throw new Error("input.cwd is required");
  }
  if (input.profile !== undefined && (!input.profile || typeof input.profile !== "object" || Array.isArray(input.profile))) {
    throw new Error("profile must be an object");
  }
}
