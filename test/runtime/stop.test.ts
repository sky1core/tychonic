import { describe, expect, it } from "vitest";
import { stopRuntimeParent } from "../../src/runtime/stop.js";

describe("stopRuntimeParent", () => {
  it("reports not_running when no runtime pid exists", async () => {
    const result = await stopRuntimeParent({
      instance: "spec-audit",
      pidFile: "/tmp/missing-runtime.pid",
      deps: {
        readPid: async () => 0
      }
    });

    expect(result).toMatchObject({
      ok: true,
      state: "not_running",
      pid: null,
      signalSent: null,
      pidFileRemoved: false
    });
  });

  it("removes a stale pid file without sending a signal", async () => {
    const removed: string[] = [];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const result = await stopRuntimeParent({
      instance: "spec-audit",
      pidFile: "/tmp/runtime.pid",
      deps: {
        readPid: async () => 123,
        processAlive: () => false,
        signalProcess: (pid, signal) => {
          signals.push({ pid, signal });
        },
        removePidFile: async (path) => {
          removed.push(path);
        }
      }
    });

    expect(result).toMatchObject({
      ok: true,
      state: "not_running",
      pid: 123,
      signalSent: null,
      pidFileRemoved: true
    });
    expect(signals).toEqual([]);
    expect(removed).toEqual(["/tmp/runtime.pid"]);
  });

  it("sends only SIGTERM and removes the pid file after the runtime exits", async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const removed: string[] = [];
    let probes = 0;

    const result = await stopRuntimeParent({
      instance: "spec-audit",
      pidFile: "/tmp/runtime.pid",
      waitForExitMs: 1000,
      pollIntervalMs: 1,
      deps: {
        readPid: async () => 456,
        processAlive: () => {
          probes += 1;
          return probes < 3;
        },
        signalProcess: (pid, signal) => {
          signals.push({ pid, signal });
        },
        sleep: async () => undefined,
        removePidFile: async (path) => {
          removed.push(path);
        }
      }
    });

    expect(result).toMatchObject({
      ok: true,
      state: "stopped",
      pid: 456,
      signalSent: "SIGTERM",
      pidFileRemoved: true
    });
    expect(signals).toEqual([{ pid: 456, signal: "SIGTERM" }]);
    expect(removed).toEqual(["/tmp/runtime.pid"]);
  });

  it("does not escalate when the runtime remains alive", async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const result = await stopRuntimeParent({
      instance: "spec-audit",
      pidFile: "/tmp/runtime.pid",
      waitForExitMs: 0,
      pollIntervalMs: 1,
      deps: {
        readPid: async () => 789,
        processAlive: () => true,
        signalProcess: (pid, signal) => {
          signals.push({ pid, signal });
        },
        sleep: async () => undefined
      }
    });

    expect(result).toMatchObject({
      ok: false,
      state: "timeout",
      pid: 789,
      signalSent: "SIGTERM",
      pidFileRemoved: false
    });
    expect(signals).toEqual([{ pid: 789, signal: "SIGTERM" }]);
  });
});
