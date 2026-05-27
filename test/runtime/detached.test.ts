/**
 * Unit tests for `spawnDetachedRuntime` / `readPidFile` / `isProcessAlive`.
 *
 * The happy path here spawns a throwaway node child that exits
 * immediately (the child argv mirrors the shape the real CLI uses —
 * `node <cliPath> [--instance <name>] runtime up --foreground <extraArgs...>` — but
 * `cliPath` is a stub script that calls `process.exit(0)`). This keeps
 * the detached-spawn plumbing (stdio redirect to the log file, pid
 * written to the pid file, parent `unref` lets the event loop drain)
 * exercised without ever starting Temporal.
 */

import { describe, expect, it } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  spawnDetachedRuntime,
  readPidFile,
  isProcessAlive,
  writePidFile,
  removePidFileIfOwned,
  writeRuntimePidFile,
  removeRuntimePidFilesIfOwned,
  isRuntimeParentProcess,
  claimRuntimeStartLock
} from "../../src/runtime/detached.js";

const execFileAsync = promisify(execFile);

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tychonic-detached-"));
}

async function readUntilContains(file: string, expected: string): Promise<string> {
  const deadline = Date.now() + 2000;
  let lastContent = "";
  while (Date.now() < deadline) {
    try {
      lastContent = await readFile(file, "utf8");
      if (lastContent.includes(expected)) return lastContent;
    } catch {
      // The detached child may not have opened the log file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return lastContent;
}

async function spawnRuntimeLikeProcess(dir: string, args: string[]): Promise<{ child: ChildProcess; cliPath: string }> {
  const cliPath = join(dir, `runtime-like-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(cliPath, "setInterval(() => undefined, 1000);\n", "utf8");
  const child = spawn(
    process.execPath,
    [cliPath, ...args],
    { stdio: "ignore" }
  );
  if (!child.pid) {
    throw new Error("failed to spawn runtime-like process");
  }
  return { child, cliPath };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(resolve, 1000);
  });
}

async function processStartStamp(pid: number): Promise<string> {
  const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8"
  });
  return stdout.trim();
}

describe("spawnDetachedRuntime", () => {
  it("spawns the child, writes its pid to pidFile, and redirects stdio to logFile", async () => {
    const dir = await makeTempDir();
    const cliStub = join(dir, "cli-stub.mjs");
    // The stub prints a line to stdout and exits. It ignores its argv
    // entirely — the point of this test is the spawn plumbing, not the
    // CLI argv shape.
    await writeFile(
      cliStub,
      "process.stdout.write('hello from detached child\\n'); process.exit(0);\n",
      "utf8"
    );
    const logFile = join(dir, "state", "runtime.log");
    const pidFile = join(dir, "state", "runtime.pid");

    const result = await spawnDetachedRuntime({
      nodePath: process.execPath,
      cliPath: cliStub,
      instance: "foo",
      extraArgs: [],
      logFile,
      pidFile
    });

    expect(result.pid).toBeGreaterThan(0);
    expect(result.logFile).toBe(logFile);
    expect(result.pidFile).toBe(pidFile);

    const storedPid = await readPidFile(pidFile);
    expect(storedPid).toBe(result.pid);

    const logContent = await readUntilContains(logFile, "hello from detached child");
    expect(logContent).toContain("hello from detached child");
  });

  it("appends to an existing log file rather than truncating it", async () => {
    const dir = await makeTempDir();
    const cliStub = join(dir, "cli-stub.mjs");
    await writeFile(cliStub, "process.stdout.write('run-2\\n'); process.exit(0);\n", "utf8");
    const logFile = join(dir, "state", "runtime.log");
    const pidFile = join(dir, "state", "runtime.pid");

    // Pre-populate the log with a previous-session marker.
    await execFileAsync("mkdir", ["-p", join(dir, "state")]);
    await writeFile(logFile, "previous-session\n", "utf8");

    await spawnDetachedRuntime({
      nodePath: process.execPath,
      cliPath: cliStub,
      instance: "foo",
      extraArgs: [],
      logFile,
      pidFile
    });

    const logContent = await readUntilContains(logFile, "run-2");
    expect(logContent).toContain("previous-session");
    expect(logContent).toContain("run-2");
  });
});

describe("readPidFile", () => {
  it("returns 0 when the file is missing", async () => {
    const pid = await readPidFile("/tmp/nonexistent-tychonic-pid-" + Date.now());
    expect(pid).toBe(0);
  });

  it("returns 0 for non-integer content", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "pid");
    await writeFile(file, "not-a-number\n", "utf8");
    expect(await readPidFile(file)).toBe(0);
  });

  it("returns the integer pid for well-formed content", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "pid");
    await writeFile(file, "12345\n", "utf8");
    expect(await readPidFile(file)).toBe(12345);
  });
});

describe("writePidFile/removePidFileIfOwned", () => {
  it("writes a pid file and removes it only when the stored pid matches", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "runtime.pid");

    await writePidFile(file, 123);
    expect(await readPidFile(file)).toBe(123);

    expect(await removePidFileIfOwned(file, 456)).toBe(false);
    expect(await readPidFile(file)).toBe(123);

    expect(await removePidFileIfOwned(file, 123)).toBe(true);
    expect(await readPidFile(file)).toBe(0);
  });
});

describe("writeRuntimePidFile/removeRuntimePidFilesIfOwned", () => {
  it("removes runtime pid metadata only when the stored pid matches", async () => {
    const dir = await makeTempDir();
    const file = join(dir, "runtime.pid");

    await writeRuntimePidFile(file, 123, { instance: "foo" });
    expect(await readPidFile(file)).toBe(123);

    expect(await removeRuntimePidFilesIfOwned(file, 456)).toBe(false);
    expect(await readPidFile(file)).toBe(123);

    expect(await removeRuntimePidFilesIfOwned(file, 123)).toBe(true);
    expect(await readPidFile(file)).toBe(0);
  });
});

describe("claimRuntimeStartLock", () => {
  it("writes and releases a current-process runtime start claim", async () => {
    const dir = await makeTempDir();
    const lockFile = join(dir, "runtime.start.lock");

    const lock = await claimRuntimeStartLock(lockFile);
    await lock.release();

    const next = await claimRuntimeStartLock(lockFile);
    await next.release();
  });

  it("refuses a start claim while an active runtime start owner holds the lock", async () => {
    const dir = await makeTempDir();
    const lockFile = join(dir, "runtime.start.lock");
    const { child, cliPath } = await spawnRuntimeLikeProcess(dir, ["runtime", "up"]);
    try {
      await symlink(
        JSON.stringify({
          kind: "tychonic.runtime.startLock",
          pid: child.pid!,
          cliPath,
          processStartStamp: await processStartStamp(child.pid!)
        }),
        lockFile
      );

      await expect(claimRuntimeStartLock(lockFile)).rejects.toThrow(
        /runtime start is already in progress/
      );
    } finally {
      await stopChild(child);
    }
  });

  it("refuses a start claim while an active service install owner holds the shared operational lock", async () => {
    const dir = await makeTempDir();
    const lockFile = join(dir, "runtime.start.lock");
    const { child, cliPath } = await spawnRuntimeLikeProcess(dir, ["service", "install"]);
    try {
      await symlink(
        JSON.stringify({
          kind: "tychonic.runtime.startLock",
          pid: child.pid!,
          cliPath,
          processStartStamp: await processStartStamp(child.pid!)
        }),
        lockFile
      );

      await expect(claimRuntimeStartLock(lockFile)).rejects.toThrow(
        /runtime start is already in progress/
      );
    } finally {
      await stopChild(child);
    }
  });

  it("reclaims a start lock owned by a dead process", async () => {
    const dir = await makeTempDir();
    const lockFile = join(dir, "runtime.start.lock");
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const pid = child.pid;
    if (!pid) {
      throw new Error("failed to spawn child");
    }
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await symlink(
      JSON.stringify({
        kind: "tychonic.runtime.startLock",
        pid,
        cliPath: process.argv[1] ?? "",
        processStartStamp: "dead-process-start-stamp"
      }),
      lockFile
    );

    const lock = await claimRuntimeStartLock(lockFile);
    await lock.release();
  });

  it("reclaims a start lock owned by an unrelated live process", async () => {
    const dir = await makeTempDir();
    const lockFile = join(dir, "runtime.start.lock");
    const { child } = await spawnRuntimeLikeProcess(dir, ["not-runtime"]);
    try {
      await symlink(
        JSON.stringify({
          kind: "tychonic.runtime.startLock",
          pid: child.pid!,
          cliPath: join(dir, "not-the-child-cli.mjs"),
          processStartStamp: await processStartStamp(child.pid!)
        }),
        lockFile
      );

      const lock = await claimRuntimeStartLock(lockFile);
      await lock.release();
    } finally {
      await stopChild(child);
    }
  });

  it("allows only one claimant while recovering the same stale start lock", async () => {
    const dir = await makeTempDir();
    const lockFile = join(dir, "runtime.start.lock");
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const pid = child.pid;
    if (!pid) {
      throw new Error("failed to spawn child");
    }
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await symlink(
      JSON.stringify({
        kind: "tychonic.runtime.startLock",
        pid,
        cliPath: process.argv[1] ?? "",
        processStartStamp: "dead-process-start-stamp"
      }),
      lockFile
    );

    const attempts = await Promise.allSettled([
      claimRuntimeStartLock(lockFile),
      claimRuntimeStartLock(lockFile)
    ]);
    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof claimRuntimeStartLock>>> =>
        attempt.status === "fulfilled"
    );

    expect(fulfilled).toHaveLength(1);
    await fulfilled[0]!.value.release();
  });

  it("reclaims a stale recovery lock before recovering the start lock", async () => {
    const dir = await makeTempDir();
    const lockFile = join(dir, "runtime.start.lock");
    await symlink(
      JSON.stringify({
        kind: "tychonic.runtime.startLock",
        pid: 999_999,
        cliPath: process.argv[1] ?? "",
        processStartStamp: "dead-process-start-stamp"
      }),
      lockFile
    );
    await symlink(
      JSON.stringify({
        kind: "tychonic.runtime.startRecoveryLock",
        pid: 999_998,
        cliPath: process.argv[1] ?? "",
        processStartStamp: "dead-recovery-start-stamp"
      }),
      `${lockFile}.recover`
    );

    const lock = await claimRuntimeStartLock(lockFile);
    await lock.release();
  });

  it("reclaims a runtime-shaped start lock whose pid was reused by another start", async () => {
    const dir = await makeTempDir();
    const lockFile = join(dir, "runtime.start.lock");
    const { child, cliPath } = await spawnRuntimeLikeProcess(dir, ["runtime", "up"]);
    try {
      await symlink(
        JSON.stringify({
          kind: "tychonic.runtime.startLock",
          pid: child.pid!,
          cliPath,
          processStartStamp: "different-process-start-stamp"
        }),
        lockFile
      );

      const lock = await claimRuntimeStartLock(lockFile);
      await lock.release();
    } finally {
      await stopChild(child);
    }
  });
});

describe("isRuntimeParentProcess", () => {
  it("accepts a live runtime parent command for the matching instance", async () => {
    const dir = await makeTempDir();
    const { child, cliPath } = await spawnRuntimeLikeProcess(dir, ["--instance", "foo", "runtime", "up", "--foreground"]);
    const pidFile = join(dir, "runtime.pid");
    await writeRuntimePidFile(pidFile, child.pid!, { instance: "foo", cliPath });
    try {
      expect(
        await isRuntimeParentProcess(child.pid!, {
          instance: "foo",
          pidFile
        })
      ).toBe(true);
      expect(
        await isRuntimeParentProcess(child.pid!, {
          instance: "bar",
          pidFile
        })
      ).toBe(false);
    } finally {
      await stopChild(child);
    }
  });

  it("rejects an unrelated live process", async () => {
    const dir = await makeTempDir();
    const { child } = await spawnRuntimeLikeProcess(dir, ["not-runtime"]);
    try {
      expect(
        await isRuntimeParentProcess(child.pid!, {
          instance: null,
          pidFile: join(dir, "runtime.pid")
        })
      ).toBe(false);
    } finally {
      await stopChild(child);
    }
  });
});

describe("isProcessAlive", () => {
  it("reports the current process as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("reports a clearly-dead pid as not alive", () => {
    // Spawn a short-lived child, wait for exit, then probe its pid.
    // The number may be reused eventually by the OS, but for the
    // immediate test window it is ESRCH.
    return new Promise<void>((resolve, reject) => {
      const { spawn } = require("node:child_process") as typeof import("node:child_process");
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      const pid = child.pid;
      if (!pid) {
        reject(new Error("failed to spawn child"));
        return;
      }
      child.once("exit", () => {
        try {
          // Small delay: on some kernels the process table takes a
          // moment to mark the slot as ESRCH after exit.
          setTimeout(() => {
            expect(isProcessAlive(pid)).toBe(false);
            resolve();
          }, 50);
        } catch (e) {
          reject(e);
        }
      });
    });
  });

  it("returns false for non-positive integers", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });
});
