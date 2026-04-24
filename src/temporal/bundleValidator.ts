import {
  ActivityTypeSchema,
  type ActivityType,
  type TychonicConfig
} from "../catalog/types.js";

/**
 * Pure validators for bundle install-time checks. These functions have no
 * filesystem dependency: callers hand in the directory entries they already
 * read and the parsed `requires`/`config` values. Each validator throws a
 * descriptive `Error` on failure and returns `void` on success.
 */

const REQUIRED_BUNDLE_ENTRIES = ["workflow.mjs", "config.yaml"] as const;
const OPTIONAL_BUNDLE_ENTRIES = new Set(["README.md"]);
const ALLOWED_BUNDLE_ENTRIES = new Set<string>([
  ...REQUIRED_BUNDLE_ENTRIES,
  ...OPTIONAL_BUNDLE_ENTRIES
]);

/**
 * Asserts a bundle directory contains exactly `workflow.mjs` + `config.yaml`
 * and optionally `README.md`, and nothing else. `entries` is the exact list
 * of immediate entry names under the bundle directory (e.g. the result of
 * `readdir(bundleDir)` — not a recursive listing).
 */
export function validateBundleFileShape(entries: readonly string[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) {
      throw new Error(`bundle entry '${entry}' appears more than once`);
    }
    seen.add(entry);
    if (!ALLOWED_BUNDLE_ENTRIES.has(entry)) {
      throw new Error(
        `bundle contains unexpected entry '${entry}'. Allowed entries are workflow.mjs, config.yaml, and optional README.md.`
      );
    }
  }
  for (const required of REQUIRED_BUNDLE_ENTRIES) {
    if (!seen.has(required)) {
      throw new Error(`bundle is missing required file '${required}'`);
    }
  }
}

export type BundleRequiresEntry = {
  name: string;
  type: ActivityType;
};

export type BundleRequires = {
  states: readonly BundleRequiresEntry[];
};

/**
 * Parses and normalizes a `requires` export. Throws a descriptive error when
 * the shape does not match the contract in SPEC §Workflow Modules/Required
 * state declaration. Returns a strongly typed object on success.
 */
export function normalizeBundleRequires(value: unknown): BundleRequires {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("bundle's requires export must be an object");
  }
  const record = value as Record<string, unknown>;
  const states = record.states;
  if (!Array.isArray(states)) {
    throw new Error("bundle's requires.states must be an array");
  }
  if (states.length === 0) {
    throw new Error("bundle's requires.states must be non-empty");
  }
  const normalized: BundleRequiresEntry[] = [];
  const seen = new Set<string>();
  for (const entry of states) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("bundle's requires.states entries must be objects");
    }
    const name = (entry as Record<string, unknown>).name;
    const type = (entry as Record<string, unknown>).type;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("bundle's requires.states entry is missing a string name");
    }
    if (typeof type !== "string") {
      throw new Error(`bundle's requires.states entry '${name}' is missing a string type`);
    }
    const parsedType = ActivityTypeSchema.safeParse(type);
    if (!parsedType.success) {
      throw new Error(
        `bundle's requires.states entry '${name}' has invalid type '${type}'. Must be one of ${ActivityTypeSchema.options.join(", ")}.`
      );
    }
    if (seen.has(name)) {
      throw new Error(`bundle's requires.states entry name '${name}' appears more than once`);
    }
    seen.add(name);
    normalized.push({ name, type: parsedType.data });
  }
  return { states: normalized };
}

/**
 * Cross-checks a bundle's `requires.states` declaration against its parsed
 * `config.yaml` (a `TychonicConfig`). Each requires entry must have a
 * matching `states[name]` block whose `type` equals the declared type, and
 * the config must not contain any state block that the requires declaration
 * does not mention.
 */
export function validateBundleRequires(args: {
  requires: BundleRequires;
  config: TychonicConfig;
}): void {
  const { requires, config } = args;
  const configStates = config.states ?? {};
  const declaredByName = new Map<string, BundleRequiresEntry>();
  for (const entry of requires.states) {
    declaredByName.set(entry.name, entry);
  }
  for (const entry of requires.states) {
    const block = configStates[entry.name];
    if (!block) {
      throw new Error(
        `bundle requires state '${entry.name}' of type '${entry.type}' but config.yaml has no matching states.${entry.name} block`
      );
    }
    if (block.type !== entry.type) {
      throw new Error(
        `bundle requires state '${entry.name}' of type '${entry.type}' but config.yaml declares states.${entry.name} with type '${block.type}'`
      );
    }
  }
  for (const name of Object.keys(configStates)) {
    if (!declaredByName.has(name)) {
      throw new Error(
        `config.yaml declares states.${name} but the workflow's requires export does not reference it`
      );
    }
  }
}
