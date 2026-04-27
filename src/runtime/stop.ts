/**
 * Safe runtime stop for `tychonic runtime stop --instance <name>`.
 *
 * This is intentionally not `runtime reset`: it sends SIGTERM to the
 * recorded runtime parent, waits briefly, removes only the pid file, and
 * never escalates to SIGKILL or removes state/log directories.
 */

import { rm } from "node:fs/promises";
import { readPidFile, isProcessAlive } from "./detached.js";

export interface StopRuntimeOptions {
  instance: string;
  pidFile: string;
  waitForExitMs?: number;
  pollIntervalMs?: number;
  deps?: StopRuntimeDeps;
}

export interface StopRuntimeDeps {
  readPid?: (pidFile: string) => Promise<number>;
  processAlive?: (pid: number) => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  removePidFile?: (pidFile: string) => Promise<void>;
}

export interface StopRuntimeResult {
  instance: string;
  ok: boolean;
  state: "stopped" | "not_running" | "signal_failed" | "timeout";
  pid: number | null;
  signalSent: "SIGTERM" | null;
  pidFile: string;
  pidFileRemoved: boolean;
  message: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function stopRuntimeParent(options: StopRuntimeOptions): Promise<StopRuntimeResult> {
  const { instance, pidFile, waitForExitMs = 5_000, pollIntervalMs = 100 } = options;
  const deps = options.deps ?? {};
  const readPid = deps.readPid ?? readPidFile;
  const processAlive = deps.processAlive ?? isProcessAlive;
  const signalProcess = deps.signalProcess ?? process.kill;
  const sleep = deps.sleep ?? defaultSleep;
  const removePidFile = deps.removePidFile ?? ((path) => rm(path, { force: true }));

  const pid = await readPid(pidFile);
  if (pid <= 0) {
    return {
      instance,
      ok: true,
      state: "not_running",
      pid: null,
      signalSent: null,
      pidFile,
      pidFileRemoved: false,
      message: `No runtime PID file found at ${pidFile}`
    };
  }

  if (!processAlive(pid)) {
    await removePidFile(pidFile);
    return {
      instance,
      ok: true,
      state: "not_running",
      pid,
      signalSent: null,
      pidFile,
      pidFileRemoved: true,
      message: `Runtime PID ${pid} is not running; removed ${pidFile}`
    };
  }

  try {
    signalProcess(pid, "SIGTERM");
  } catch (error) {
    if (processAlive(pid)) {
      return {
        instance,
        ok: false,
        state: "signal_failed",
        pid,
        signalSent: null,
        pidFile,
        pidFileRemoved: false,
        message: `Failed to send SIGTERM to runtime process ${pid}: ${
          error instanceof Error ? error.message : String(error)
        }`
      };
    }
  }

  const deadline = Date.now() + waitForExitMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      await removePidFile(pidFile);
      return {
        instance,
        ok: true,
        state: "stopped",
        pid,
        signalSent: "SIGTERM",
        pidFile,
        pidFileRemoved: true,
        message: `Stopped runtime process ${pid}`
      };
    }
    await sleep(pollIntervalMs);
  }

  if (!processAlive(pid)) {
    await removePidFile(pidFile);
    return {
      instance,
      ok: true,
      state: "stopped",
      pid,
      signalSent: "SIGTERM",
      pidFile,
      pidFileRemoved: true,
      message: `Stopped runtime process ${pid}`
    };
  }

  return {
    instance,
    ok: false,
    state: "timeout",
    pid,
    signalSent: "SIGTERM",
    pidFile,
    pidFileRemoved: false,
    message: `Sent SIGTERM to runtime process ${pid}, but it is still running`
  };
}
