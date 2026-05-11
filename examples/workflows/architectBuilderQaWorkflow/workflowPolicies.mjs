/**
 * Validate this workflow's `policies.loop` block as consumed by this
 * workflow. Only `max_review_iterations` is read; other knobs are
 * rejected so a typo never silently regresses the auto-mode loop cap.
 */
export function validateLoopPolicy(policies) {
  if (!policies || policies.loop === undefined) return;
  const block = policies.loop;
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new Error("policies.loop must be an object");
  }
  const allowedKeys = new Set(["max_review_iterations"]);
  for (const key of Object.keys(block)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `policies.loop.${key} is not a recognised key for architectBuilderQaWorkflow`
      );
    }
  }
  if (block.max_review_iterations !== undefined) {
    if (
      !Number.isInteger(block.max_review_iterations) ||
      block.max_review_iterations <= 0
    ) {
      throw new Error(
        "policies.loop.max_review_iterations must be a positive integer"
      );
    }
  }
}
