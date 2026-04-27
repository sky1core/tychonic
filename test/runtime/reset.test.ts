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
  it("delivers SIGTERM to the parent's process group and returns once it exits", async () => {
    const groupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const directSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let aliveChecks = 0;
    const result = await killAndRemoveInstance({
      instance: "foo",
      pidFile: "/tmp/Tychonic/instances/foo/runtime.pid",
      stateDir: "/tmp/Tychonic/instances/foo",
      logDir: "/tmp/Tychonic/instances/foo",
      waitForExitMs: 1_000,
      pollIntervalMs: 10,
      deps: {
        // Only the parent pidFile carries a value; the temporal pidfile
        // returns 0 so the second pass is a no-op.
        readPid: async (path) =>
          path === "/tmp/Tychonic/instances/foo/runtime.pid" ? 4321 : 0,
        // Start alive, then become dead after the first SIGTERM.
        processAlive: () => {
          aliveChecks += 1;
          return aliveChecks <= 2; // alive for the initial check + one poll
        },
        signalProcess: (pid, sig) => directSignals.push({ pid, signal: sig }),
        signalProcessGroup: (pid, sig) => groupSignals.push({ pid, signal: sig }),
        sleep: async () => undefined,
        removeDir: async () => undefined
      }
    });
    expect(result.killedPid).toBe(4321);
    expect(result.killedSignal).toBe("SIGTERM");
    // The runtime parent kill is a process-group kill, not a direct
    // pid kill. Direct pid signals are reserved for the temporal child
    // pidfile pass.
    expect(groupSignals).toEqual([{ pid: 4321, signal: "SIGTERM" }]);
    expect(directSignals).toEqual([]);
  });

  it("falls back to direct parent signaling when the pid is not a process-group leader", async () => {
    const groupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const directSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let alive = true;

    const result = await killAndRemoveInstance({
      instance: "foo",
      pidFile: "/tmp/Tychonic/instances/foo/runtime.pid",
      stateDir: "/tmp/Tychonic/instances/foo",
      logDir: "/tmp/Tychonic/instances/foo",
      waitForExitMs: 1_000,
      pollIntervalMs: 10,
      deps: {
        readPid: async (path) =>
          path === "/tmp/Tychonic/instances/foo/runtime.pid" ? 2468 : 0,
        processAlive: () => alive,
        signalProcessGroup: (pid, sig) => {
          groupSignals.push({ pid, signal: sig });
          const error = new Error("no such process group") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        },
        signalProcess: (pid, sig) => {
          directSignals.push({ pid, signal: sig });
          if (sig === "SIGTERM") alive = false;
        },
        sleep: async () => undefined,
        removeDir: async () => undefined
      }
    });

    expect(result.killedPid).toBe(2468);
    expect(result.killedSignal).toBe("SIGTERM");
    expect(groupSignals).toEqual([{ pid: 2468, signal: "SIGTERM" }]);
    expect(directSignals).toEqual([{ pid: 2468, signal: "SIGTERM" }]);
  });
});

describe("killAndRemoveInstance (SIGTERM times out → SIGKILL)", () => {
  it("escalates to SIGKILL on the process group when SIGTERM does not exit in time", async () => {
    const groupSignals: NodeJS.Signals[] = [];
    // The fake process stays alive forever for SIGTERM, and only becomes
    // dead after SIGKILL lands on the group.
    let killed = false;
    const result = await killAndRemoveInstance({
      instance: "foo",
      pidFile: "/tmp/Tychonic/instances/foo/runtime.pid",
      stateDir: "/tmp/Tychonic/instances/foo",
      logDir: "/tmp/Tychonic/instances/foo",
      waitForExitMs: 30,
      pollIntervalMs: 5,
      deps: {
        readPid: async (path) =>
          path === "/tmp/Tychonic/instances/foo/runtime.pid" ? 9999 : 0,
        processAlive: () => !killed,
        signalProcessGroup: (_pid, sig) => {
          groupSignals.push(sig);
          if (sig === "SIGKILL") killed = true;
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        removeDir: async () => undefined
      }
    });
    expect(result.killedPid).toBe(9999);
    expect(result.killedSignal).toBe("SIGKILL");
    expect(groupSignals[0]).toBe("SIGTERM");
    expect(groupSignals).toContain("SIGKILL");
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
        signalProcessGroup: (_pid, sig) => signals.push(sig),
        sleep: async () => undefined,
        removeDir: async () => undefined
      }
    });
    expect(result.killedPid).toBe(54321);
    expect(result.killedSignal).toBeNull();
    expect(signals).toEqual([]);
  });
});

describe("killAndRemoveInstance (temporal-child cascade)", () => {
  it("signals the runtime parent's process group and the temporal pidfile separately", async () => {
    const groupSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const directSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    // Track liveness of two distinct pids: the runtime parent (4000)
    // and the temporal child (5000). Group-kill on the parent's pgid
    // is modeled as "doesn't kill the child here" so we exercise the
    // belt-and-suspenders direct kill of the temporal pid.
    const alive = new Map<number, boolean>([
      [4000, true],
      [5000, true]
    ]);
    const result = await killAndRemoveInstance({
      instance: "foo",
      pidFile: "/tmp/Tychonic/instances/foo/runtime.pid",
      stateDir: "/tmp/Tychonic/instances/foo",
      logDir: "/tmp/Tychonic/instances/foo",
      waitForExitMs: 1_000,
      pollIntervalMs: 5,
      deps: {
        readPid: async (path) => {
          if (path === "/tmp/Tychonic/instances/foo/runtime.pid") return 4000;
          if (path === "/tmp/Tychonic/instances/foo/temporal/temporal.pid") return 5000;
          return 0;
        },
        processAlive: (pid) => alive.get(pid) === true,
        signalProcessGroup: (pid, sig) => {
          groupSignals.push({ pid, signal: sig });
          // The simulated group has the parent only; the temporal
          // child escaped (the scenario this pass is designed for).
          if (sig === "SIGTERM" || sig === "SIGKILL") alive.set(pid, false);
        },
        signalProcess: (pid, sig) => {
          directSignals.push({ pid, signal: sig });
          if (sig === "SIGTERM" || sig === "SIGKILL") alive.set(pid, false);
        },
        sleep: async () => undefined,
        removeDir: async () => undefined
      }
    });
    expect(result.killedPid).toBe(4000);
    expect(result.killedSignal).toBe("SIGTERM");
    expect(result.killedTemporalPid).toBe(5000);
    expect(result.killedTemporalSignal).toBe("SIGTERM");
    expect(groupSignals).toEqual([{ pid: 4000, signal: "SIGTERM" }]);
    expect(directSignals).toEqual([{ pid: 5000, signal: "SIGTERM" }]);
  });

  it("escalates SIGTERM to SIGKILL on the temporal child when it does not exit", async () => {
    const directSignals: NodeJS.Signals[] = [];
    let temporalKilled = false;
    const result = await killAndRemoveInstance({
      instance: "foo",
      pidFile: "/tmp/Tychonic/instances/foo/runtime.pid",
      stateDir: "/tmp/Tychonic/instances/foo",
      logDir: "/tmp/Tychonic/instances/foo",
      waitForExitMs: 30,
      pollIntervalMs: 5,
      deps: {
        readPid: async (path) => {
          if (path === "/tmp/Tychonic/instances/foo/runtime.pid") return 0;
          if (path === "/tmp/Tychonic/instances/foo/temporal/temporal.pid") return 7777;
          return 0;
        },
        processAlive: (pid) => pid === 7777 && !temporalKilled,
        signalProcess: (_pid, sig) => {
          directSignals.push(sig);
          if (sig === "SIGKILL") temporalKilled = true;
        },
        signalProcessGroup: () => undefined,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        removeDir: async () => undefined
      }
    });
    // No runtime parent recorded; only the temporal child path fired.
    expect(result.killedPid).toBeNull();
    expect(result.killedSignal).toBeNull();
    expect(result.killedTemporalPid).toBe(7777);
    expect(result.killedTemporalSignal).toBe("SIGKILL");
    expect(directSignals[0]).toBe("SIGTERM");
    expect(directSignals).toContain("SIGKILL");
  });

  it("does not double-signal the temporal pid when it equals the runtime parent pid", async () => {
    // Defensive: if a malformed pidfile pair somehow records the same
    // pid twice, the second pass is a no-op (we already covered it).
    const groupSignals: NodeJS.Signals[] = [];
    const directSignals: NodeJS.Signals[] = [];
    let alive = true;
    const result = await killAndRemoveInstance({
      instance: "foo",
      pidFile: "/tmp/Tychonic/instances/foo/runtime.pid",
      stateDir: "/tmp/Tychonic/instances/foo",
      logDir: "/tmp/Tychonic/instances/foo",
      waitForExitMs: 200,
      pollIntervalMs: 5,
      deps: {
        readPid: async () => 1234,
        processAlive: () => alive,
        signalProcessGroup: (_pid, sig) => {
          groupSignals.push(sig);
          if (sig === "SIGTERM") alive = false;
        },
        signalProcess: (_pid, sig) => directSignals.push(sig),
        sleep: async () => undefined,
        removeDir: async () => undefined
      }
    });
    expect(result.killedPid).toBe(1234);
    expect(result.killedTemporalPid).toBeNull();
    expect(directSignals).toEqual([]);
    expect(groupSignals).toEqual(["SIGTERM"]);
  });
});
