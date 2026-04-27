/**
 * Detached runtime spawner for `tychonic runtime up --detach`.
 *
 * The parent process invokes `spawnDetachedRuntime` once and exits 0
 * immediately. The child is an independent session (`setsid` via node's
 * `{ detached: true }` + `child.unref()`) whose stdout/stderr are appended
 * to `runtime.log` and whose pid is written to `runtime.pid`.
 *
 * Only works when an isolated instance is active; enforcement lives in
 * the CLI layer (`runtime up --detach` action). This module is a pure
 * spawn utility — it does not consult active-instance state.
 *
 * Contract (§2 no magic): if a live pid already occupies `pidFile`, the
 * caller must refuse. This function overwrites `pidFile` unconditionally;
 * stale-pid detection happens above it in the CLI action.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SpawnDetachedRuntimeOptions {
  /** Absolute path to the node executable used to run the CLI. */
  nodePath: string;
  /** Absolute path to the Tychonic CLI entry (e.g. `.../dist/cli/main.js`). */
  cliPath: string;
  /**
   * Instance name. The child is invoked with `--instance <name>` so its
   * own preAction hook reproduces the same isolation as the parent.
   */
  instance: string;
  /**
   * Additional CLI arguments that follow `runtime up`. Must NOT include
   * `--detach` — the child runs in foreground mode.
   */
  extraArgs: string[];
  /** Absolute path to `runtime.log` under the instance state dir. */
  logFile: string;
  /** Absolute path to `runtime.pid` under the instance state dir. */
  pidFile: string;
  /**
   * Optional environment. `TYCHONIC_INSTANCE` is not injected here — the
   * child receives `--instance` on argv, which wins over env per §3.
   */
  env?: NodeJS.ProcessEnv;
}

export interface SpawnDetachedRuntimeResult {
  pid: number;
  logFile: string;
  pidFile: string;
}

/**
 * Spawn `tychonic --instance <name> runtime up <extraArgs...>` as a
 * detached foreground runtime. Returns when the child has been spawned
 * and its pid written. Does not wait for Temporal readiness — that is a
 * caller concern.
 */
export async function spawnDetachedRuntime(
  options: SpawnDetachedRuntimeOptions
): Promise<SpawnDetachedRuntimeResult> {
  const { nodePath, cliPath, instance, extraArgs, logFile, pidFile, env } = options;

  await mkdir(dirname(logFile), { recursive: true });
  await mkdir(dirname(pidFile), { recursive: true });

  // Open log file in append mode so multiple runs accumulate; the file
  // descriptor is handed to the child and then closed in the parent.
  const logFd = openSync(logFile, "a");
  try {
    // Child argv: drop `--detach` from the parent invocation, keep
    // `--instance <name>` so the child's own preAction reactivates the
    // same instance context.
    const childArgs = [cliPath, "--instance", instance, "runtime", "up", ...extraArgs];
    const child = spawn(nodePath, childArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      ...(env ? { env } : {})
    });
    const pid = child.pid;
    if (!pid) {
      throw new Error("failed to spawn detached runtime: child pid is undefined");
    }
    child.unref();
    await writeFile(pidFile, `${pid}\n`, "utf8");
    return { pid, logFile, pidFile };
  } finally {
    closeSync(logFd);
  }
}

/**
 * Read a pid from `pidFile`. Returns 0 when the file is absent, empty,
 * or contains a non-integer. Never throws on missing file.
 */
export async function readPidFile(pidFile: string): Promise<number> {
  try {
    const raw = await readFile(pidFile, "utf8");
    const pid = Number(raw.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

export async function writePidFile(pidFile: string, pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`pid must be a positive integer: ${pid}`);
  }
  await mkdir(dirname(pidFile), { recursive: true });
  await writeFile(pidFile, `${pid}\n`, "utf8");
}

export async function removePidFileIfOwned(pidFile: string, pid: number): Promise<boolean> {
  const current = await readPidFile(pidFile);
  if (current !== pid) {
    return false;
  }
  await rm(pidFile, { force: true });
  return true;
}

/**
 * Probe whether `pid` is alive via `kill(pid, 0)`. ESRCH → false. Any
 * other error (EPERM) also returns false because this process cannot
 * observe the target — the caller then treats it as stale.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
