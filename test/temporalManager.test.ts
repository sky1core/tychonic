import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetRuntimeDirWarningsForTest,
  normalizeTemporalConfig,
  TemporalManager,
  temporalStartArgs,
  tychonicRuntimeDirs,
  type NormalizedTemporalConfig,
  type TemporalManagerDeps
} from "../src/temporal/manager.js";
import {
  deriveInstancePort,
  getActiveInstance,
  setActiveInstance
} from "../src/runtime/instance.js";

describe("normalizeTemporalConfig", () => {
  it("defaults managed-local config", () => {
    const cfg = normalizeTemporalConfig({});

    expect(cfg.mode).toBe("managed-local");
    expect(cfg.address).toBe("127.0.0.1:7233");
    expect(cfg.uiPort).toBe(8233);
    expect(cfg.dbFilename).toBe(join(tychonicRuntimeDirs().stateDir, "temporal", "temporal.db"));
    expect(cfg.logFile).toBe(join(tychonicRuntimeDirs().logDir, "temporal.log"));
    expect(cfg.pidFile).toBe(join(tychonicRuntimeDirs().stateDir, "temporal", "temporal.pid"));
    expect(cfg.taskQueue).toBe("tychonic");
  });

  it("keeps external address and skips managed files", () => {
    const cfg = normalizeTemporalConfig({ mode: "external", address: "temporal.example:7233" });

    expect(cfg.address).toBe("temporal.example:7233");
    expect(cfg.dbFilename).toBe("");
    expect(cfg.logFile).toBe("");
    expect(cfg.pidFile).toBe("");
  });

  it("builds temporal start-dev arguments", () => {
    const cfg = normalizeTemporalConfig({
      host: "127.0.0.2",
      frontendPort: 17233,
      uiPort: 18233,
      namespace: "work",
      dbFilename: "state/temporal.db"
    });

    expect(temporalStartArgs(cfg)).toEqual([
      "server",
      "start-dev",
      "--ip",
      "127.0.0.2",
      "--port",
      "17233",
      "--ui-port",
      "18233",
      "--namespace",
      "work",
      "--db-filename",
      "state/temporal.db"
    ]);
  });
});

describe("tychonicRuntimeDirs / normalizeTemporalConfig with active instance", () => {
  afterEach(() => {
    // Always clear active instance so later tests see the operational
    // baseline. Also clear the stderr dedupe set so warning-related
    // assertions are independent between tests.
    setActiveInstance(undefined);
    __resetRuntimeDirWarningsForTest();
    vi.restoreAllMocks();
    expect(getActiveInstance()).toBeUndefined();
  });

  it("appends instances/<name>/ to stateDir and logDir when instance is set", () => {
    const baseline = tychonicRuntimeDirs();
    setActiveInstance("p2test");
    const active = tychonicRuntimeDirs();
    expect(active.stateDir).toBe(join(baseline.stateDir, "instances", "p2test"));
    expect(active.logDir).toBe(join(baseline.logDir, "instances", "p2test"));
  });

  it("lets $TYCHONIC_STATE_HOME win over the instance-derived stateDir and emits one warning", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setActiveInstance("p2state");
    const result = tychonicRuntimeDirs({
      TYCHONIC_STATE_HOME: "/custom/state"
    } as NodeJS.ProcessEnv);
    expect(result.stateDir).toBe("/custom/state");
    // Warning lands on stderr.
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("TYCHONIC_STATE_HOME overrides instance state dir")
    );
    // Second call with the same warning does not re-emit (process-lifetime dedupe).
    const calls = stderrSpy.mock.calls.length;
    tychonicRuntimeDirs({ TYCHONIC_STATE_HOME: "/custom/state" } as NodeJS.ProcessEnv);
    expect(stderrSpy.mock.calls.length).toBe(calls);
  });

  it("normalizeTemporalConfig with empty config and instance set derives address/taskQueue", () => {
    setActiveInstance("p2net");
    const cfg = normalizeTemporalConfig({});
    const port = deriveInstancePort("p2net");
    expect(cfg.frontendPort).toBe(port);
    expect(cfg.uiPort).toBe(port + 1);
    expect(cfg.address).toBe(`127.0.0.1:${port}`);
    expect(cfg.taskQueue).toBe("tychonic-p2net");
    // Namespace stays default — instance does not change it.
    expect(cfg.namespace).toBe("default");
  });

  it("normalizeTemporalConfig with instance unset keeps legacy defaults byte-identical", () => {
    // No setActiveInstance call; active instance is undefined.
    const cfg = normalizeTemporalConfig({});
    expect(cfg.frontendPort).toBe(7233);
    expect(cfg.uiPort).toBe(8233);
    expect(cfg.address).toBe("127.0.0.1:7233");
    expect(cfg.taskQueue).toBe("tychonic");
    expect(cfg.namespace).toBe("default");
  });
});

describe("TemporalManager", () => {
  it("reports stopped when the frontend port is closed", async () => {
    const manager = managerWith({
      lookup: async () => "/bin/temporal",
      dial: async () => {
        throw new Error("connection refused");
      }
    });

    await expect(manager.status()).resolves.toMatchObject({
      health: "stopped",
      portOpen: false
    });
  });

  it("starts managed-local Temporal when the port is free", async () => {
    let started: NormalizedTemporalConfig | undefined;
    const manager = managerWith({
      lookup: async () => "/bin/temporal",
      dial: async () => {
        throw new Error("connection refused");
      },
      start: async (cfg, cli) => {
        expect(cli).toBe("/bin/temporal");
        started = cfg;
        return 12345;
      }
    });

    await expect(manager.start()).resolves.toMatchObject({
      health: "starting",
      pid: 12345
    });
    expect(started?.dbFilename).toBeTruthy();
  });

  it("refuses unmanaged occupied ports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tychonic-temporal-unmanaged-"));
    const manager = managerWith(
      {
        lookup: async () => "/bin/temporal",
        dial: async () => undefined
      },
      {
        pidFile: join(dir, "temporal.pid")
      }
    );

    await expect(manager.start()).rejects.toThrow(/already occupied/);
  });

  it("refuses an occupied managed-local UI port before starting Temporal", async () => {
    let started = false;
    const manager = managerWith(
      {
        lookup: async () => "/bin/temporal",
        dial: async (address) => {
          if (address === "127.0.0.1:18233") {
            return undefined;
          }
          throw new Error("connection refused");
        },
        start: async () => {
          started = true;
          return 12345;
        }
      },
      {
        frontendPort: 17233,
        uiPort: 18233
      }
    );

    await expect(manager.start()).rejects.toThrow(/UI port 127\.0\.0\.1:18233 is already occupied/);
    expect(started).toBe(false);
  });

  it("reports occupied managed-local UI port in doctor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tychonic-temporal-ui-doctor-"));
    const manager = managerWith(
      {
        lookup: async () => "/bin/temporal",
        dial: async (address) => {
          if (address === "127.0.0.1:18233") {
            return undefined;
          }
          throw new Error("connection refused");
        }
      },
      {
        frontendPort: 17233,
        uiPort: 18233,
        dbFilename: join(dir, "temporal.db"),
        logFile: join(dir, "temporal.log"),
        pidFile: join(dir, "temporal.pid")
      }
    );

    const report = await manager.doctor();
    expect(report.overall).toBe("fail");
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "ui_port", status: "fail" })
    );
  });

  it("accepts an open UI port when the managed Temporal PID is live", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tychonic-temporal-ui-managed-"));
    const pidFile = join(dir, "temporal.pid");
    await writeFile(pidFile, "2468\n", "utf8");
    const manager = managerWith(
      {
        lookup: async () => "/bin/temporal",
        dial: async () => undefined,
        processAlive: async (pid) => pid === 2468,
        processCommand: async () => "/opt/homebrew/bin/temporal server start-dev"
      },
      {
        pidFile,
        dbFilename: join(dir, "temporal.db"),
        logFile: join(dir, "temporal.log")
      }
    );

    const report = await manager.doctor();
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "frontend_port", status: "ok" })
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "ui_port", status: "ok" })
    );
  });

  it("accepts launchd-managed Temporal when the PID file is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tychonic-temporal-launchd-managed-"));
    const manager = managerWith(
      {
        lookup: async () => "/bin/temporal",
        dial: async () => undefined,
        portListeningPids: async (port) => (port === 7233 ? [2468] : []),
        processAlive: async (pid) => pid === 2468,
        processCommand: async () => "/opt/homebrew/bin/temporal server start-dev --ip 127.0.0.1 --port 7233"
      },
      {
        dbFilename: join(dir, "temporal.db"),
        logFile: join(dir, "temporal.log"),
        pidFile: join(dir, "temporal.pid")
      }
    );

    await expect(manager.status()).resolves.toMatchObject({
      portOpen: true,
      pid: 2468
    });

    const report = await manager.doctor();
    expect(report.overall).toBe("ok");
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "frontend_port", status: "ok" })
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "ui_port", status: "ok" })
    );

    await expect(manager.start()).resolves.toMatchObject({
      pid: 2468,
      message: "Tychonic-managed Temporal appears to be running"
    });
  });

  it("reuses managed PID when the port is open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tychonic-temporal-"));
    const pidFile = join(dir, "temporal.pid");
    await writeFile(pidFile, "2468\n", "utf8");
    const manager = managerWith(
      {
        lookup: async () => "/bin/temporal",
        dial: async () => undefined,
        processAlive: async (pid) => pid === 2468,
        processCommand: async () => "/opt/homebrew/bin/temporal server start-dev"
      },
      { pidFile }
    );

    await expect(manager.start()).resolves.toMatchObject({
      pid: 2468,
      message: "Tychonic-managed Temporal appears to be running"
    });
  });

  it("stops a live managed-local Temporal process and removes the PID file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tychonic-temporal-stop-"));
    const pidFile = join(dir, "temporal.pid");
    await writeFile(pidFile, "2468\n", "utf8");
    let alive = true;
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const manager = managerWith(
      {
        lookup: async () => "/bin/temporal",
        dial: async () => undefined,
        processAlive: async (pid) => pid === 2468 && alive,
        processCommand: async () => "/opt/homebrew/bin/temporal server start-dev",
        signalProcess: async (pid, signal) => {
          signals.push({ pid, signal });
          alive = false;
        },
        sleep: async () => undefined
      },
      { pidFile }
    );

    await expect(manager.stop()).resolves.toMatchObject({
      ok: true,
      state: "stopped",
      pid: 2468,
      pidFileRemoved: true
    });
    expect(signals).toEqual([{ pid: 2468, signal: "SIGTERM" }]);
    await expect(readFile(pidFile, "utf8")).rejects.toThrow();
  });

  it("removes the managed PID file when the recorded Temporal process is already stopped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tychonic-temporal-stop-stale-"));
    const pidFile = join(dir, "temporal.pid");
    await writeFile(pidFile, "2468\n", "utf8");
    const manager = managerWith(
      {
        lookup: async () => "/bin/temporal",
        dial: async () => {
          throw new Error("connection refused");
        },
        processAlive: async () => false,
        signalProcess: async () => {
          throw new Error("should not signal a dead process");
        }
      },
      { pidFile }
    );

    await expect(manager.stop()).resolves.toMatchObject({
      ok: true,
      state: "not_running",
      pid: 2468,
      pidFileRemoved: true
    });
    await expect(readFile(pidFile, "utf8")).rejects.toThrow();
  });

  it("refuses to stop a live non-Temporal process from the PID file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tychonic-temporal-stop-refuse-"));
    const pidFile = join(dir, "temporal.pid");
    await writeFile(pidFile, "2468\n", "utf8");
    let signaled = false;
    const manager = managerWith(
      {
        lookup: async () => "/bin/temporal",
        dial: async () => undefined,
        processAlive: async (pid) => pid === 2468,
        processCommand: async () => "node server.js",
        signalProcess: async () => {
          signaled = true;
        }
      },
      { pidFile }
    );

    await expect(manager.stop()).resolves.toMatchObject({
      ok: false,
      state: "refused",
      pid: 2468,
      pidFileRemoved: false
    });
    expect(signaled).toBe(false);
    await expect(readFile(pidFile, "utf8")).resolves.toBe("2468\n");
  });

  it("refuses to stop a live non-Temporal process whose command contains temporal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tychonic-temporal-stop-substring-"));
    const pidFile = join(dir, "temporal.pid");
    await writeFile(pidFile, "2468\n", "utf8");
    let signaled = false;
    const manager = managerWith(
      {
        lookup: async () => "/bin/temporal",
        dial: async () => undefined,
        processAlive: async (pid) => pid === 2468,
        processCommand: async () => "node temporal-helper.js",
        signalProcess: async () => {
          signaled = true;
        }
      },
      { pidFile }
    );

    await expect(manager.stop()).resolves.toMatchObject({
      ok: false,
      state: "refused",
      pid: 2468,
      pidFileRemoved: false
    });
    expect(signaled).toBe(false);
    await expect(readFile(pidFile, "utf8")).resolves.toBe("2468\n");
  });

  it("reports JSON-safe failure when SIGTERM cannot be sent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tychonic-temporal-stop-signal-"));
    const pidFile = join(dir, "temporal.pid");
    await writeFile(pidFile, "2468\n", "utf8");
    const manager = managerWith(
      {
        lookup: async () => "/bin/temporal",
        dial: async () => undefined,
        processAlive: async (pid) => pid === 2468,
        processCommand: async () => "/opt/homebrew/bin/temporal server start-dev",
        signalProcess: async () => {
          throw new Error("operation not permitted");
        }
      },
      { pidFile }
    );

    await expect(manager.stop()).resolves.toMatchObject({
      ok: false,
      state: "signal_failed",
      pid: 2468,
      pidFileRemoved: false
    });
    await expect(readFile(pidFile, "utf8")).resolves.toBe("2468\n");
  });

  it("does not stop external Temporal mode", async () => {
    const manager = managerWith(
      {
        lookup: async () => "/bin/temporal",
        dial: async () => undefined
      },
      { mode: "external", address: "temporal.example:7233" }
    );

    await expect(manager.stop()).resolves.toMatchObject({
      ok: false,
      state: "unsupported_mode",
      pidFileRemoved: false
    });
  });

  it("doctor fails managed-local without temporal CLI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tychonic-temporal-doctor-"));
    const manager = managerWith(
      {
        lookup: async () => undefined,
        dial: async () => {
          throw new Error("connection refused");
        }
      },
      {
        dbFilename: join(dir, "temporal.db"),
        logFile: join(dir, "temporal.log"),
        pidFile: join(dir, "temporal.pid")
      }
    );

    const report = await manager.doctor();
    expect(report.overall).toBe("fail");
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "temporal_cli", status: "fail" })
    );
  });
});

function managerWith(deps: TemporalManagerDeps, config = {}): TemporalManager {
  return new TemporalManager(config, {
    processAlive: async () => false,
    processCommand: async () => "",
    start: async () => 999,
    signalProcess: async () => undefined,
    sleep: async () => undefined,
    ...deps
  });
}
