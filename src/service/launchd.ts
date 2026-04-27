import { execFile } from "node:child_process";
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { assertLoopbackHost } from "../net/loopback.js";
import { getActiveInstance } from "../runtime/instance.js";
import { buildExecutablePathValue, findExecutable, TYCHONIC_AGENT_PATH_ENV } from "../system/executables.js";
import { normalizeTemporalConfig, temporalStartArgs, tychonicRuntimeDirs } from "../temporal/manager.js";

const execFileAsync = promisify(execFile);

/**
 * Second-line defense: any launchd-touching export must refuse to run when
 * an isolated dev instance is active. The CLI layer already gates these
 * paths (§5 of dev-instance-design); this assertion protects against a
 * missed gate or a new caller path.
 */
function assertNoActiveInstance(fnLabel: string): void {
  const active = getActiveInstance();
  if (active !== undefined) {
    throw new Error(
      `${fnLabel}: launchd services are operational-only; instance='${active}' must not touch 'com.tychonic.*' labels`
    );
  }
}

export const serviceNames = ["temporal", "worker", "web"] as const;
export type TychonicServiceName = (typeof serviceNames)[number];

export interface LaunchdServiceInstallOptions {
  projectDir: string;
  webHost?: string;
  webPort?: number;
  temporalPort?: number;
  nodePath?: string;
  cliPath?: string;
  temporalCliPath?: string;
  workerShutdownGraceTime?: string;
  allowSourceCli?: boolean;
  allowNetworkBind?: boolean;
  load?: boolean;
  launchAgentDir?: string;
}

export interface LaunchdServiceInstallResult {
  stateDir: string;
  logDir: string;
  projectDir: string;
  cliPath: string;
  nodePath: string;
  temporalCliPath: string;
  plists: Record<TychonicServiceName, string>;
  loaded: boolean;
}

export interface LaunchdServiceStatus {
  name: TychonicServiceName;
  label: string;
  plistPath: string;
  loaded: boolean;
  state?: string;
  pid?: number;
  lastExitCode?: number;
}

export interface LaunchdServiceUninstallResult {
  removed: Record<TychonicServiceName, boolean>;
}

export interface LaunchdServiceRestartResult {
  name: TychonicServiceName;
  label: string;
  signal: "SIGTERM";
  restartedBy: "launchd-keepalive";
  message: string;
}

export interface LaunchdWorkerReplacementOptions {
  timeoutMs?: number;
  launchAgentDir?: string;
}

export interface LaunchdWorkerReplacementResult {
  name: "worker";
  label: string;
  oldPid: number;
  temporaryLabel: string;
  temporaryPid: number;
  replacementPid: number;
  message: string;
}

export async function installLaunchdServices(
  options: LaunchdServiceInstallOptions
): Promise<LaunchdServiceInstallResult> {
  assertNoActiveInstance("installLaunchdServices");
  assertMacOSLaunchd();
  assertLoopbackHost(options.webHost ?? "127.0.0.1", options.allowNetworkBind === true);
  const stateDir = tychonicRuntimeDirs().stateDir;
  const logDir = tychonicRuntimeDirs().logDir;
  const launchAgentDir = options.launchAgentDir ?? defaultLaunchAgentDir();
  const nodePath = await resolveExecutable(options.nodePath ?? process.execPath, "node");
  const cliPath = await resolveCliPath(options.cliPath ?? process.argv[1], options.allowSourceCli === true);
  const temporalCliPath = await resolveExecutable(options.temporalCliPath, "temporal");
  const projectDir = resolve(options.projectDir);

  await mkdir(launchAgentDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const definitions = serviceDefinitions({
    stateDir,
    logDir,
    projectDir,
    nodePath,
    cliPath,
    temporalCliPath,
    ...(options.workerShutdownGraceTime ? { workerShutdownGraceTime: options.workerShutdownGraceTime } : {}),
    webHost: options.webHost ?? "127.0.0.1",
    webPort: options.webPort ?? 8765,
    ...(options.temporalPort !== undefined ? { temporalPort: options.temporalPort } : {}),
    allowNetworkBind: options.allowNetworkBind === true
  });
  const plists = {} as Record<TychonicServiceName, string>;
  for (const service of serviceNames) {
    const plistPath = join(launchAgentDir, `${definitions[service].label}.plist`);
    await writeFile(plistPath, renderPlist(definitions[service]), "utf8");
    plists[service] = plistPath;
  }

  if (options.load !== false) {
    for (const service of serviceNames) {
      await bootout(definitions[service].label);
    }
    for (const service of serviceNames) {
      await bootstrap(plists[service]);
    }
  }

  return { stateDir, logDir, projectDir, cliPath, nodePath, temporalCliPath, plists, loaded: options.load !== false };
}

export async function statusLaunchdServices(): Promise<LaunchdServiceStatus[]> {
  assertNoActiveInstance("statusLaunchdServices");
  assertMacOSLaunchd();
  const launchAgentDir = defaultLaunchAgentDir();
  const result: LaunchdServiceStatus[] = [];
  for (const service of serviceNames) {
    const label = serviceLabel(service);
    const plistPath = join(launchAgentDir, `${label}.plist`);
    try {
      const { stdout } = await launchctl(["print", `${launchctlDomain()}/${label}`]);
      result.push({ name: service, label, plistPath, loaded: true, ...parseLaunchctlPrint(stdout) });
    } catch {
      result.push({ name: service, label, plistPath, loaded: false });
    }
  }
  return result;
}

export async function uninstallLaunchdServices(): Promise<LaunchdServiceUninstallResult> {
  assertNoActiveInstance("uninstallLaunchdServices");
  assertMacOSLaunchd();
  const launchAgentDir = defaultLaunchAgentDir();
  const removed = {} as Record<TychonicServiceName, boolean>;
  for (const service of serviceNames) {
    await bootout(serviceLabel(service));
    const plistPath = join(launchAgentDir, `${serviceLabel(service)}.plist`);
    await rm(plistPath, { force: true });
    removed[service] = true;
  }
  return { removed };
}

export async function restartLaunchdService(service: TychonicServiceName): Promise<LaunchdServiceRestartResult> {
  assertNoActiveInstance("restartLaunchdService");
  assertMacOSLaunchd();
  if (!serviceNames.includes(service)) {
    throw new Error(`unsupported Tychonic service ${service}`);
  }
  const label = serviceLabel(service);
  await launchctl(["kill", "SIGTERM", `${launchctlDomain()}/${label}`]);
  return {
    name: service,
    label,
    signal: "SIGTERM",
    restartedBy: "launchd-keepalive",
    message: "Sent SIGTERM; the worker drains in-flight activity work before launchd starts a new process."
  };
}

export async function replaceLaunchdWorker(options: LaunchdWorkerReplacementOptions = {}): Promise<LaunchdWorkerReplacementResult> {
  assertNoActiveInstance("replaceLaunchdWorker");
  assertMacOSLaunchd();
  // The replacement wait is slightly longer than the default worker drain window.
  const timeoutMs = options.timeoutMs ?? 25 * 60 * 60 * 1000;
  const launchAgentDir = options.launchAgentDir ?? defaultLaunchAgentDir();
  const label = serviceLabel("worker");
  const plistPath = join(launchAgentDir, `${label}.plist`);
  const before = await launchdServiceStatus(label, plistPath);
  if (!before.loaded || !before.pid) {
    throw new Error("Tychonic worker LaunchAgent is not running; install or start the service before replacement");
  }

  const suffix = `${Date.now()}.${process.pid}`;
  const temporaryLabel = `${label}.replacement.${suffix}`;
  const temporaryPlistPath = join(launchAgentDir, `${temporaryLabel}.plist`);
  const basePlist = await readFile(plistPath, "utf8");
  const temporaryPlist = makeTemporaryWorkerPlist(basePlist, temporaryLabel, suffix);
  await writeFile(temporaryPlistPath, temporaryPlist, "utf8");

  let temporaryPid = 0;
  try {
    await bootstrap(temporaryPlistPath);
    temporaryPid = await waitForLaunchdPID(temporaryLabel, undefined, timeoutMs, launchAgentDir);
    await launchctl(["kill", "SIGTERM", `${launchctlDomain()}/${label}`]);
    const replacementPid = await waitForLaunchdPID(label, before.pid, timeoutMs, launchAgentDir);
    await retireTemporaryWorker(temporaryLabel, temporaryPlistPath, timeoutMs, launchAgentDir);
    return {
      name: "worker",
      label,
      oldPid: before.pid,
      temporaryLabel,
      temporaryPid,
      replacementPid,
      message:
        "Started a temporary replacement worker before retiring the old worker; the old worker drained before launchd started the new main worker."
    };
  } catch (error) {
    if (temporaryPid > 0) {
      await retireTemporaryWorker(temporaryLabel, temporaryPlistPath, timeoutMs, launchAgentDir);
    } else {
      await bootout(temporaryLabel);
      await rm(temporaryPlistPath, { force: true });
    }
    throw error;
  }
}

interface ServiceDefinition {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  environmentVariables: Record<string, string>;
}

interface ServiceDefinitionInput {
  stateDir: string;
  logDir: string;
  projectDir: string;
  nodePath: string;
  cliPath: string;
  temporalCliPath: string;
  workerShutdownGraceTime?: string;
  webHost: string;
  webPort: number;
  temporalPort?: number;
  allowNetworkBind: boolean;
}

function serviceDefinitions(input: ServiceDefinitionInput): Record<TychonicServiceName, ServiceDefinition> {
  const temporalConfig = normalizeTemporalConfig({
    ...(input.temporalPort !== undefined ? { apiPort: input.temporalPort } : {})
  });
  const temporalArgs = temporalStartArgs(temporalConfig);
  const environmentVariables = serviceEnvironmentVariables();
  return {
    temporal: {
      label: serviceLabel("temporal"),
      programArguments: [input.temporalCliPath, ...temporalArgs],
      workingDirectory: input.stateDir,
      stdoutPath: join(input.logDir, "temporal.out.log"),
      stderrPath: join(input.logDir, "temporal.err.log"),
      environmentVariables
    },
    worker: {
      label: serviceLabel("worker"),
      programArguments: [
        input.nodePath,
        input.cliPath,
        "temporal",
        "worker",
        "--temporal-mode",
        "managed-local",
        ...(input.temporalPort !== undefined ? ["--temporal-port", String(input.temporalPort)] : []),
        ...(input.workerShutdownGraceTime ? ["--shutdown-grace-time", input.workerShutdownGraceTime] : [])
      ],
      workingDirectory: input.stateDir,
      stdoutPath: join(input.logDir, "worker.out.log"),
      stderrPath: join(input.logDir, "worker.err.log"),
      environmentVariables
    },
    web: {
      label: serviceLabel("web"),
      programArguments: [
        input.nodePath,
        input.cliPath,
        "web",
        "--temporal-mode",
        "managed-local",
        ...(input.temporalPort !== undefined ? ["--temporal-port", String(input.temporalPort)] : []),
        "--host",
        input.webHost,
        "--port",
        String(input.webPort),
        ...(input.allowNetworkBind ? ["--allow-network-bind"] : []),
        "--project-dir",
        input.projectDir
      ],
      workingDirectory: input.stateDir,
      stdoutPath: join(input.logDir, "web.out.log"),
      stderrPath: join(input.logDir, "web.err.log"),
      environmentVariables
    }
  };
}

function renderPlist(definition: ServiceDefinition): string {
  const environmentEntries = Object.entries(definition.environmentVariables)
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(definition.label)}</string>
  <key>ProgramArguments</key>
  <array>
${definition.programArguments.map((arg) => `    <string>${escapeXml(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(definition.workingDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(definition.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(definition.stderrPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentEntries}
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

function makeTemporaryWorkerPlist(basePlist: string, label: string, suffix: string): string {
  return replacePlistStringKey(
    replaceKeepAliveFalse(
      basePlist
        .replace(/worker\.out\.log/g, `worker.replacement.${suffix}.out.log`)
        .replace(/worker\.err\.log/g, `worker.replacement.${suffix}.err.log`)
    ),
    "Label",
    label
  );
}

function replacePlistStringKey(plist: string, key: string, value: string): string {
  const pattern = new RegExp(`(<key>${escapeRegExp(key)}</key>\\s*<string>)([^<]*)(</string>)`);
  if (!pattern.test(plist)) {
    throw new Error(`LaunchAgent plist is missing ${key}`);
  }
  return plist.replace(pattern, `$1${escapeXml(value)}$3`);
}

function replaceKeepAliveFalse(plist: string): string {
  return plist.replace(/<key>KeepAlive<\/key>\s*<true\/>/, "<key>KeepAlive</key>\n  <false/>");
}

function serviceEnvironmentVariables(): Record<string, string> {
  return {
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env[TYCHONIC_AGENT_PATH_ENV] ? { [TYCHONIC_AGENT_PATH_ENV]: process.env[TYCHONIC_AGENT_PATH_ENV] } : {}),
    PATH: serviceSearchPath(process.env.HOME)
  };
}

function serviceSearchPath(home: string | undefined): string {
  return buildExecutablePathValue({
    ...(home ? { HOME: home } : {}),
    ...(process.env[TYCHONIC_AGENT_PATH_ENV] ? { [TYCHONIC_AGENT_PATH_ENV]: process.env[TYCHONIC_AGENT_PATH_ENV] } : {}),
    PATH: ""
  });
}

async function launchdServiceStatus(label: string, plistPath: string): Promise<LaunchdServiceStatus> {
  try {
    const { stdout } = await launchctl(["print", `${launchctlDomain()}/${label}`]);
    return { name: serviceNameFromLabel(label), label, plistPath, loaded: true, ...parseLaunchctlPrint(stdout) };
  } catch {
    return { name: serviceNameFromLabel(label), label, plistPath, loaded: false };
  }
}

function serviceNameFromLabel(label: string): TychonicServiceName {
  const name = label.slice("com.tychonic.".length).split(".")[0];
  if (serviceNames.includes(name as TychonicServiceName)) {
    return name as TychonicServiceName;
  }
  throw new Error(`unsupported Tychonic service label ${label}`);
}

async function waitForLaunchdPID(
  label: string,
  previousPid: number | undefined,
  timeoutMs: number,
  launchAgentDir: string
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const plistPath = join(launchAgentDir, `${label}.plist`);
    const status = await launchdServiceStatus(label, plistPath);
    if (status.pid && status.pid !== previousPid) {
      return status.pid;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label} to start`);
}

async function retireTemporaryWorker(
  label: string,
  plistPath: string,
  timeoutMs: number,
  launchAgentDir: string
): Promise<void> {
  try {
    await launchctl(["kill", "SIGTERM", `${launchctlDomain()}/${label}`]);
    await waitForLaunchdExit(label, timeoutMs, launchAgentDir);
  } finally {
    await bootout(label);
    await rm(plistPath, { force: true });
  }
}

async function waitForLaunchdExit(label: string, timeoutMs: number, launchAgentDir: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const plistPath = join(launchAgentDir, `${label}.plist`);
    const status = await launchdServiceStatus(label, plistPath);
    if (!status.pid) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label} to stop`);
}

async function resolveCliPath(path: string | undefined, allowSourceCli: boolean): Promise<string> {
  if (!path) {
    throw new Error("cannot resolve current Tychonic CLI path");
  }
  const resolved = await realpath(path);
  if (!allowSourceCli && (await isSourceCheckoutCli(resolved))) {
    throw new Error(
      `refusing to install launchd services from source checkout CLI ${resolved}; install the package first or pass --allow-source-cli for development only`
    );
  }
  return resolved;
}

async function isSourceCheckoutCli(cliPath: string): Promise<boolean> {
  let dir = dirname(cliPath);
  while (dir !== dirname(dir)) {
    try {
      const packageJson = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as { name?: string };
      if (packageJson.name === "tychonic") {
        return (await exists(join(dir, "src", "cli", "main.ts"))) && (await exists(join(dir, "tsconfig.json")));
      }
    } catch {
      // Keep walking toward the filesystem root.
    }
    dir = dirname(dir);
  }
  return false;
}

async function resolveExecutable(path: string | undefined, name: string): Promise<string> {
  if (path) {
    return realpath(path);
  }
  const resolved = await findExecutable(name, process.env);
  if (resolved) {
    return realpath(resolved);
  }
  throw new Error(`${name} executable was not found`);
}

function serviceLabel(service: TychonicServiceName): string {
  return `com.tychonic.${service}`;
}

function assertMacOSLaunchd(): void {
  if (platform() !== "darwin") {
    throw new Error("Tychonic service management uses macOS launchd and is only supported on macOS");
  }
}

function defaultLaunchAgentDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

async function bootout(label: string): Promise<void> {
  try {
    await launchctl(["bootout", `${launchctlDomain()}/${label}`]);
  } catch {
    // launchctl returns an error when the service is not loaded.
  }
}

async function bootstrap(plistPath: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await launchctl(["bootstrap", launchctlDomain(), plistPath]);
      return;
    } catch (error) {
      lastError = error;
      await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

async function launchctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("launchctl", args, { encoding: "utf8" });
}

function launchctlDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLaunchctlPrint(stdout: string): Pick<LaunchdServiceStatus, "state" | "pid" | "lastExitCode"> {
  const state = stdout.match(/^\s*state = (.+)$/m)?.[1];
  const pidText = stdout.match(/^\s*pid = ([0-9]+)$/m)?.[1];
  const lastExitText = stdout.match(/^\s*last exit code = ([0-9]+)$/m)?.[1];
  return {
    ...(state ? { state } : {}),
    ...(pidText ? { pid: Number(pidText) } : {}),
    ...(lastExitText ? { lastExitCode: Number(lastExitText) } : {})
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
