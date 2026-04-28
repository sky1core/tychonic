/**
 * Validate the bundle-owned `policies.interaction` block. The host
 * config schema treats `policies` as opaque; this workflow validates
 * the keys it actually consumes.
 */
export function validateInteractionPolicy(policies) {
  if (!policies || policies.interaction === undefined) return;
  const block = policies.interaction;
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new Error("policies.interaction must be an object");
  }
  const allowedKeys = new Set(["mode", "max_reject_iterations"]);
  for (const key of Object.keys(block)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `policies.interaction.${key} is not a recognised key for architectBuilderQaWorkflow`
      );
    }
  }
  if (block.mode === undefined) {
    throw new Error("policies.interaction.mode is required when the block is present");
  }
  if (block.mode !== "auto" && block.mode !== "interactive") {
    throw new Error(
      `policies.interaction.mode must be 'auto' or 'interactive'; got ${JSON.stringify(block.mode)}`
    );
  }
  if (block.max_reject_iterations !== undefined) {
    if (
      !Number.isInteger(block.max_reject_iterations) ||
      block.max_reject_iterations <= 0
    ) {
      throw new Error(
        "policies.interaction.max_reject_iterations must be a positive integer"
      );
    }
    if (block.mode === "auto") {
      throw new Error(
        "policies.interaction.max_reject_iterations is only allowed when mode is 'interactive'"
      );
    }
  }
}

/**
 * Validate the bundle-owned `policies.loop` block as consumed by this
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
