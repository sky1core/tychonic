/**
 * Instance name resolution and derivation (pure functions).
 *
 * Tychonic's operational runtime has no named instance ("instance" is
 * undefined). Isolated dev instances are activated by `--instance <name>`
 * on any CLI command, or by `TYCHONIC_INSTANCE=<name>` in the shell
 * environment. When an instance is active, this module derives the
 * isolation vectors (state dir, log dir, Temporal API address/port,
 * task queue, web port) from `<name>`.
 *
 * Only these primitives live here:
 * - `validateInstanceName` — regex + reserved-word validation.
 * - `deriveInstancePort` — deterministic fnv1a32-based port derivation.
 * - `setActiveInstance` / `getActiveInstance` — module-scoped accessor
 *   for the process-local active instance. (Process-local, Temporal-free
 *   per SPEC §Source Of Truth.)
 * - `resolveInstanceRuntime` — pure function that applies the field-level
 *   explicit-override precedence (explicit > derived > default) to produce
 *   a `ResolvedInstanceRuntime`.
 *
 * Precedence (§9 field-level explicit override) is fixed in
 * `resolveInstanceRuntime` and locked by tests. Do not add a second
 * precedence path elsewhere.
 */

const INSTANCE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_INSTANCE_NAMES: ReadonlySet<string> = new Set([
  "default",
  "prod",
  "production",
  "service"
]);

const DEFAULT_TEMPORAL_API_PORT = 7233;
const DEFAULT_TEMPORAL_NAMESPACE = "default";
const DEFAULT_TEMPORAL_TASK_QUEUE = "tychonic";
const DEFAULT_WEB_PORT = 8765;

const INSTANCE_API_PORT_BASE = 17000;
const INSTANCE_WEB_PORT_BASE = 18000;
const INSTANCE_PORT_SLOTS = 1000;

/**
 * Validate an instance name. Throws with a message that distinguishes
 * regex mismatch from reserved-word rejection.
 *
 * The allowed pattern (`^[a-z][a-z0-9-]{0,31}$`) is the intersection of
 * what is safe inside filesystem paths, launchd labels, and Temporal
 * task-queue identifiers. The reserved list blocks names that would be
 * mistaken for the operational path.
 */
export function validateInstanceName(name: string): void {
  if (RESERVED_INSTANCE_NAMES.has(name)) {
    throw new Error(
      `instance name "${name}" is reserved (reserved names: ${Array.from(
        RESERVED_INSTANCE_NAMES
      )
        .sort()
        .join(", ")})`
    );
  }
  if (!INSTANCE_NAME_PATTERN.test(name)) {
    throw new Error(
      `instance name "${name}" does not match ${INSTANCE_NAME_PATTERN.source}`
    );
  }
}

/**
 * 32-bit FNV-1a hash. Deterministic, no dependencies.
 * Returns an unsigned 32-bit integer.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Multiply by FNV prime (0x01000193) mod 2^32.
    // `Math.imul` keeps the operation in 32-bit space; we restore the
    // unsigned view at the end with `>>> 0`.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Derive the Temporal API port for `name`. Deterministic.
 * Range: [17000, 17999].
 */
export function deriveInstancePort(name: string): number {
  validateInstanceName(name);
  return INSTANCE_API_PORT_BASE + (fnv1a32(name) % INSTANCE_PORT_SLOTS);
}

/**
 * Derive the web port for `name`. Deterministic.
 * Range: [18000, 18999].
 */
export function deriveInstanceWebPort(name: string): number {
  validateInstanceName(name);
  return INSTANCE_WEB_PORT_BASE + (fnv1a32(name) % INSTANCE_PORT_SLOTS);
}

/**
 * Resolve the web port under field-level precedence:
 *   explicit > instance-derived > operational default (8765).
 *
 * Intended as a small helper for CLI sites that only need the web port,
 * without materializing a full `ResolvedInstanceRuntime`.
 */
export function resolveWebPort(explicitWebPort?: number): number {
  if (explicitWebPort !== undefined) return explicitWebPort;
  const instance = getActiveInstance();
  if (instance !== undefined) return deriveInstanceWebPort(instance);
  return DEFAULT_WEB_PORT;
}

// Process-local active instance. Set by the CLI preAction hook (P3);
// read by P1's resolver only through the accessor, never from module
// globals inside `resolveInstanceRuntime`.
let activeInstance: string | undefined;

/**
 * Set (or unset, when `name` is undefined) the active instance for this
 * process. Validates the name when provided.
 */
export function setActiveInstance(name: string | undefined): void {
  if (name === undefined) {
    activeInstance = undefined;
    return;
  }
  validateInstanceName(name);
  activeInstance = name;
}

/** Read the active instance for this process. */
export function getActiveInstance(): string | undefined {
  return activeInstance;
}

export interface ResolveInstanceRuntimeExplicit {
  stateHome?: string;
  logHome?: string;
  address?: string;
  apiPort?: number;
  taskQueue?: string;
  namespace?: string;
  webPort?: number;
}

export interface ResolveInstanceRuntimeOptions {
  /** Instance name. Omit for the operational (non-isolated) resolution. */
  instance?: string;
  /** Operational state dir baseline (caller-supplied). */
  defaultStateDir: string;
  /** Operational log dir baseline (caller-supplied). */
  defaultLogDir: string;
  /** Per-field explicit overrides from CLI flags / env vars. */
  explicit?: ResolveInstanceRuntimeExplicit;
}

export interface ResolvedInstanceRuntimeTemporal {
  address: string;
  namespace: string;
  taskQueue: string;
  apiPort: number;
}

export interface ResolvedInstanceRuntime {
  instance?: string;
  stateDir: string;
  logDir: string;
  temporal: ResolvedInstanceRuntimeTemporal;
  webPort: number;
  /** Operator-visible warnings for conflicting overrides. */
  warnings: string[];
}

/**
 * Join a base directory with `instances/<name>/`. The trailing slash is
 * not added — consumers use `path.join` semantics. Using a simple string
 * concat here keeps the function environment-free (no node:path import)
 * and deterministic for tests. A trailing path separator on
 * `defaultStateDir` is preserved as-is; the SPEC-described suffix is
 * `instances/<name>`, not `/instances/<name>`.
 */
function joinInstance(base: string, name: string): string {
  const sep = base.endsWith("/") ? "" : "/";
  return `${base}${sep}instances/${name}`;
}

/**
 * Resolve the instance runtime for a single CLI invocation.
 *
 * Precedence for every field is: explicit > derived (only when instance
 * is set) > operational default. No implicit merging; each field is
 * independent.
 *
 * This function is pure: it does not read `getActiveInstance()` and has
 * no filesystem side effects. The caller passes the instance name (or
 * undefined for the operational path).
 */
export function resolveInstanceRuntime(
  options: ResolveInstanceRuntimeOptions
): ResolvedInstanceRuntime {
  const { instance, defaultStateDir, defaultLogDir } = options;
  const explicit: ResolveInstanceRuntimeExplicit = options.explicit ?? {};
  const warnings: string[] = [];

  // state dir: explicit > instance-derived > default
  let stateDir: string;
  if (explicit.stateHome !== undefined) {
    stateDir = explicit.stateHome;
    if (instance !== undefined) {
      warnings.push("TYCHONIC_STATE_HOME overrides instance state dir");
    }
  } else if (instance !== undefined) {
    stateDir = joinInstance(defaultStateDir, instance);
  } else {
    stateDir = defaultStateDir;
  }

  // log dir: explicit > instance-derived > default
  let logDir: string;
  if (explicit.logHome !== undefined) {
    logDir = explicit.logHome;
    if (instance !== undefined) {
      warnings.push("TYCHONIC_LOG_HOME overrides instance log dir");
    }
  } else if (instance !== undefined) {
    logDir = joinInstance(defaultLogDir, instance);
  } else {
    logDir = defaultLogDir;
  }

  // Temporal API port: explicit > instance-derived > default
  let apiPort: number;
  if (explicit.apiPort !== undefined) {
    apiPort = explicit.apiPort;
  } else if (instance !== undefined) {
    apiPort = deriveInstancePort(instance);
  } else {
    apiPort = DEFAULT_TEMPORAL_API_PORT;
  }

  // Temporal address: explicit > derived from resolved API port > default
  let address: string;
  if (explicit.address !== undefined) {
    address = explicit.address;
  } else if (instance !== undefined || explicit.apiPort !== undefined) {
    address = `127.0.0.1:${apiPort}`;
  } else {
    address = `127.0.0.1:${DEFAULT_TEMPORAL_API_PORT}`;
  }

  // Temporal namespace: explicit > default ("default"). Instance does
  // not change the namespace — the DB file itself is already separate.
  const namespace = explicit.namespace ?? DEFAULT_TEMPORAL_NAMESPACE;

  // Task queue: explicit > `tychonic-<name>` > `tychonic`
  let taskQueue: string;
  if (explicit.taskQueue !== undefined) {
    taskQueue = explicit.taskQueue;
  } else if (instance !== undefined) {
    taskQueue = `${DEFAULT_TEMPORAL_TASK_QUEUE}-${instance}`;
  } else {
    taskQueue = DEFAULT_TEMPORAL_TASK_QUEUE;
  }

  // Web port: explicit > derived (18000 + hash mod 1000) > default
  let webPort: number;
  if (explicit.webPort !== undefined) {
    webPort = explicit.webPort;
  } else if (instance !== undefined) {
    webPort = deriveInstanceWebPort(instance);
  } else {
    webPort = DEFAULT_WEB_PORT;
  }

  const resolved: ResolvedInstanceRuntime = {
    stateDir,
    logDir,
    temporal: {
      address,
      namespace,
      taskQueue,
      apiPort
    },
    webPort,
    warnings
  };
  if (instance !== undefined) {
    resolved.instance = instance;
  }
  return resolved;
}
