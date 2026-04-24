/**
 * `runtime reset --instance <name>` integration tests against the built
 * CLI. Exercises the preAction-driven instance gating, the confirmation
 * prompt skip (`--yes`), and the kill/remove sequence via a fake PID
 * that is guaranteed dead.
 *
 * The tests write under a throwaway `TYCHONIC_STATE_HOME` so no real
 * operational path is ever touched. Each test creates its own state home
 * to avoid interference.
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
  return mkdtemp(join(tmpdir(), "tychonic-reset-test-"));
}

/**
 * Compute the same baseline state dir the CLI would derive for the
 * given HOME root on this platform. Mirrors `tychonicRuntimeDirs()`
 * when neither `TYCHONIC_STATE_HOME` nor `XDG_STATE_HOME` is set.
 */
function defaultStateDirForHome(home: string): string {
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Tychonic");
  }
  return join(home, ".local", "state", "tychonic");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a short-lived child process that exits on its own, then wait
 * for it. Its pid is reused here purely as a guaranteed-dead pid for
 * the reset tests — the OS may reuse the number later, but for the
 * immediate window of the test it is ESRCH when probed.
 */
async function spawnDeadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore"
  });
  const pid = child.pid;
  if (!pid) throw new Error("failed to spawn throwaway child");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

describe("tychonic runtime reset (argument gating)", () => {
  it("refuses without --instance", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.TYCHONIC_INSTANCE;
    const result = await runCli(["runtime", "reset", "--yes"], { env });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/requires --instance/);
  });

  it("rejects an invalid --instance name at the preAction validator", async () => {
    const result = await runCli(["--instance", "INVALID", "runtime", "reset", "--yes"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/does not match/);
  });

  it("rejects a reserved --instance name at the preAction validator", async () => {
    const result = await runCli(["--instance", "default", "runtime", "reset", "--yes"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/is reserved/);
  });
});

/**
 * Build a test env with `HOME` pointed at a throwaway directory, and
 * with the `TYCHONIC_*_HOME` / `XDG_STATE_HOME` / `TYCHONIC_INSTANCE`
 * variables cleared so the instance-derived suffix (`instances/<name>`)
 * is actually applied to the baseline state dir. Leaves the rest of the
 * inherited env untouched.
 */
function makeIsolatedEnv(fakeHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: fakeHome };
  delete env.TYCHONIC_STATE_HOME;
  delete env.TYCHONIC_LOG_HOME;
  delete env.XDG_STATE_HOME;
  delete env.TYCHONIC_INSTANCE;
  return env;
}

describe("tychonic runtime reset (idempotent cleanup)", () => {
  it("exits 0 and records skipped paths when the instance dir does not exist", async () => {
    const fakeHome = await makeStateHome();
    const env = makeIsolatedEnv(fakeHome);
    const result = await runCli(
      ["--instance", "nonexistent-xyz", "runtime", "reset", "--yes"],
      { env }
    );
    expect(result.exitCode).toBe(0);
    const payload = parseJsonStdout(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.instance).toBe("nonexistent-xyz");
    expect(payload.killedPid).toBeNull();
    expect(payload.killedSignal).toBeNull();
    expect(payload.removed).toMatchObject({
      stateDir: expect.stringContaining("instances/nonexistent-xyz") as unknown as string,
      logDir: expect.stringContaining("instances/nonexistent-xyz") as unknown as string
    });
  });

  it("removes an existing instance directory and reports the killed stale pid", async () => {
    const fakeHome = await makeStateHome();
    const env = makeIsolatedEnv(fakeHome);

    const stateDir = join(defaultStateDirForHome(fakeHome), "instances", "foo");
    await mkdir(stateDir, { recursive: true });
    const pidFile = join(stateDir, "runtime.pid");
    const deadPid = await spawnDeadPid();
    await writeFile(pidFile, `${deadPid}\n`, "utf8");

    // Drop a marker file so we can verify the directory really got wiped.
    const marker = join(stateDir, "marker.txt");
    await writeFile(marker, "hello", "utf8");
    expect(await pathExists(marker)).toBe(true);

    const result = await runCli(
      ["--instance", "foo", "runtime", "reset", "--yes"],
      { env }
    );
    expect(result.exitCode).toBe(0);
    const payload = parseJsonStdout(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.instance).toBe("foo");
    // The process already exited before we read the pid file, so the
    // handler records the pid but delivers no signal.
    expect(payload.killedPid).toBe(deadPid);
    expect(payload.killedSignal).toBeNull();

    expect(await pathExists(marker)).toBe(false);
    expect(await pathExists(stateDir)).toBe(false);
  });

  it("cancels cleanly when stdin answers no", async () => {
    const fakeHome = await makeStateHome();
    const env = makeIsolatedEnv(fakeHome);

    const stateDir = join(defaultStateDirForHome(fakeHome), "instances", "bar");
    await mkdir(stateDir, { recursive: true });
    const marker = join(stateDir, "still-there.txt");
    await writeFile(marker, "keep", "utf8");

    // Drive the CLI with a piped stdin that is not a TTY. The
    // promptConfirm helper returns false for non-TTY stdin, which we
    // treat the same as "user declined" — the handler should print a
    // cancelled payload and leave the marker in place.
    const { stdout, code } = await new Promise<{ stdout: string; code: number }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [CLI_PATH, "--instance", "bar", "runtime", "reset"],
        { env, stdio: ["pipe", "pipe", "pipe"] }
      );
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk.toString("utf8");
      });
      child.stderr.on("data", () => {
        /* ignored */
      });
      child.on("error", reject);
      child.on("close", (c) => resolve({ stdout: out, code: c ?? 1 }));
      child.stdin.end("n\n");
    });

    expect(code).toBe(0);
    const payload = parseJsonStdout(stdout);
    expect(payload.cancelled).toBe(true);
    expect(await pathExists(marker)).toBe(true);
  });
});
