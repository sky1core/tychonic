import { spawn, execFile } from "node:child_process";
import { createConnection } from "node:net";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { findExecutable } from "../system/executables.js";
import {
  getActiveInstance,
  resolveInstanceRuntime,
  type ResolveInstanceRuntimeExplicit,
  type ResolveInstanceRuntimeOptions
} from "../runtime/instance.js";

const execFileAsync = promisify(execFile);

export const temporalModes = ["managed-local", "external"] as const;
export type TemporalMode = (typeof temporalModes)[number];

export interface TemporalConfig {
  mode?: TemporalMode;
  host?: string;
  apiPort?: number;
  devUiPort?: number;
  address?: string;
  namespace?: string;
  taskQueue?: string;
  dbFilename?: string;
  logFile?: string;
  pidFile?: string;
}

export interface NormalizedTemporalConfig {
  mode: TemporalMode;
  host: string;
  apiPort: number;
  devUiPort: number;
  address: string;
  namespace: string;
  taskQueue: string;
  dbFilename: string;
  logFile: string;
  pidFile: string;
}

export interface TemporalStatus {
  mode: TemporalMode;
  address: string;
  namespace: string;
  taskQueue: string;
  portOpen: boolean;
  cliPath?: string;
  health: "stopped" | "unknown" | "port-open" | "starting";
  message?: string;
  pid?: number;
  dbFilename?: string;
  logFile?: string;
  pidFile?: string;
}

export interface TemporalStopStatus {
  mode: TemporalMode;
  address: string;
  namespace: string;
  taskQueue: string;
  ok: boolean;
  state: "stopped" | "not_running" | "refused" | "signal_failed" | "timeout" | "unsupported_mode";
  message: string;
  pid?: number;
  pidFile?: string;
  pidFileRemoved: boolean;
}

export interface TemporalDoctorReport {
  overall: "ok" | "warn" | "fail";
  mode: TemporalMode;
  address: string;
  namespace: string;
  taskQueue: string;
  checks: Array<{ name: string; status: "ok" | "warn" | "fail"; detail: string }>;
}

/**
 * Optional knobs for `TemporalManager.start()`. The runtime-parent
 * (`runtime up`) passes `inheritProcessGroup: true` so the spawned
 * Temporal child shares the parent's pgid; `runtime reset` then kills
 * the entire group with `kill(-pgid)` and the child cannot orphan.
 *
 * Standalone callers (`tychonic temporal start`) leave the option
 * unset — the default, daemon-style spawn (own pgid via `setsid`) is
 * what they need to survive the CLI exit.
 */
export interface TemporalStartOptions {
  /**
   * When true, the spawned Temporal child inherits the parent's
   * process group (Node default for `spawn` without `detached: true`)
   * so that a process-group kill on the parent reaches the child.
   * Default false (daemon-style detached spawn).
   */
  inheritProcessGroup?: boolean;
}

export interface TemporalManagerDeps {
  lookup?: (name: string) => Promise<string | undefined>;
  dial?: (address: string) => Promise<void>;
  start?: (
    cfg: NormalizedTemporalConfig,
    cli: string,
    opts?: TemporalStartOptions
  ) => Promise<number>;
  processAlive?: (pid: number) => Promise<boolean>;
  processCommand?: (pid: number) => Promise<string>;
  portListeningPids?: (port: number) => Promise<number[]>;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export class TemporalManager {
  readonly config: NormalizedTemporalConfig;
  private readonly deps: Required<TemporalManagerDeps>;

  constructor(config: TemporalConfig = {}, deps: TemporalManagerDeps = {}) {
    this.config = normalizeTemporalConfig(config);
    this.deps = {
      lookup: deps.lookup ?? findExecutable,
      dial: deps.dial ?? dialTCP,
      start: deps.start ?? startTemporal,
      processAlive: deps.processAlive ?? processAlive,
      processCommand: deps.processCommand ?? processCommand,
      portListeningPids: deps.portListeningPids ?? portListeningPids,
      signalProcess: deps.signalProcess ?? signalProcess,
      sleep: deps.sleep ?? sleep
    };
  }

  async status(): Promise<TemporalStatus> {
    const status: TemporalStatus = {
      mode: this.config.mode,
      address: this.config.address,
      namespace: this.config.namespace,
      taskQueue: this.config.taskQueue,
      portOpen: false,
      health: "stopped",
      dbFilename: this.config.dbFilename,
      logFile: this.config.logFile,
      pidFile: this.config.pidFile
    };

    const pid = await readPID(this.config.pidFile);
    if (pid > 0) {
      status.pid = pid;
    }

    const cliPath = await this.deps.lookup("temporal");
    if (cliPath) {
      status.cliPath = cliPath;
    }

    try {
      await this.deps.dial(this.config.address);
    } catch (error) {
      status.health = "stopped";
      status.message = error instanceof Error ? error.message : String(error);
      return status;
    }

    status.portOpen = true;
    if (this.config.mode === "managed-local" && !status.pid) {
      const pid = await this.managedTemporalPIDForPort(this.config.apiPort);
      if (pid) {
        status.pid = pid;
      }
    }
    if (!status.cliPath) {
      status.health = "unknown";
      status.message = "port is open, but temporal CLI is not installed";
      return status;
    }
    status.health = "port-open";
    status.message = "port is open; use Temporal API health checks in the worker integration";
    return status;
  }

  async doctor(): Promise<TemporalDoctorReport> {
    const status = await this.status();
    const report: TemporalDoctorReport = {
      overall: "ok",
      mode: this.config.mode,
      address: this.config.address,
      namespace: this.config.namespace,
      taskQueue: this.config.taskQueue,
      checks: []
    };
    addCheck(report, "mode", "ok", `Temporal mode is ${this.config.mode}`);
    addCheck(report, "namespace", "ok", `Namespace is ${this.config.namespace}`);
    addCheck(report, "task_queue", "ok", `Task queue is ${this.config.taskQueue}`);

    if (!status.cliPath) {
      addCheck(
        report,
        "temporal_cli",
        this.config.mode === "managed-local" ? "fail" : "warn",
        this.config.mode === "managed-local"
          ? "temporal CLI is required for managed-local start"
          : "temporal CLI is not installed; status can still inspect ports"
      );
    } else {
      addCheck(report, "temporal_cli", "ok", `Found temporal CLI at ${status.cliPath}`);
    }

    let managedLocalRunning = false;

    if (this.config.mode === "external") {
      addCheck(
        report,
        "api_port",
        status.portOpen ? "ok" : "fail",
        status.portOpen
          ? `External Temporal API is reachable at ${this.config.address}`
          : `External Temporal API is not reachable: ${status.message ?? "unknown error"}`
      );
    } else if (!status.portOpen) {
      addCheck(report, "api_port", "ok", `Managed-local Temporal API port is free at ${this.config.address}`);
    } else if (status.pid && (await this.managedTemporalPID(status.pid))) {
      managedLocalRunning = true;
      addCheck(report, "api_port", "ok", `Tychonic-managed Temporal appears reachable with pid ${status.pid}`);
    } else if (status.pid) {
      addCheck(report, "pid_file", "warn", `PID file exists but process ${status.pid} is not a live Temporal process`);
      addCheck(report, "api_port", "warn", "Temporal API port is open but managed PID is stale or not Temporal");
    } else {
      addCheck(report, "api_port", "fail", `Temporal API port is occupied by an unmanaged process at ${this.config.address}`);
    }

    if (this.config.mode === "managed-local" && !managedLocalRunning) {
      const startSideAddress = managedDevUiAddress(this.config);
      if (await this.portOpen(startSideAddress)) {
        addCheck(
          report,
          "start_dev_side_port",
          "fail",
          `Managed-local Temporal start-dev side port is occupied at ${startSideAddress}; choose a different --temporal-port or use external mode`
        );
      }
    }

    if (this.config.mode === "managed-local") {
      for (const [name, path] of [
        ["db_path", this.config.dbFilename],
        ["log_path", this.config.logFile],
        ["pid_path", this.config.pidFile]
      ] as const) {
        try {
          await ensureParentWritable(path);
          addCheck(report, name, "ok", `${dirname(path)} is writable`);
        } catch (error) {
          addCheck(report, name, "fail", `${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    report.overall = recomputeOverall(report);
    return report;
  }

  async stop(): Promise<TemporalStopStatus> {
    const base = {
      mode: this.config.mode,
      address: this.config.address,
      namespace: this.config.namespace,
      taskQueue: this.config.taskQueue,
      pidFile: this.config.pidFile,
      pidFileRemoved: false
    };

    if (this.config.mode !== "managed-local") {
      return {
        ...base,
        ok: false,
        state: "unsupported_mode",
        message: "Temporal stop only manages Tychonic managed-local Temporal processes"
      };
    }

    const pid = await readPID(this.config.pidFile);
    if (pid <= 0) {
      return {
        ...base,
        ok: true,
        state: "not_running",
        message: `No managed Temporal PID file found at ${this.config.pidFile}`
      };
    }

    if (!(await this.managedTemporalPID(pid))) {
      if (!(await this.deps.processAlive(pid))) {
        await rm(this.config.pidFile, { force: true });
        return {
          ...base,
          ok: true,
          state: "not_running",
          pid,
          pidFileRemoved: true,
          message: `Managed Temporal PID ${pid} is not running; removed ${this.config.pidFile}`
        };
      }

      return {
        ...base,
        ok: false,
        state: "refused",
        pid,
        message: `PID file ${this.config.pidFile} points to live process ${pid}, but it is not a Temporal process`
      };
    }

    try {
      await this.deps.signalProcess(pid, "SIGTERM");
    } catch (error) {
      if (await this.deps.processAlive(pid)) {
        return {
          ...base,
          ok: false,
          state: "signal_failed",
          pid,
          message: `Failed to send SIGTERM to managed Temporal process ${pid}: ${
            error instanceof Error ? error.message : String(error)
          }`
        };
      }
    }

    if (!(await this.waitForExit(pid))) {
      return {
        ...base,
        ok: false,
        state: "timeout",
        pid,
        message: `Sent SIGTERM to managed Temporal process ${pid}, but it is still running`
      };
    }

    await rm(this.config.pidFile, { force: true });
    return {
      ...base,
      ok: true,
      state: "stopped",
      pid,
      pidFileRemoved: true,
      message: `Stopped Tychonic-managed Temporal process ${pid}`
    };
  }

  async start(opts: TemporalStartOptions = {}): Promise<TemporalStatus> {
    const status = await this.status();
    if (this.config.mode === "external") {
      if (status.portOpen) {
        return status;
      }
      throw new Error("external Temporal is not reachable");
    }

    if (status.portOpen) {
      if (status.pid && (await this.managedTemporalPID(status.pid))) {
        return { ...status, message: "Tychonic-managed Temporal appears to be running" };
      }
      if (status.pid) {
        throw new Error(
          `Temporal API port ${this.config.address} is open, but PID file ${this.config.pidFile} does not point to a live Temporal process`
        );
      }
      throw new Error(
        `Temporal API port ${this.config.address} is already occupied; use external mode`
      );
    }

    const startSideAddress = managedDevUiAddress(this.config);
    if (await this.portOpen(startSideAddress)) {
      throw new Error(
        `managed-local Temporal start-dev side port ${startSideAddress} is already occupied; choose a different --temporal-port or use external mode`
      );
    }

    const cli = await this.deps.lookup("temporal");
    if (!cli) {
      throw new Error("temporal CLI is not installed; install it or use external mode");
    }
    const pid = await this.deps.start(this.config, cli, opts);
    return {
      ...status,
      cliPath: cli,
      pid,
      health: "starting",
      message: "Tychonic-managed Temporal start requested"
    };
  }

  private async managedTemporalPID(pid: number): Promise<boolean> {
    if (!(await this.deps.processAlive(pid))) {
      return false;
    }
    try {
      return isTemporalStartDevCommand(await this.deps.processCommand(pid));
    } catch {
      return false;
    }
  }

  private async managedTemporalPIDForPort(port: number): Promise<number | undefined> {
    const pids = await this.deps.portListeningPids(port);
    for (const pid of pids) {
      if (await this.managedTemporalPID(pid)) {
        return pid;
      }
    }
    return undefined;
  }

  private async waitForExit(pid: number): Promise<boolean> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!(await this.deps.processAlive(pid))) {
        return true;
      }
      await this.deps.sleep(100);
    }
    return !(await this.deps.processAlive(pid));
  }

  private async portOpen(address: string): Promise<boolean> {
    try {
      await this.deps.dial(address);
      return true;
    } catch {
      return false;
    }
  }
}

export function normalizeTemporalConfig(config: TemporalConfig): NormalizedTemporalConfig {
  const mode = config.mode ?? "managed-local";
  if (!temporalModes.includes(mode)) {
    throw new Error(`unsupported temporal mode ${mode}`);
  }
  const host = config.host ?? "127.0.0.1";
  const dirs = tychonicRuntimeDirs();

  // Delegate instance-aware derivation of address / apiPort / devUiPort /
  // taskQueue to `resolveInstanceRuntime`. This keeps the field-level
  // explicit-override precedence (§9) in exactly one place. When no
  // instance is active, the resolver reproduces the historical defaults
  // (7233 / 8233 / 127.0.0.1:7233 / tychonic), so behavior is
  // byte-identical to the pre-instance code path.
  const instance = getActiveInstance();
  const explicit: ResolveInstanceRuntimeExplicit = {};
  if (config.address !== undefined) explicit.address = config.address;
  if (config.apiPort !== undefined) explicit.apiPort = config.apiPort;
  if (config.devUiPort !== undefined) explicit.devUiPort = config.devUiPort;
  if (config.namespace !== undefined) explicit.namespace = config.namespace;
  if (config.taskQueue !== undefined) explicit.taskQueue = config.taskQueue;
  const resolvedOptions: ResolveInstanceRuntimeOptions = {
    defaultStateDir: dirs.stateDir,
    defaultLogDir: dirs.logDir,
    explicit
  };
  if (instance !== undefined) resolvedOptions.instance = instance;
  const resolved = resolveInstanceRuntime(resolvedOptions);

  return {
    mode,
    host,
    apiPort: resolved.temporal.apiPort,
    devUiPort: resolved.temporal.devUiPort,
    address: resolved.temporal.address,
    namespace: resolved.temporal.namespace,
    taskQueue: resolved.temporal.taskQueue,
    dbFilename: mode === "managed-local" ? config.dbFilename ?? join(dirs.stateDir, "temporal", "temporal.db") : "",
    logFile: mode === "managed-local" ? config.logFile ?? join(dirs.logDir, "temporal.log") : "",
    pidFile: mode === "managed-local" ? config.pidFile ?? join(dirs.stateDir, "temporal", "temporal.pid") : ""
  };
}

/**
 * Tracks which `$TYCHONIC_*_HOME overrides instance …` warnings have
 * already been emitted this process. Without dedupe the warning would
 * fire every time `tychonicRuntimeDirs()` is called (many times per
 * CLI invocation).
 */
const emittedRuntimeDirWarnings = new Set<string>();

export function tychonicRuntimeDirs(env: NodeJS.ProcessEnv = process.env): { stateDir: string; logDir: string } {
  const home = homedir();
  const defaultStateDir =
    platform() === "darwin"
      ? join(home, "Library", "Application Support", "Tychonic")
      : join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "tychonic");
  const defaultLogDir =
    platform() === "darwin" ? join(home, "Library", "Logs", "Tychonic") : join(defaultStateDir, "logs");

  const instance = getActiveInstance();

  // No active instance: preserve the historical byte-identical behavior
  // (explicit env wins, otherwise default per-platform baseline).
  if (instance === undefined) {
    const stateDir = env.TYCHONIC_STATE_HOME ?? defaultStateDir;
    const logDir =
      env.TYCHONIC_LOG_HOME ??
      (platform() === "darwin" ? join(home, "Library", "Logs", "Tychonic") : join(stateDir, "logs"));
    return { stateDir, logDir };
  }

  // Active instance: delegate to the shared resolver so the
  // explicit > instance-derived > default precedence lives in one place.
  // The resolver also collects warnings when env overrides defeat the
  // instance-derived suffix — surface each unique warning once on stderr.
  const explicit: ResolveInstanceRuntimeExplicit = {};
  if (env.TYCHONIC_STATE_HOME !== undefined) explicit.stateHome = env.TYCHONIC_STATE_HOME;
  if (env.TYCHONIC_LOG_HOME !== undefined) explicit.logHome = env.TYCHONIC_LOG_HOME;
  const resolved = resolveInstanceRuntime({
    instance,
    defaultStateDir,
    defaultLogDir,
    explicit
  });
  for (const warning of resolved.warnings) {
    if (!emittedRuntimeDirWarnings.has(warning)) {
      emittedRuntimeDirWarnings.add(warning);
      process.stderr.write(`tychonic: ${warning}\n`);
    }
  }
  return { stateDir: resolved.stateDir, logDir: resolved.logDir };
}

/**
 * Test-only: reset the dedupe set for `tychonicRuntimeDirs` warnings.
 * Production callers never need this.
 */
export function __resetRuntimeDirWarningsForTest(): void {
  emittedRuntimeDirWarnings.clear();
}

export function temporalStartArgs(config: NormalizedTemporalConfig): string[] {
  return [
    "server",
    "start-dev",
    "--ip",
    config.host,
    "--port",
    String(config.apiPort),
    "--ui-port",
    String(config.devUiPort),
    "--namespace",
    config.namespace,
    "--db-filename",
    config.dbFilename
  ];
}

async function startTemporal(
  config: NormalizedTemporalConfig,
  cli: string,
  opts: TemporalStartOptions = {}
): Promise<number> {
  for (const path of [config.dbFilename, config.logFile, config.pidFile]) {
    if (path) {
      await mkdir(dirname(path), { recursive: true });
    }
  }
  const logFd = openSync(config.logFile, "a");
  // `detached: true` makes the child its own process-group/session leader
  // (POSIX `setsid`). Standalone `tychonic temporal start` wants that —
  // the daemon must outlive the CLI invocation. The runtime-parent path
  // (`runtime up`) wants the opposite: the temporal child must inherit
  // the parent's pgid so `runtime reset`'s `kill(-pgid)` cascade reaches
  // it. Callers signal that via `inheritProcessGroup: true`.
  const detached = opts.inheritProcessGroup !== true;
  const child = spawn(cli, temporalStartArgs(config), {
    detached,
    stdio: ["ignore", logFd, logFd]
  });
  closeSync(logFd);
  // unref() lets the parent event loop drain even when the child is in
  // the same process group. The pgid relationship is independent of
  // libuv's child-handle reference.
  child.unref();
  const pid = child.pid;
  if (!pid) {
    throw new Error("failed to start Temporal process");
  }
  await writeFile(config.pidFile, `${pid}\n`, "utf8");
  return pid;
}

async function dialTCP(address: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const [host, portText] = splitHostPort(address);
    const socket = createConnection({ host, port: Number(portText), timeout: 500 }, () => {
      socket.end();
      resolve();
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("connection timed out"));
    });
    socket.on("error", reject);
  });
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function processCommand(pid: number): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return stdout.trim();
}

async function portListeningPids(port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp", "-a"], {
      encoding: "utf8"
    });
    const pids = new Set<number>();
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.startsWith("p")) {
        continue;
      }
      const pid = Number(line.slice(1));
      if (Number.isInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }
    return [...pids];
  } catch {
    return [];
  }
}

function isTemporalStartDevCommand(command: string): boolean {
  const tokens = splitCommandLine(command);
  if (tokens.length < 3) {
    return false;
  }
  return basename(tokens[0] ?? "") === "temporal" && tokens[1] === "server" && tokens[2] === "start-dev";
}

function splitCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        token += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += char;
  }

  if (token) {
    tokens.push(token);
  }
  return tokens;
}

async function signalProcess(pid: number, signal: NodeJS.Signals): Promise<void> {
  process.kill(pid, signal);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readPID(path: string): Promise<number> {
  if (!path) {
    return 0;
  }
  try {
    const raw = await readFile(path, "utf8");
    const pid = Number(raw.trim());
    return Number.isInteger(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

async function ensureParentWritable(path: string): Promise<void> {
  if (!path) {
    throw new Error("path is empty");
  }
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const probe = join(dir, `.tychonic-write-check-${process.pid}-${Date.now()}`);
  await writeFile(probe, "", "utf8");
  await rm(probe);
}

function splitHostPort(address: string): [string, string] {
  const index = address.lastIndexOf(":");
  if (index < 0) {
    throw new Error(`invalid address: ${address}`);
  }
  return [address.slice(0, index), address.slice(index + 1)];
}

function managedDevUiAddress(config: NormalizedTemporalConfig): string {
  return `${config.host}:${config.devUiPort}`;
}

function addCheck(
  report: TemporalDoctorReport,
  name: string,
  status: "ok" | "warn" | "fail",
  detail: string
): void {
  report.checks.push({ name, status, detail });
}

function recomputeOverall(report: TemporalDoctorReport): "ok" | "warn" | "fail" {
  if (report.checks.some((check) => check.status === "fail")) {
    return "fail";
  }
  if (report.checks.some((check) => check.status === "warn")) {
    return "warn";
  }
  return "ok";
}
