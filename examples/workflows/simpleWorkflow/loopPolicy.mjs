/**
 * Validate this workflow's `policies.loop` block. The host config
 * schema treats `policies` as opaque; this workflow validates the keys
 * it actually consumes.
 */
export function validateLoopPolicy(policies) {
  if (!policies || policies.loop === undefined) return;
  const loop = policies.loop;
  if (typeof loop !== "object" || loop === null || Array.isArray(loop)) {
    throw new Error("policies.loop must be an object");
  }
  const allowed = new Set(["auto_continue", "max_review_iterations"]);
  for (const key of Object.keys(loop)) {
    if (!allowed.has(key)) {
      throw new Error(`policies.loop.${key} is not a recognised key for simpleWorkflow`);
    }
  }
  if (loop.auto_continue !== undefined && typeof loop.auto_continue !== "boolean") {
    throw new Error("policies.loop.auto_continue must be a boolean");
  }
  if (loop.max_review_iterations !== undefined) {
    if (!Number.isInteger(loop.max_review_iterations) || loop.max_review_iterations <= 0) {
      throw new Error("policies.loop.max_review_iterations must be a positive integer");
    }
    if (!loop.auto_continue) {
      throw new Error("policies.loop.max_review_iterations requires policies.loop.auto_continue");
    }
  }
}
