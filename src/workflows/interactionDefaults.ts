/**
 * Workflow-runtime value constants for interaction policy.
 *
 * These live in a separate module from `src/catalog/types.ts` so the
 * workflow bundle (which runs inside Temporal's sandbox) can import
 * them without pulling in `zod`, `hasInlineSecrets`, and the rest of
 * the catalog-layer dependency graph. Plugin and built-in workflow
 * modules receive them identically.
 *
 * The catalog module re-exports the same value so schema callers see
 * a single source of truth.
 */
export const INTERACTION_DEFAULT_MAX_REJECT_ITERATIONS = 5;
