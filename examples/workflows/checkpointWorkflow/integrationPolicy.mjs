/**
 * Validate the bundle-owned `policies.integration` block. The host
 * config schema treats `policies` as opaque; this workflow validates
 * the keys it actually consumes.
 */
export function validateIntegrationPolicy(policies) {
  if (!policies || policies.integration === undefined) return;
  const block = policies.integration;
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new Error("policies.integration must be an object");
  }
  const allowedKeys = new Set(["position"]);
  for (const key of Object.keys(block)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `policies.integration.${key} is not a recognised key for checkpointWorkflow`
      );
    }
  }
  const allowedPositions = new Set([
    "before_ai_review",
    "after_ai_review",
    "final_gate"
  ]);
  if (block.position === undefined) {
    throw new Error(
      "policies.integration.position is required when the block is present"
    );
  }
  if (!allowedPositions.has(block.position)) {
    throw new Error(
      `policies.integration.position must be one of ${[...allowedPositions].join(", ")}; got ${JSON.stringify(block.position)}`
    );
  }
}
