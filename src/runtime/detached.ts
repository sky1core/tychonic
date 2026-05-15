/**
 * Detached runtime spawner for `tychonic runtime up`.
 *
 * The parent process invokes `spawnDetachedRuntime` once and exits 0
 * immediately. The child is an independent session (`setsid` via node's
 * `{ detached: true }` + `child.unref()`) whose stdout/stderr are appended
 * to `runtime.log` and whose pid is written to `runtime.pid`.
 *
 * This module is a pure spawn utility — it does not consult active-instance
 * state. The CLI layer decides whether to pass an instance flag.
 *
 * Contract (§2 no magic): if a live pid already occupies `pidFile`, the
 * caller must refuse. This function overwrites `pidFile` unconditionally;
 * stale-pid detection happens above it in the CLI action.
 */

import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SpawnDetachedRuntimeOptions {
  /** Absolute path to the node executable used to run the CLI. */
  nodePath: string;
  /** Absolute path to the Tychonic CLI entry (e.g. `.../dist/cli/main.js`). */
  cliPath: string;
  /** Optional isolated instance name to pass through to the child. */
  instance?: string;
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
   * Optional environment. `TYCHONIC_INSTANCE` is not injected here; when an
   * instance is active, the child receives `--instance` on argv, which wins
   * over env per §3.
   */
  env?: NodeJS.ProcessEnv;
}

export interface SpawnDetachedRuntimeResult {
  pid: number;
  logFile: string;
  pidFile: string;
}

/**
 * Spawn `tychonic [--instance <name>] runtime up --foreground <extraArgs...>`
 * as a detached foreground runtime. Returns when the child has been spawned
 * and its pid written. Does not wait for Temporal readiness — that is a caller
 * concern.
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
    const childArgs = [
      cliPath,
      ...(instance ? ["--instance", instance] : []),
      "runtime",
      "up",
      "--foreground",
      ...extraArgs
    ];
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
    await writeRuntimePidFile(pidFile, pid, { instance: instance ?? null, cliPath });
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

export interface RuntimePidIdentity {
  instance: string | null;
  cliPath?: string;
  pidFile?: string;
}

export interface RuntimePidMetadata {
  kind: "tychonic.runtime";
  pid: number;
  instance: string | null;
  cliPath: string;
}

interface RuntimeStartLockRecord {
  kind: "tychonic.runtime.startLock";
  pid: number;
  cliPath: string;
  processStartStamp: string;
}

interface RuntimeStartRecoveryLockRecord {
  kind: "tychonic.runtime.startRecoveryLock";
  pid: number;
  cliPath: string;
  processStartStamp: string;
}

export interface RuntimeStartLock {
  lockFile: string;
  release: () => Promise<void>;
}

function runtimePidMetadataFile(pidFile: string): string {
  return `${pidFile}.json`;
}

export async function claimRuntimeStartLock(lockFile: string): Promise<RuntimeStartLock> {
  await mkdir(dirname(lockFile), { recursive: true });
  const record = await currentRuntimeStartLockRecord();

  try {
    await symlink(JSON.stringify(record), lockFile);
    return {
      lockFile,
      release: async () => {
        await removeRuntimeStartLockIfOwned(lockFile, process.pid);
      }
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw error;
    }
  }

  const existing = await readRuntimeStartLock(lockFile);
  if (existing && (await isRuntimeStartLockOwnerActive(existing))) {
    throw new Error(`runtime start is already in progress (${lockFile}, pid ${existing.pid})`);
  }

  await recoverRuntimeStartLock(lockFile);
  return claimRuntimeStartLock(lockFile);
}

async function readRuntimeStartLock(lockFile: string): Promise<RuntimeStartLockRecord | undefined> {
  try {
    const target = await readlink(lockFile);
    try {
      const parsed = JSON.parse(target) as Partial<RuntimeStartLockRecord>;
      if (
        parsed.kind === "tychonic.runtime.startLock" &&
        typeof parsed.pid === "number" &&
        Number.isInteger(parsed.pid) &&
        parsed.pid > 0 &&
        typeof parsed.cliPath === "string" &&
        typeof parsed.processStartStamp === "string" &&
        parsed.processStartStamp.length > 0
      ) {
        return {
          kind: "tychonic.runtime.startLock",
          pid: parsed.pid,
          cliPath: parsed.cliPath,
          processStartStamp: parsed.processStartStamp
        };
      }
    } catch {
      return undefined;
    }
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EINVAL") return undefined;
    return undefined;
  }
}

async function recoverRuntimeStartLock(lockFile: string): Promise<void> {
  const recoveryFile = `${lockFile}.recover`;
  const recovery = await claimRuntimeStartRecoveryLock(recoveryFile);
  try {
    const current = await readRuntimeStartLock(lockFile);
    if (current && (await isRuntimeStartLockOwnerActive(current))) {
      throw new Error(`runtime start is already in progress (${lockFile}, pid ${current.pid})`);
    }
    await rm(lockFile, { force: true });
  } finally {
    await recovery.release();
  }
}

async function claimRuntimeStartRecoveryLock(lockFile: string): Promise<RuntimeStartLock> {
  const record = await currentRuntimeStartRecoveryLockRecord();
  try {
    await symlink(JSON.stringify(record), lockFile);
    return {
      lockFile,
      release: async () => {
        await removeRuntimeStartRecoveryLockIfOwned(lockFile, process.pid, record.processStartStamp);
      }
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw error;
    }
  }

  const existing = await readRuntimeStartRecoveryLock(lockFile);
  if (existing && (await isRuntimeStartLockOwnerActive(existing))) {
    throw new Error(`runtime start lock recovery is already in progress (${lockFile}, pid ${existing.pid})`);
  }

  await rm(lockFile, { force: true });
  return claimRuntimeStartRecoveryLock(lockFile);
}

async function currentRuntimeStartLockRecord(): Promise<RuntimeStartLockRecord> {
  return {
    kind: "tychonic.runtime.startLock",
    pid: process.pid,
    cliPath: process.argv[1] ?? "",
    processStartStamp: await processStartStamp(process.pid)
  };
}

async function currentRuntimeStartRecoveryLockRecord(): Promise<RuntimeStartRecoveryLockRecord> {
  return {
    kind: "tychonic.runtime.startRecoveryLock",
    pid: process.pid,
    cliPath: process.argv[1] ?? "",
    processStartStamp: await processStartStamp(process.pid)
  };
}

async function readRuntimeStartRecoveryLock(
  lockFile: string
): Promise<RuntimeStartRecoveryLockRecord | undefined> {
  try {
    const target = await readlink(lockFile);
    const parsed = JSON.parse(target) as Partial<RuntimeStartRecoveryLockRecord>;
    if (
      parsed.kind === "tychonic.runtime.startRecoveryLock" &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.cliPath === "string" &&
      typeof parsed.processStartStamp === "string" &&
      parsed.processStartStamp.length > 0
    ) {
      return {
        kind: "tychonic.runtime.startRecoveryLock",
        pid: parsed.pid,
        cliPath: parsed.cliPath,
        processStartStamp: parsed.processStartStamp
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function isRuntimeStartLockOwnerActive(
  record: RuntimeStartLockRecord | RuntimeStartRecoveryLockRecord
): Promise<boolean> {
  if (!isProcessAlive(record.pid)) {
    return false;
  }
  let currentStartStamp: string;
  try {
    currentStartStamp = await processStartStamp(record.pid);
  } catch {
    return false;
  }
  if (currentStartStamp !== record.processStartStamp) {
    return false;
  }
  if (record.pid === process.pid) {
    return true;
  }
  let command: string;
  try {
    command = await processCommand(record.pid);
  } catch {
    return false;
  }
  const tokens = splitCommandLine(command);
  const runtimeIndex = tokens.indexOf("runtime");
  return (
    tokens.includes(record.cliPath) &&
    runtimeIndex >= 0 &&
    tokens[runtimeIndex + 1] === "up"
  );
}

async function removeRuntimeStartLockIfOwned(lockFile: string, pid: number): Promise<boolean> {
  const current = await readRuntimeStartLock(lockFile);
  let currentStartStamp: string;
  try {
    currentStartStamp = await processStartStamp(pid);
  } catch {
    return false;
  }
  if (!current || current.pid !== pid || current.processStartStamp !== currentStartStamp) {
    return false;
  }
  await rm(lockFile, { force: true });
  return true;
}

async function removeRuntimeStartRecoveryLockIfOwned(
  lockFile: string,
  pid: number,
  processStartStamp: string
): Promise<boolean> {
  const current = await readRuntimeStartRecoveryLock(lockFile);
  if (!current || current.pid !== pid || current.processStartStamp !== processStartStamp) {
    return false;
  }
  await rm(lockFile, { force: true });
  return true;
}

export async function writeRuntimePidFile(
  pidFile: string,
  pid: number,
  identity: RuntimePidIdentity
): Promise<void> {
  await writePidFile(pidFile, pid);
  const metadata: RuntimePidMetadata = {
    kind: "tychonic.runtime",
    pid,
    instance: identity.instance,
    cliPath: identity.cliPath ?? process.argv[1] ?? ""
  };
  await writeFile(runtimePidMetadataFile(pidFile), `${JSON.stringify(metadata)}\n`, "utf8");
}

export async function removeRuntimePidFilesIfOwned(pidFile: string, pid: number): Promise<boolean> {
  const removed = await removePidFileIfOwned(pidFile, pid);
  if (removed) {
    await rm(runtimePidMetadataFile(pidFile), { force: true });
  }
  return removed;
}

export async function isRuntimeParentProcess(
  pid: number,
  identity: RuntimePidIdentity
): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return false;
  }
  const metadata = await readRuntimePidMetadata(
    pid,
    identity.pidFile ? runtimePidMetadataFile(identity.pidFile) : undefined
  );
  if (!metadata || metadata.instance !== identity.instance || metadata.cliPath.length === 0) {
    return false;
  }
  let command: string;
  try {
    command = await processCommand(pid);
  } catch {
    return false;
  }
  const tokens = splitCommandLine(command);
  const runtimeIndex = tokens.indexOf("runtime");
  if (
    runtimeIndex < 0 ||
    tokens[runtimeIndex + 1] !== "up" ||
    !tokens.slice(runtimeIndex + 2).includes("--foreground") ||
    !tokens.includes(metadata.cliPath)
  ) {
    return false;
  }
  return true;
}

async function readRuntimePidMetadata(
  pid: number,
  metadataFile: string | undefined
): Promise<RuntimePidMetadata | undefined> {
  if (!metadataFile) {
    return undefined;
  }
  try {
    const raw = await readFile(metadataFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<RuntimePidMetadata>;
    if (
      parsed.kind !== "tychonic.runtime" ||
      parsed.pid !== pid ||
      (parsed.instance !== null && typeof parsed.instance !== "string") ||
      typeof parsed.cliPath !== "string"
    ) {
      return undefined;
    }
    return {
      kind: "tychonic.runtime",
      pid,
      instance: parsed.instance ?? null,
      cliPath: parsed.cliPath
    };
  } catch {
    return undefined;
  }
}

async function processCommand(pid: number): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return stdout.trim();
}

async function processStartStamp(pid: number): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  const stamp = stdout.trim();
  if (stamp.length === 0) {
    throw new Error(`failed to read process start time for pid ${pid}`);
  }
  return stamp;
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
