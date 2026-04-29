/**
 * `runtime stop --instance <name>` CLI tests. These exercise the safe
 * stop contract without starting Temporal: stale PID files are cleaned,
 * instance state/log directories are preserved, and the command refuses
 * the operational path.
 */

import { describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_PATH = join(process.cwd(), "dist", "cli", "main.js");

async function runCli(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = { ...process.env, ...(options.env ?? {}) };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], { env });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: typeof e.code === "number" ? e.code : 1
    };
  }
}

function parseJsonStdout(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  if (start < 0) {
    throw new Error(`no JSON payload found in stdout: ${stdout}`);
  }
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

async function makeStateHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tychonic-stop-test-"));
}

function defaultStateDirForHome(home: string): string {
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Tychonic");
  }
  return join(home, ".local", "state", "tychonic");
}

function makeIsolatedEnv(fakeHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome };
  delete env.TYCHONIC_STATE_HOME;
  delete env.TYCHONIC_LOG_HOME;
  delete env.XDG_STATE_HOME;
  delete env.TYCHONIC_INSTANCE;
  return env;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function spawnDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore"
  });
  const pid = child.pid;
  if (!pid) throw new Error("failed to spawn throwaway child");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

describe("tychonic runtime stop", () => {
  it("is discoverable from runtime help", async () => {
    const result = await runCli(["runtime", "--help"]);
    const stopHelp = await runCli(["runtime", "stop", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("stop");
    expect(result.stdout).toContain("Gracefully stop");
    expect(stopHelp.exitCode).toBe(0);
    expect(stopHelp.stdout).toContain("Instance selection:");
    expect(stopHelp.stdout).toContain("TYCHONIC_INSTANCE");
  });

  it("refuses without --instance", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.TYCHONIC_INSTANCE;

    const result = await runCli(["runtime", "stop"], { env });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/requires --instance/);
  });

  it("reports not_running when the instance has no runtime pid file", async () => {
    const fakeHome = await makeStateHome();
    const env = makeIsolatedEnv(fakeHome);

    const result = await runCli(["--instance", "no-runtime", "runtime", "stop"], { env });

    expect(result.exitCode).toBe(0);
    const payload = parseJsonStdout(result.stdout);
    expect(payload).toMatchObject({
      ok: true,
      state: "not_running",
      pid: null,
      pidFileRemoved: false,
      temporal: {
        ok: true,
        state: "not_running"
      }
    });
  });

  it("removes only a stale runtime pid file and preserves instance state", async () => {
    const fakeHome = await makeStateHome();
    const env = makeIsolatedEnv(fakeHome);
    const stateDir = join(defaultStateDirForHome(fakeHome), "instances", "stale-runtime");
    await mkdir(stateDir, { recursive: true });
    const pidFile = join(stateDir, "runtime.pid");
    const marker = join(stateDir, "marker.txt");
    const deadPid = await spawnDeadPid();
    await writeFile(pidFile, `${deadPid}\n`, "utf8");
    await writeFile(marker, "keep\n", "utf8");

    const result = await runCli(["--instance", "stale-runtime", "runtime", "stop"], { env });

    expect(result.exitCode).toBe(0);
    const payload = parseJsonStdout(result.stdout);
    expect(payload).toMatchObject({
      ok: true,
      state: "not_running",
      pid: deadPid,
      signalSent: null,
      pidFileRemoved: true,
      temporal: {
        ok: true,
        state: "not_running"
      }
    });
    expect(await pathExists(pidFile)).toBe(false);
    expect(await pathExists(marker)).toBe(true);
    expect(await pathExists(stateDir)).toBe(true);
  });
});
