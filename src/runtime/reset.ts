/**
 * `runtime reset --instance <name>` core logic.
 *
 * Terminates any runtime process recorded in `pidFile` (SIGTERM → 10s wait
 * → SIGKILL), then removes the instance's state and log directories.
 * Pure-ish: takes explicit path inputs and a deps object so tests can inject
 * fake signal/sleep/fs behavior.
 *
 * Process-tree cleanup: detached runtime parents are spawned by the outer
 * CLI with `{ detached: true }`, which makes each parent its own process-group
 * leader (pgid == parent pid). The runtime parent then spawns Temporal with
 * `{ inheritProcessGroup: true }`, so the temporal child shares that pgid.
 * Reset therefore tries `kill(-pgid, sig)` first. Foreground instance
 * runtimes also write `runtime.pid` for `runtime stop`; those pids are not
 * necessarily process-group leaders, so reset falls back to direct pid
 * signaling when the group signal reports ESRCH.
 *
 * Belt-and-suspenders: reset additionally reads
 * `<state>/temporal/temporal.pid`, which `startTemporal` writes after
 * the spawn, and explicitly signals that pid as well. The group kill
 * already covers it in the normal case; the explicit pidfile pass
 * catches the edge case where the temporal child somehow detached from
 * the group (e.g. an operator-issued `setsid` from inside the runtime
 * parent, or a future change that re-introduces `detached: true` on
 * the temporal spawn without updating reset).
 *
 * Safety invariant: every path the caller passes MUST contain the
 * `instances/<name>` suffix. This module asserts the suffix before any
 * `rm -rf`. Operational paths never include that suffix, so a caller bug
 * that threads an operational path in here will throw instead of wiping
 * the operational state dir.
 */

import { rm } from "node:fs/promises";
import { join as pathJoin } from "node:path";
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
  /**
   * Send `signal` to every process in the process group whose pgid is
   * `pid`. Default: `process.kill(-pid, signal)`. Errors with code
   * `ESRCH` are treated as "group already gone"; any other error is
   * surfaced.
   */
  signalProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  /** Test whether `pid` is alive. Default: `process.kill(pid, 0)`. */
  processAlive?: (pid: number) => boolean;
  /** Sleep for `ms`. Default: `setTimeout`-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Read pid from a file. Default: reads the pidFile. */
  readPid?: (pidFile: string) => Promise<number>;
  /** Remove a directory recursively. Default: `fs.rm`. */
  removeDir?: (path: string) => Promise<void>;
}

export interface KillAndRemoveInstanceResult {
  instance: string;
  killedPid: number | null;
  killedSignal: "SIGTERM" | "SIGKILL" | null;
  /**
   * The Temporal child pid recovered from
   * `<state>/temporal/temporal.pid`, if any. Null when the file was
   * absent or empty (no Temporal was started). Reported separately so
   * operators can confirm the cascade reached both the runtime parent
   * and the Temporal child.
   */
  killedTemporalPid: number | null;
  killedTemporalSignal: "SIGTERM" | "SIGKILL" | null;
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

/**
 * Default group-signal: `process.kill(-pid, sig)` delivers the signal
 * to every process in the group whose pgid == pid. ESRCH means the
 * group is already empty; treat it as success. Any other error
 * propagates so the caller can decide.
 */
function defaultSignalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    throw error;
  }
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
 * Terminate the instance's runtime (if any), cascade the signal across
 * its process group when possible, and remove its state and log
 * directories. Idempotent: missing pidFile / missing directories are fine.
 *
 * Order:
 *   1. Read `<pidFile>` (the runtime parent pid). If alive, signal the
   *      parent's process group (`kill(-pid, SIGTERM)`) so the temporal
   *      child receives the signal in the same delivery for detached
   *      runtimes. If the pid is not a group leader, signal the parent
   *      pid directly. Wait up to `waitForExitMs` for the parent to exit.
   *      If still alive, escalate through the same path to SIGKILL.
 *   2. Read `<stateDir>/temporal/temporal.pid` (the temporal child
 *      pid). Belt-and-suspenders: if that pid is still alive after the
 *      group kill, signal it directly with the same SIGTERM→SIGKILL
 *      escalation. Catches the corner case where the temporal child
 *      escaped the group.
 *   3. Remove `stateDir` and `logDir`.
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
  const signalProcessGroup = deps.signalProcessGroup ?? defaultSignalGroup;
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
      // Detached runtimes make the runtime parent the pgid leader, so the
      // process-group signal reaches both the parent and its Temporal child.
      // Foreground instance runtimes also write runtime.pid for `runtime stop`,
      // but their pid is not necessarily a pgid. If the group signal reports
      // ESRCH, fall back to direct parent signaling.
      let parentSignalMode: "group" | "direct" | null = null;
      try {
        signalProcessGroup(pid, "SIGTERM");
        killedPid = pid;
        killedSignal = "SIGTERM";
        parentSignalMode = "group";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          throw error;
        }
        if (processAlive(pid)) {
          signalProcess(pid, "SIGTERM");
          killedPid = pid;
          killedSignal = "SIGTERM";
          parentSignalMode = "direct";
        }
      }
      // Wait up to waitForExitMs for the parent to exit.
      const deadline = Date.now() + waitForExitMs;
      while (Date.now() < deadline) {
        if (!processAlive(pid)) break;
        await sleep(pollIntervalMs);
      }
      // If the parent is still alive, escalate to SIGKILL on the group.
      if (processAlive(pid)) {
        try {
          if (parentSignalMode === "direct") {
            signalProcess(pid, "SIGKILL");
          } else {
            signalProcessGroup(pid, "SIGKILL");
          }
          killedSignal = "SIGKILL";
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ESRCH") {
            throw error;
          }
        }
      }
    } else {
      // Pid file exists but the parent is already gone. Record it as
      // a known pid but no signal was delivered. The temporal child
      // pass below still runs — a stale-parent file does not imply the
      // temporal child is gone too.
      killedPid = pid;
      killedSignal = null;
    }
  }

  // Belt-and-suspenders: signal the temporal child explicitly using
  // the pid recorded by `startTemporal`. The group-kill above usually
  // already delivered the signal; this pass catches the case where the
  // child somehow detached from the group, and also the case where the
  // parent died before it ever sent a group-signal.
  let killedTemporalPid: number | null = null;
  let killedTemporalSignal: "SIGTERM" | "SIGKILL" | null = null;
  const temporalPidFile = pathJoin(stateDir, "temporal", "temporal.pid");
  // Same instance-suffix guard the top-level paths got. The temporal
  // pidFile is computed from stateDir which already passed the assert,
  // so this is just consistency for the kill set.
  assertInstancePath(temporalPidFile, instance, "temporalPidFile");
  const tpid = await readPid(temporalPidFile);
  if (tpid > 0 && tpid !== pid) {
    if (processAlive(tpid)) {
      try {
        signalProcess(tpid, "SIGTERM");
        killedTemporalPid = tpid;
        killedTemporalSignal = "SIGTERM";
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          throw error;
        }
      }
      const deadline = Date.now() + waitForExitMs;
      while (Date.now() < deadline) {
        if (!processAlive(tpid)) break;
        await sleep(pollIntervalMs);
      }
      if (processAlive(tpid)) {
        try {
          signalProcess(tpid, "SIGKILL");
          killedTemporalSignal = "SIGKILL";
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ESRCH") {
            throw error;
          }
        }
      }
    } else {
      killedTemporalPid = tpid;
      killedTemporalSignal = null;
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
    killedTemporalPid,
    killedTemporalSignal,
    removed: { stateDir, logDir }
  };
}
