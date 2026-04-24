/**
 * Unit tests for `killAndRemoveInstance`. The function is exercised
 * here with injected deps so no real process is killed and no real
 * filesystem is mutated.
 */

import { describe, expect, it } from "vitest";
import { killAndRemoveInstance } from "../../src/runtime/reset.js";

describe("killAndRemoveInstance (path guard)", () => {
  it("rejects a stateDir that does not contain the instance suffix", async () => {
    await expect(
      killAndRemoveInstance({
        instance: "foo",
        pidFile: "/tmp/Tychonic/instances/foo/runtime.pid",
        stateDir: "/tmp/Tychonic", // missing instance suffix
        logDir: "/tmp/Tychonic/instances/foo",
        deps: {
          readPid: async () => 0,
          removeDir: async () => undefined
        }
      })
    ).rejects.toThrow(/does not contain the instance path segment/);
  });

  it("rejects a logDir belonging to a different instance", async () => {
    await expect(
      killAndRemoveInstance({
        instance: "foo",
        pidFile: "/tmp/Tychonic/instances/foo/runtime.pid",
        stateDir: "/tmp/Tychonic/instances/foo",
        logDir: "/tmp/Tychonic/instances/bar",
        deps: {
          readPid: async () => 0,
          removeDir: async () => undefined
        }
      })
    ).rejects.toThrow(/does not contain the instance path segment/);
  });

  it("rejects a stateDir that matches the instance name only by prefix (foo2 for foo)", async () => {
    await expect(
      killAndRemoveInstance({
        instance: "foo",
        pidFile: "/tmp/Tychonic/instances/foo2/runtime.pid",
        stateDir: "/tmp/Tychonic/instances/foo2",
        logDir: "/tmp/logs/Tychonic/instances/foo2",
        deps: {
          readPid: async () => 0,
          removeDir: async () => undefined
        }
      })
    ).rejects.toThrow(/matches instance segment .* only by prefix/);
  });

  it("rejects a logDir whose instance segment has a hyphen suffix (foo-old for foo)", async () => {
    await expect(
      killAndRemoveInstance({
        instance: "foo",
        pidFile: "/tmp/Tychonic/instances/foo/runtime.pid",
        stateDir: "/tmp/Tychonic/instances/foo",
        logDir: "/tmp/logs/Tychonic/instances/foo-old",
        deps: {
          readPid: async () => 0,
          removeDir: async () => undefined
        }
      })
    ).rejects.toThrow(/matches instance segment .* only by prefix/);
  });
});

describe("killAndRemoveInstance (no pidfile)", () => {
  it("returns killedPid=null and removes both dirs when no pid file is present", async () => {
    const removed: string[] = [];
    const result = await killAndRemoveInstance({
      instance: "foo",
      pidFile: "/tmp/Tychonic/instances/foo/runtime.pid",
      stateDir: "/tmp/Tychonic/instances/foo",
      logDir: "/tmp/logs/Tychonic/instances/foo",
      deps: {
        readPid: async () => 0,
        removeDir: async (p) => {
          removed.push(p);
        }
      }
    });
    expect(result.killedPid).toBeNull();
    expect(result.killedSignal).toBeNull();
    expect(result.instance).toBe("foo");
    expect(removed).toEqual([
      "/tmp/Tychonic/instances/foo",
      "/tmp/logs/Tychonic/instances/foo"
    ]);
  });
});

describe("killAndRemoveInstance (SIGTERM succeeds)", () => {
  it("delivers SIGTERM and returns once the process exits", async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let aliveChecks = 0;
    const result = await killAndRemoveInstance({
      instance: "foo",
      pidFile: "/tmp/Tychonic/instances/foo/runtime.pid",
      stateDir: "/tmp/Tychonic/instances/foo",
      logDir: "/tmp/Tychonic/instances/foo",
      waitForExitMs: 1_000,
      pollIntervalMs: 10,
      deps: {
        readPid: async () => 4321,
        // Start alive, then become dead after the first SIGTERM.
        processAlive: () => {
          aliveChecks += 1;
          return aliveChecks <= 2; // alive for the initial check + one poll
        },
        signalProcess: (pid, sig) => signals.push({ pid, signal: sig }),
        sleep: async () => undefined,
        removeDir: async () => undefined
      }
    });
    expect(result.killedPid).toBe(4321);
    expect(result.killedSignal).toBe("SIGTERM");
    expect(signals).toEqual([{ pid: 4321, signal: "SIGTERM" }]);
  });
});

describe("killAndRemoveInstance (SIGTERM times out → SIGKILL)", () => {
  it("escalates to SIGKILL when the process does not exit in time", async () => {
    const signals: NodeJS.Signals[] = [];
    // The fake process stays alive forever for SIGTERM, and only becomes
    // dead after SIGKILL lands.
    let killed = false;
    const result = await killAndRemoveInstance({
      instance: "foo",
      pidFile: "/tmp/Tychonic/instances/foo/runtime.pid",
      stateDir: "/tmp/Tychonic/instances/foo",
      logDir: "/tmp/Tychonic/instances/foo",
      waitForExitMs: 30,
      pollIntervalMs: 5,
      deps: {
        readPid: async () => 9999,
        processAlive: () => !killed,
        signalProcess: (_pid, sig) => {
          signals.push(sig);
          if (sig === "SIGKILL") killed = true;
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        removeDir: async () => undefined
      }
    });
    expect(result.killedPid).toBe(9999);
    expect(result.killedSignal).toBe("SIGKILL");
    expect(signals[0]).toBe("SIGTERM");
    expect(signals).toContain("SIGKILL");
  });
});

describe("killAndRemoveInstance (stale pid)", () => {
  it("records the pid but delivers no signal when the process is already dead", async () => {
    const signals: NodeJS.Signals[] = [];
    const result = await killAndRemoveInstance({
      instance: "foo",
      pidFile: "/tmp/Tychonic/instances/foo/runtime.pid",
      stateDir: "/tmp/Tychonic/instances/foo",
      logDir: "/tmp/Tychonic/instances/foo",
      deps: {
        readPid: async () => 54321,
        processAlive: () => false,
        signalProcess: (_pid, sig) => signals.push(sig),
        sleep: async () => undefined,
        removeDir: async () => undefined
      }
    });
    expect(result.killedPid).toBe(54321);
    expect(result.killedSignal).toBeNull();
    expect(signals).toEqual([]);
  });
});
