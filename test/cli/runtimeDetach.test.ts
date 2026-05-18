/**
 * `runtime up` daemon CLI integration tests, limited to the gating
 * paths that do not actually spawn a long-lived Temporal process:
 *
 *   - reuse an already-running operational daemon
 *   - reuse an already-running isolated daemon
 *
 * The positive-path "spawn a detached child" behavior is covered at the
 * unit level against `spawnDetachedRuntime` in
 * `test/runtime/detached.test.ts`, where the spawn target is a
 * short-lived script instead of the real `runtime up` foreground.
 */

import { describe, expect, it } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
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

async function makeStateHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tychonic-detach-test-"));
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

function parseJsonStdout(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  if (start < 0) {
    throw new Error(`no JSON payload found in stdout: ${stdout}`);
  }
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
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

async function writeRuntimePidClaim(
  pidFile: string,
  input: { pid: number; instance: string | null; cliPath: string }
): Promise<void> {
  await writeFile(pidFile, `${input.pid}\n`, "utf8");
  await writeFile(
    `${pidFile}.json`,
    `${JSON.stringify({
      kind: "tychonic.runtime",
      pid: input.pid,
      instance: input.instance,
      cliPath: input.cliPath
    })}\n`,
    "utf8"
  );
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

describe("tychonic runtime up daemon start", () => {
  it("explains instance selection in runtime up help", async () => {
    const result = await runCli(["runtime", "up", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Instance selection:");
    expect(result.stdout).toContain("--instance <name>");
    expect(result.stdout).toContain("TYCHONIC_INSTANCE");
  });

  it("reports already_running for an operational daemon pid", async () => {
    const fakeHome = await makeStateHome();
    const env = makeIsolatedEnv(fakeHome);
    const stateDir = defaultStateDirForHome(fakeHome);
    const { child, cliPath } = await spawnRuntimeLikeProcess(fakeHome, ["runtime", "up", "--foreground"]);
    await mkdir(stateDir, { recursive: true });
    await writeRuntimePidClaim(join(stateDir, "runtime.pid"), {
      pid: child.pid!,
      instance: null,
      cliPath
    });
    await writeFile(
      join(stateDir, "runtime.ready.json"),
      `${JSON.stringify({
        state: "ready",
        pid: child.pid,
        web: { status: "running", url: "http://127.0.0.1:19733" }
      })}\n`,
      "utf8"
    );

    try {
      const result = await runCli(["runtime", "up"], { env });

      expect(result.exitCode).toBe(0);
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: true,
        state: "already_running",
        mode: "daemon",
        pid: child.pid,
        web: { status: "running", url: "http://127.0.0.1:19733" },
        stopCommand: "tychonic runtime stop"
      });
    } finally {
      await stopChild(child);
    }
  });

  it("refuses pre-spawn when the instance has no workflow bundles installed", async () => {
    const fakeHome = await makeStateHome();
    const env = makeIsolatedEnv(fakeHome);

    // No `workflows install` was run; the bundles dir does not exist. Detach
    // must fail loudly with a pointer to `workflows install ... --instance`,
    // not spawn a child that dies silently a few seconds later after reporting
    // a success-looking JSON PID.
    const result = await runCli(["--instance", "empty-bundles", "runtime", "up"], { env });
    expect(result.exitCode).not.toBe(0);
    const output = result.stderr + result.stdout;
    expect(output).toMatch(/no workflow bundles installed in instance 'empty-bundles'/);
    expect(output).toContain("workflows install");
    expect(output).toContain("--instance empty-bundles");
    // The JSON body with `pid` / `pidFile` must NOT be printed — we must never
    // have spawned a detached child at all.
    expect(output).not.toMatch(/"mode": "daemon"/);
  });

  it("refuses to overwrite a live unverified runtime pid", async () => {
    const fakeHome = await makeStateHome();
    const env = makeIsolatedEnv(fakeHome);
    const stateDir = defaultStateDirForHome(fakeHome);
    const pidFile = join(stateDir, "runtime.pid");
    await mkdir(stateDir, { recursive: true });
    await writeFile(pidFile, `${process.pid}\n`, "utf8");

    const result = await runCli(["runtime", "up"], { env });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("not a verified Tychonic runtime parent");
    expect(await readFile(pidFile, "utf8")).toBe(`${process.pid}\n`);
  });

  it("refuses to start a second daemon while runtime start is in progress", async () => {
    const fakeHome = await makeStateHome();
    const env = makeIsolatedEnv(fakeHome);
    const stateDir = defaultStateDirForHome(fakeHome);
    await mkdir(stateDir, { recursive: true });
    const { child, cliPath } = await spawnRuntimeLikeProcess(fakeHome, ["runtime", "up"]);
    try {
      await symlink(
        JSON.stringify({
          kind: "tychonic.runtime.startLock",
          pid: child.pid!,
          cliPath,
          processStartStamp: await processStartStamp(child.pid!)
        }),
        join(stateDir, "runtime.start.lock")
      );

      const result = await runCli(["runtime", "up"], { env });

      expect(result.exitCode).not.toBe(0);
      const output = result.stderr + result.stdout;
      expect(output).toContain("runtime start is already in progress");
      expect(output).not.toMatch(/"mode": "daemon"/);
    } finally {
      await stopChild(child);
    }
  });

  it("does not allow the internal ready-file path outside daemon child mode", async () => {
    const fakeHome = await makeStateHome();
    const env = makeIsolatedEnv(fakeHome);
    const readyFile = join(fakeHome, "runtime.ready.json");

    const result = await runCli(["runtime", "up", "--foreground", "--ready-file", readyFile], {
      env
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain(
      "runtime up --ready-file is internal and requires --daemon-child"
    );
  });

  it("foreground runtime up also refuses pre-start when the instance has no bundles", async () => {
    // Parallel to the detach pre-check: foreground would otherwise start
    // Temporal first, have the worker crash on an empty registry, and leave
    // the Temporal child as an orphan with an open port. Fail before any
    // side-effectful process is spawned.
    const fakeHome = await makeStateHome();
    const env = makeIsolatedEnv(fakeHome);

    const result = await runCli(["--instance", "empty-fg", "runtime", "up", "--foreground"], { env });
    expect(result.exitCode).not.toBe(0);
    const output = result.stderr + result.stdout;
    expect(output).toMatch(/no workflow bundles installed in instance 'empty-fg'/);
    expect(output).toContain("workflows install");
    expect(output).toContain("--instance empty-fg");
    // The foreground JSON body must NOT be printed — Temporal must never
    // have been started at all.
    expect(output).not.toMatch(/"mode": "foreground"/);
  });

  it("reports already_running when an instance PID file points at a live process", async () => {
    const fakeHome = await makeStateHome();
    const env = makeIsolatedEnv(fakeHome);

    // Use a live runtime-shaped pid in the throwaway instance state dir.
    // `runtime up` is idempotent and must not reject just because the daemon
    // parent PID differs from the caller's PID.
    const stateDir = join(defaultStateDirForHome(fakeHome), "instances", "live-pid");
    const { child, cliPath } = await spawnRuntimeLikeProcess(fakeHome, ["--instance", "live-pid", "runtime", "up", "--foreground"]);
    await mkdir(stateDir, { recursive: true });
    const pidFile = join(stateDir, "runtime.pid");
    await writeRuntimePidClaim(pidFile, {
      pid: child.pid!,
      instance: "live-pid",
      cliPath
    });
    await writeFile(join(stateDir, "runtime.ready.json"), `${JSON.stringify({ state: "ready", pid: child.pid })}\n`, "utf8");

    try {
      const result = await runCli(["--instance", "live-pid", "runtime", "up"], { env });

      expect(result.exitCode).toBe(0);
      expect(parseJsonStdout(result.stdout)).toMatchObject({
        ok: true,
        state: "already_running",
        mode: "daemon",
        pid: child.pid,
        stopCommand: "tychonic runtime stop --instance live-pid"
      });
    } finally {
      await stopChild(child);
    }
  });
});
