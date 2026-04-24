/**
 * `runtime reset --instance <name>` core logic.
 *
 * Terminates any detached runtime process recorded in `pidFile` (SIGTERM →
 * 10s wait → SIGKILL), then removes the instance's state and log
 * directories. Pure-ish: takes explicit path inputs and a deps object so
 * tests can inject fake signal/sleep/fs behavior.
 *
 * Safety invariant: every path the caller passes MUST contain the
 * `instances/<name>` suffix. This module asserts the suffix before any
 * `rm -rf`. Operational paths never include that suffix, so a caller bug
 * that threads an operational path in here will throw instead of wiping
 * the operational state dir.
 */

import { rm } from "node:fs/promises";
import { readPidFile, isProcessAlive } from "./detached.js";

export interface KillAndRemoveInstanceOptions {
  instance: string;
  pidFile: string;
  stateDir: string;
  logDir: string;
  /**
   * Maximum total wait time (ms) after SIGTERM before falling back to
   * SIGKILL. Default 10_000ms per design.
   */
  waitForExitMs?: number;
  /** Poll interval (ms) while waiting for SIGTERM to take effect. */
  pollIntervalMs?: number;
  deps?: KillAndRemoveDeps;
}

export interface KillAndRemoveDeps {
  /** Send `signal` to `pid`. Default: `process.kill`. */
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  /** Test whether `pid` is alive. Default: `process.kill(pid, 0)`. */
  processAlive?: (pid: number) => boolean;
  /** Sleep for `ms`. Default: `setTimeout`-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Read pid from a file. Default: reads `pidFile`. */
  readPid?: (pidFile: string) => Promise<number>;
  /** Remove a directory recursively. Default: `fs.rm`. */
  removeDir?: (path: string) => Promise<void>;
}

export interface KillAndRemoveInstanceResult {
  instance: string;
  killedPid: number | null;
  killedSignal: "SIGTERM" | "SIGKILL" | null;
  removed: {
    stateDir: string;
    logDir: string;
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSignal(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

async function defaultRemoveDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * Assert that `path` is under an `instances/<name>` tree. Rejects empty
 * strings, paths without the `instances/` segment, and paths whose
 * `instances/` segment is followed by a different name. This is the
 * last-line defense against wiping operational paths.
 */
function assertInstancePath(path: string, instance: string, label: string): void {
  if (!path || typeof path !== "string") {
    throw new Error(`${label} must be a non-empty string`);
  }
  // Path must contain an `instances/<instance>` segment whose boundary is
  // exact. `includes` on the raw substring would accept
  // `.../instances/foo2/...` for instance `foo`, which is catastrophic for a
  // destructive command. Enforce a separator (or string end) immediately
  // before and after the instance name.
  const needle = `/instances/${instance}`;
  const idx = path.indexOf(needle);
  if (idx < 0) {
    throw new Error(
      `${label} does not contain the instance path segment ${JSON.stringify(
        needle
      )}: ${path}`
    );
  }
  const afterIdx = idx + needle.length;
  const afterChar = afterIdx < path.length ? path[afterIdx] : undefined;
  if (afterChar !== undefined && afterChar !== "/") {
    throw new Error(
      `${label} matches instance segment ${JSON.stringify(
        needle
      )} only by prefix (next char is ${JSON.stringify(afterChar)}); ` +
        `refusing to operate on ${path}`
    );
  }
}

/**
 * Terminate the instance's detached runtime (if any) and remove its
 * state and log directories. Idempotent: missing pidFile / missing
 * directories are fine and return `{ killedPid: null, killedSignal: null }`.
 */
export async function killAndRemoveInstance(
  options: KillAndRemoveInstanceOptions
): Promise<KillAndRemoveInstanceResult> {
  const {
    instance,
    pidFile,
    stateDir,
    logDir,
    waitForExitMs = 10_000,
    pollIntervalMs = 500
  } = options;
  const deps = options.deps ?? {};
  const signalProcess = deps.signalProcess ?? defaultSignal;
  const processAlive = deps.processAlive ?? isProcessAlive;
  const sleep = deps.sleep ?? defaultSleep;
  const readPid = deps.readPid ?? readPidFile;
  const removeDir = deps.removeDir ?? defaultRemoveDir;

  // Defense in depth: reject paths that do not carry the instance suffix.
  assertInstancePath(stateDir, instance, "stateDir");
  assertInstancePath(logDir, instance, "logDir");
  assertInstancePath(pidFile, instance, "pidFile");

  let killedPid: number | null = null;
  let killedSignal: "SIGTERM" | "SIGKILL" | null = null;

  const pid = await readPid(pidFile);
  if (pid > 0) {
    if (processAlive(pid)) {
      // SIGTERM first.
      try {
        signalProcess(pid, "SIGTERM");
        killedPid = pid;
        killedSignal = "SIGTERM";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          throw error;
        }
        // Already dead — nothing more to do.
      }
      // Wait up to waitForExitMs for the process to exit.
      const deadline = Date.now() + waitForExitMs;
      while (Date.now() < deadline) {
        if (!processAlive(pid)) break;
        await sleep(pollIntervalMs);
      }
      // If still alive, escalate to SIGKILL.
      if (processAlive(pid)) {
        try {
          signalProcess(pid, "SIGKILL");
          killedSignal = "SIGKILL";
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ESRCH") {
            throw error;
          }
        }
      }
    } else {
      // Pid file exists but the process is already gone. Record it as
      // a known pid but no signal was delivered.
      killedPid = pid;
      killedSignal = null;
    }
  }

  // Remove state and log directories (force+recursive = idempotent on
  // missing paths).
  await removeDir(stateDir);
  await removeDir(logDir);

  return {
    instance,
    killedPid,
    killedSignal,
    removed: { stateDir, logDir }
  };
}
