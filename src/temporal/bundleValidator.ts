/**
 * Pure validators for bundle install-time checks. These functions have no
 * filesystem dependency: callers hand in the directory entries they already
 * read. Each validator throws a descriptive `Error` on failure and returns
 * `void` on success.
 */

const REQUIRED_BUNDLE_ENTRIES = ["workflow.mjs"] as const;
/**
 * Asserts a bundle directory contains the workflow entrypoint. Other entries
 * are allowed because a workflow bundle may be a normal package directory:
 * `package.json`, lockfiles, `node_modules`, helper modules, and pre-bundled
 * assets all resolve through standard package mechanisms.
 */
export function validateBundleFileShape(entries: readonly string[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) {
      throw new Error(`bundle entry '${entry}' appears more than once`);
    }
    seen.add(entry);
  }
  for (const required of REQUIRED_BUNDLE_ENTRIES) {
    if (!seen.has(required)) {
      throw new Error(`bundle is missing required file '${required}'`);
    }
  }
}
