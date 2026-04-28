/**
 * `runtime up --detach` CLI integration tests, limited to the gating
 * paths that do not actually spawn a long-lived Temporal process:
 *
 *   - refuse without --instance (operational launchd already supervises
 *     production; detach is for isolated instances only)
 *   - refuse when an existing PID file points at a live process
 *
 * The positive-path "spawn a detached child" behavior is covered at the
 * unit level against `spawnDetachedRuntime` in
 * `test/runtime/detached.test.ts`, where the spawn target is a
 * short-lived script instead of the real `runtime up` foreground.
 */

import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

describe("tychonic runtime up --detach (gating)", () => {
  it("refuses without --instance", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.TYCHONIC_INSTANCE;
    const result = await runCli(["runtime", "up", "--detach"], { env });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/--detach requires --instance/);
  });

  it("refuses pre-spawn when the instance has no workflow bundles installed", async () => {
    const fakeHome = await makeStateHome();
    const env = makeIsolatedEnv(fakeHome);

    // No `workflows install` was run; the bundles dir does not exist. Detach
    // must fail loudly with a pointer to `workflows install ... --instance`,
    // not spawn a child that dies silently a few seconds later after reporting
    // a success-looking JSON PID.
    const result = await runCli(
      ["--instance", "empty-bundles", "runtime", "up", "--detach"],
      { env }
    );
    expect(result.exitCode).not.toBe(0);
    const output = result.stderr + result.stdout;
    expect(output).toMatch(/no workflow bundles installed in instance 'empty-bundles'/);
    expect(output).toContain("workflows install");
    expect(output).toContain("--instance empty-bundles");
    // The JSON body with `pid` / `pidFile` must NOT be printed — we must never
    // have spawned a detached child at all.
    expect(output).not.toMatch(/"mode": "detached"/);
  });

  it("foreground runtime up also refuses pre-start when the instance has no bundles", async () => {
    // Parallel to the detach pre-check: foreground would otherwise start
    // Temporal first, have the worker crash on an empty registry, and leave
    // the Temporal child as an orphan with an open port. Fail before any
    // side-effectful process is spawned.
    const fakeHome = await makeStateHome();
    const env = makeIsolatedEnv(fakeHome);

    const result = await runCli(
      ["--instance", "empty-fg", "runtime", "up", "--no-web"],
      { env }
    );
    expect(result.exitCode).not.toBe(0);
    const output = result.stderr + result.stdout;
    expect(output).toMatch(/no workflow bundles installed in instance 'empty-fg'/);
    expect(output).toContain("workflows install");
    expect(output).toContain("--instance empty-fg");
    // The foreground JSON body must NOT be printed — Temporal must never
    // have been started at all.
    expect(output).not.toMatch(/"mode": "foreground"/);
  });

  it("foreground runtime up fails before starting Temporal when installed bundle deps are missing", async () => {
    const fakeHome = await makeStateHome();
    const env = makeIsolatedEnv(fakeHome);
    const instance = `missing-deps-${process.pid}`;
    const bundleDir = join(fakeHome, "missingDepsWorkflow");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      join(bundleDir, "workflow.mjs"),
      [
        'import { proxyActivities } from "@temporalio/workflow";',
        "proxyActivities({ startToCloseTimeout: \"1 minute\" });",
        "export const defaultProfile = {",
        '  version: "tychonic.config.v1",',
        "  states: { work: { type: \"work\", agent: \"claude\" } }",
        "};",
        "export async function missingDepsWorkflow(input) {",
        "  return { status: \"succeeded\", input };",
        "}"
      ].join("\n"),
      "utf8"
    );

    const install = await runCli(
      ["--instance", instance, "workflows", "install", bundleDir],
      { env }
    );
    expect(install.exitCode).toBe(0);

    const result = await runCli(
      ["--instance", instance, "runtime", "up", "--no-web"],
      { env }
    );
    expect(result.exitCode).not.toBe(0);
    const output = result.stderr + result.stdout;
    expect(output).toMatch(/Can't resolve '@temporalio\/workflow'/);
    expect(output).not.toMatch(/"mode": "foreground"/);

    const status = await runCli(["--instance", instance, "temporal", "status"], { env });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('"portOpen": false');
    expect(status.stdout).toContain('"health": "stopped"');
  }, 20000);

  it("refuses when an existing PID file points at a live process", async () => {
    const fakeHome = await makeStateHome();
    const env = makeIsolatedEnv(fakeHome);

    // Use the current test runner's pid as the "live" pid in the
    // throwaway instance state dir. The detach handler runs in a child
    // process that observes the runner as alive and must refuse.
    const stateDir = join(defaultStateDirForHome(fakeHome), "instances", "live-pid");
    await mkdir(stateDir, { recursive: true });
    const pidFile = join(stateDir, "runtime.pid");
    await writeFile(pidFile, `${process.pid}\n`, "utf8");

    const result = await runCli(
      ["--instance", "live-pid", "runtime", "up", "--detach"],
      { env }
    );
    expect(result.exitCode).not.toBe(0);
    const output = result.stderr + result.stdout;
    expect(output).toMatch(/already has a runtime/);
    expect(output).toContain(`pid=${process.pid}`);
    expect(output).toContain("runtime stop --instance live-pid");
  });
});
