/**
 * Unit tests for `spawnDetachedRuntime` / `readPidFile` / `isProcessAlive`.
 *
 * The happy path here spawns a throwaway node child that exits
 * immediately (the child argv mirrors the shape the real CLI uses —
 * `node <cliPath> --instance <name> runtime up <extraArgs...>` — but
 * `cliPath` is a stub script that calls `process.exit(0)`). This keeps
 * the detached-spawn plumbing (stdio redirect to the log file, pid
 * written to the pid file, parent `unref` lets the event loop drain)
 * exercised without ever starting Temporal.
 */

import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  spawnDetachedRuntime,
  readPidFile,
  isProcessAlive
} from "../../src/runtime/detached.js";

const execFileAsync = promisify(execFile);

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tychonic-detached-"));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
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
      extraArgs: ["--no-web"],
      logFile,
      pidFile
    });

    expect(result.pid).toBeGreaterThan(0);
    expect(result.logFile).toBe(logFile);
    expect(result.pidFile).toBe(pidFile);

    const storedPid = await readPidFile(pidFile);
    expect(storedPid).toBe(result.pid);

    // Give the child a moment to finish so stdout is fully flushed.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await pathExists(logFile)).toBe(true);
    const logContent = await readFile(logFile, "utf8");
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

    await new Promise((resolve) => setTimeout(resolve, 200));
    const logContent = await readFile(logFile, "utf8");
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
