import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CLI_PATH = join(process.cwd(), "dist", "cli", "main.js");

/**
 * CLI-level tests verify argument parsing and validation up to (but
 * not through) the Temporal connection boundary. Temporal itself is
 * not started in these tests; any command that would reach
 * `Connection.connect` is expected to fail with a connection or
 * validation error, which is sufficient to lock the CLI contract.
 */
async function runCli(args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...(options.env ?? {}) },
      ...(options.input !== undefined ? { input: options.input } : {})
    });
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

describe("tychonic approve / reject / modify", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reject fails when --feedback is empty", async () => {
    const result = await runCli(["reject", "wf_id", "--state", "work", "--feedback", ""]);
    expect(result.exitCode).not.toBe(0);
    // Commander may throw the validation; message comes from CLI code.
    expect(result.stderr + result.stdout).toMatch(/feedback must be a non-empty string|required|invalid/i);
  });

  it("reject fails when --feedback is missing", async () => {
    const result = await runCli(["reject", "wf_id", "--state", "work"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/required option.*feedback/i);
  });

  it("modify fails when --patch-file points at a non-existent path", async () => {
    const result = await runCli([
      "modify",
      "wf_id",
      "--state",
      "work",
      "--patch-file",
      "/tmp/does-not-exist-tychonic-smoke.json"
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/failed to read --patch-file/);
  });

  it("modify fails when patch.status is not terminal", async () => {
    const result = await runCli([
      "modify",
      "wf_id",
      "--state",
      "work",
      "--status",
      "running"
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/patch\.status must be terminal/);
  });

  it("modify fails when --patch-file JSON is malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tychonic-cli-modify-bad-"));
    const file = join(dir, "bad.json");
    await writeFile(file, "{ not json", "utf8");
    const result = await runCli([
      "modify",
      "wf_id",
      "--state",
      "work",
      "--patch-file",
      file
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/contains invalid JSON/);
  });

  it.each([
    { command: "approve", args: ["approve", "wf_id", "--state", ""] },
    { command: "reject", args: ["reject", "wf_id", "--state", "", "--feedback", "retry"] },
    { command: "modify", args: ["modify", "wf_id", "--state", ""] }
  ])("$command with an empty --state fails before querying or signaling", async ({ args }) => {
    const result = await runCli(args);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/--state must be a non-empty string/i);
  });
});

describe("tychonic workflows validate", () => {
  it("accepts a bundle directory path with a trailing slash", async () => {
    const result = await runCli(["workflows", "validate", "examples/workflows/pipelineWorkflow/"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      ok: true,
      bundle: {
        directory: "examples/workflows/pipelineWorkflow/",
        workflowNames: ["pipelineWorkflow"]
      }
    });
    expect(parsed.bundle.moduleExports).toContain("defaultProfile");
    expect(parsed.bundle).not.toHaveProperty("workflowExports");
  });
});
