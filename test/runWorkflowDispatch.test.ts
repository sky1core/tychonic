import { execFile } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

describe("run workflow dispatch", () => {
  it("uses the generic run path without local shipped-workflow preflight", async () => {
    const fixture = await createRunDispatchFixture();
    const input = JSON.stringify({ cwd: fixture.repo, goal: "connect through Temporal only" });

    const failure = await runCliExpectFailure(["run", "customWorkflow", "--input", input, "--address", "127.0.0.1:1"], fixture.env);

    expect(failure.stderr).toMatch(/Failed to connect before the deadline|127\\.0\\.0\\.1:1|ECONNREFUSED|UNAVAILABLE/i);
    expect(failure.stderr).not.toMatch(/tychonic-workflows\.mjs|stale for this tychonic build|self_repair_workflow/i);
  }, 20_000);
});

async function createRunDispatchFixture(): Promise<{
  repo: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await mkdtemp(join(tmpdir(), "tychonic-run-dispatch-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const stateHome = join(root, "state");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  return {
    repo,
    env: {
      ...process.env,
      HOME: home,
      TYCHONIC_STATE_HOME: stateHome
    }
  };
}

async function runCliExpectFailure(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{
  stdout: string;
  stderr: string;
  code?: number;
}> {
  try {
    await execFileAsync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: projectRoot,
      env,
      encoding: "utf8"
    });
  } catch (error) {
    return {
      stdout: errorOutput(error, "stdout"),
      stderr: errorOutput(error, "stderr"),
      code: errorCode(error)
    };
  }
  throw new Error(`expected CLI failure for: ${args.join(" ")}`);
}

function errorOutput(error: unknown, stream: "stdout" | "stderr"): string {
  if (error && typeof error === "object" && stream in error && typeof error[stream] === "string") {
    return error[stream];
  }
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): number | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "number") {
    return error.code;
  }
  return undefined;
}
