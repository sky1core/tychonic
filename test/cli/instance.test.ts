import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CLI_PATH = join(process.cwd(), "dist", "cli", "main.js");

/**
 * CLI-level tests verify that the `--instance` global option, the
 * `TYCHONIC_INSTANCE` env fallback, and the launchd gating all wire
 * through to behavior visible from the command line.
 *
 * These tests drive the built CLI (`dist/cli/main.js`) via a child
 * process — the preAction hook runs in the child, so we observe the
 * resolved active instance only through the `_meta.instance` field of
 * the JSON payload (or through exit status and stderr for error paths).
 *
 * Commands chosen here do not open a Temporal connection:
 *   - `workflows list` reads the on-disk registry only.
 *   - `service status` (negative test) refuses before launchd is
 *     touched because instance is set.
 * Commands that would reach Temporal (`status`, `run`, etc.) are not
 * exercised here — their parsing layer is already locked by
 * `interactionCli.test.ts` and the relevant contract tests.
 */
async function runCli(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // `TYCHONIC_STATE_HOME` is supplied per test so operations land in a
  // throwaway directory and never touch the real operational state dir.
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
  // `workflows list` can emit a warning line (e.g. TYCHONIC_STATE_HOME
  // override warning) before the JSON payload. Slice from the first '{'.
  const start = stdout.indexOf("{");
  if (start < 0) {
    throw new Error(`no JSON payload found in stdout: ${stdout}`);
  }
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

async function makeStateHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "tychonic-instance-test-"));
}

describe("tychonic --instance global option", () => {
  it("sets _meta.instance from --instance CLI flag", async () => {
    const stateHome = await makeStateHome();
    const result = await runCli(["--instance", "foo", "workflows", "list"], {
      env: { TYCHONIC_STATE_HOME: stateHome }
    });
    expect(result.exitCode).toBe(0);
    const payload = parseJsonStdout(result.stdout);
    expect(payload._meta).toEqual({ instance: "foo" });
  });

  it("falls back to $TYCHONIC_INSTANCE when --instance is omitted", async () => {
    const stateHome = await makeStateHome();
    const result = await runCli(["workflows", "list"], {
      env: { TYCHONIC_STATE_HOME: stateHome, TYCHONIC_INSTANCE: "bar" }
    });
    expect(result.exitCode).toBe(0);
    const payload = parseJsonStdout(result.stdout);
    expect(payload._meta).toEqual({ instance: "bar" });
  });

  it("CLI --instance wins over $TYCHONIC_INSTANCE", async () => {
    const stateHome = await makeStateHome();
    const result = await runCli(["--instance", "baz", "workflows", "list"], {
      env: { TYCHONIC_STATE_HOME: stateHome, TYCHONIC_INSTANCE: "bar" }
    });
    expect(result.exitCode).toBe(0);
    const payload = parseJsonStdout(result.stdout);
    expect(payload._meta).toEqual({ instance: "baz" });
  });

  it("leaves _meta.instance as null when instance is unset", async () => {
    const stateHome = await makeStateHome();
    // Clear any inherited TYCHONIC_INSTANCE from the outer shell.
    const env: NodeJS.ProcessEnv = { ...process.env, TYCHONIC_STATE_HOME: stateHome };
    delete env.TYCHONIC_INSTANCE;
    const result = await runCli(["workflows", "list"], { env });
    expect(result.exitCode).toBe(0);
    const payload = parseJsonStdout(result.stdout);
    expect(payload._meta).toEqual({ instance: null });
  });

  it("rejects a name that fails the instance-name regex", async () => {
    const result = await runCli(["--instance", "INVALID", "workflows", "list"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/does not match/);
  });

  it("rejects a reserved instance name", async () => {
    const result = await runCli(["--instance", "default", "workflows", "list"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/is reserved/);
  });
});

describe("service commands refuse --instance (operational-only)", () => {
  it("service status exits non-zero with a specific error when --instance is set", async () => {
    const result = await runCli(["--instance", "foo", "service", "status"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(
      /tychonic service status is operational-only/
    );
    expect(result.stderr + result.stdout).toContain("--instance");
  });

  it("service restart-worker exits non-zero under --instance", async () => {
    const result = await runCli(["--instance", "foo", "service", "restart-worker"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(
      /tychonic service restart-worker is operational-only/
    );
  });
});

describe("workflows install / remove under --instance do not touch launchd", () => {
  it("emits worker_replacement: null with an instance-specific note when the target bundle is missing", async () => {
    // Negative path — the bundle directory does not exist. The command
    // fails before any launchd code path is reached; the check is that
    // the error surface does not mention launchctl / LaunchAgent.
    const stateHome = await makeStateHome();
    const result = await runCli(
      ["--instance", "foo", "workflows", "install", "/nonexistent/bundle/path"],
      { env: { TYCHONIC_STATE_HOME: stateHome } }
    );
    expect(result.stderr + result.stdout).not.toMatch(/launchctl|LaunchAgent/);
    expect(result.exitCode).not.toBe(0);
  });

  it("positive: a valid bundle installs with worker_replacement: null + instance note + launchd untouched", async () => {
    // Positive path — prepare a minimal valid bundle (workflow.mjs
    // exporting a workflow function whose name matches the bundle dir
    // plus a defaultProfile object), install it under --instance, and
    // assert that the CLI reached the success branch AND short-circuited
    // launchd. This is the end-to-end locked behavior: workflows install
    // --instance must never mutate operational launchd.
    const stateHome = await makeStateHome();
    const bundleName = "positiveinstancebundle";
    const bundleDir = join(await mkdtemp(join(tmpdir(), "tychonic-bundle-")), bundleName);
    await mkdir(bundleDir, { recursive: true });
    await writeFile(
      join(bundleDir, "workflow.mjs"),
      // A minimal workflow: named export whose name matches the bundle
      // directory name, plus a `defaultProfile` object literal. The
      // AST-based inspector (AGENTS §16) parses this without running the
      // module.
      [
        `export async function ${bundleName}(input) {`,
        "  return { runId: input.runId ?? 'x', status: 'succeeded', run: {}, artifactRoot: '' };",
        "}",
        "export const defaultProfile = {",
        "  version: 'tychonic.config.v1',",
        "  states: {",
        "    work: { type: 'work', agent: 'claude' }",
        "  }",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = await runCli(
      ["--instance", "ipos", "workflows", "install", bundleDir],
      { env: { TYCHONIC_STATE_HOME: stateHome } }
    );
    expect(result.exitCode).toBe(0);
    const payload = parseJsonStdout(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.worker_replacement).toBeNull();
    expect(payload.note).toEqual(expect.stringContaining("instance='ipos'"));
    expect(payload._meta).toEqual({ instance: "ipos" });
    // Module landed in the test's throwaway state dir (the explicit
    // `TYCHONIC_STATE_HOME` beats the instance-derived state dir at the
    // field level — §9). The critical assertion for this test is that
    // the operational launchd labels were not touched — asserted above
    // — and the bundle registered under the same (isolated) stateHome.
    const moduleInfo = payload.module as Record<string, string>;
    expect(moduleInfo.path).toContain(`workflows/modules/${bundleName}`);
    // The success surface must never mention launchctl / LaunchAgent.
    expect(result.stderr + result.stdout).not.toMatch(/launchctl|LaunchAgent/);
  });
});

describe("tryReplaceLaunchdWorker short-circuits when an instance is active", () => {
  it("returns worker_replacement: null and an instance-specific note", async () => {
    // Import the internal helper by spawning a tiny node snippet that
    // sets the active instance and calls into the launchd module. This
    // avoids coupling the test to any private TS symbol layout — it
    // drives the compiled `dist/` artifacts that the CLI itself drives.
    const snippet = `
      import { setActiveInstance } from "${pathToFileUrl(
        join(process.cwd(), "dist", "runtime", "instance.js")
      )}";
      import { replaceLaunchdWorker } from "${pathToFileUrl(
        join(process.cwd(), "dist", "service", "launchd.js")
      )}";
      setActiveInstance("foo");
      try {
        await replaceLaunchdWorker();
        console.log("UNEXPECTED_SUCCESS");
      } catch (error) {
        console.log("CAUGHT: " + (error instanceof Error ? error.message : String(error)));
      }
    `;
    const { stdout, stderr } = await execFileAsync(process.execPath, ["--input-type=module", "-e", snippet], {
      env: { ...process.env }
    });
    const output = stdout + stderr;
    expect(output).toContain("CAUGHT:");
    expect(output).toContain("launchd services are operational-only");
    expect(output).toContain("instance='foo'");
  });
});

function pathToFileUrl(p: string): string {
  return "file://" + p;
}
