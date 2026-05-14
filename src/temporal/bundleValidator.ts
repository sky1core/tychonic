/**
 * Pure validators for bundle install-time checks. These functions have no
 * filesystem dependency: callers hand in the directory entries they already
 * read. Each validator throws a descriptive `Error` on failure and returns
 * `void` on success.
 */

/**
 * Asserts a source bundle directory contains exactly one authoring entrypoint:
 * declarative `workflow.yaml`. `workflow.mjs` is an install-generated runtime
 * artifact, not an operator-authored source file.
 */
export function validateBundleFileShape(entries: readonly string[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) {
      throw new Error(`bundle entry '${entry}' appears more than once`);
    }
    seen.add(entry);
  }
  const hasWorkflowModule = seen.has("workflow.mjs");
  const hasWorkflowSpec = seen.has("workflow.yaml");
  if (hasWorkflowModule) {
    throw new Error(
      "source bundle must not contain hand-written 'workflow.mjs'; author workflow.yaml and let install generate workflow.mjs"
    );
  }
  if (!hasWorkflowSpec) {
    throw new Error("source bundle is missing required file 'workflow.yaml'");
  }
}
