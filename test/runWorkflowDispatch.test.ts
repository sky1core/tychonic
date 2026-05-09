import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

describe("run workflow dispatch", () => {
  it("rejects raw input.profile before Temporal connection or bundle lookup", async () => {
    const fixture = await createRunDispatchFixture();
    const input = JSON.stringify({
      cwd: fixture.repo,
      profile: {
        version: "tychonic.config.v1",
        states: { verify: { type: "verify", command: "echo ok" } }
      }
    });

    const failure = await runCliExpectFailure(["run", "customWorkflow", "--input", input, "--temporal-address", "127.0.0.1:1"], fixture.env);

    expect(failure.stderr).toMatch(/input\.profile is reserved for Tychonic config injection/);
    expect(failure.stderr).not.toMatch(/Failed to connect before the deadline|127\\.0\\.0\\.1:1|ECONNREFUSED|UNAVAILABLE/i);
    expect(failure.stderr).not.toMatch(/tychonic-workflows\.mjs|stale for this tychonic build/i);
  }, 20_000);

  it("rejects an unknown workflow before Temporal connection even when --config is present", async () => {
    const fixture = await createRunDispatchFixture();
    const configPath = join(fixture.repo, "profile.yaml");
    await writeFile(
      configPath,
      [
        "version: tychonic.config.v1",
        "states:",
        "  verify:",
        "    type: verify",
        "    command: echo ok",
        ""
      ].join("\n"),
      "utf8"
    );
    const input = JSON.stringify({
      cwd: fixture.repo,
      goal: "connect through Temporal only"
    });

    const failure = await runCliExpectFailure(
      ["run", "customWorkflow", "--input", input, "--config", configPath, "--temporal-address", "127.0.0.1:1"],
      fixture.env
    );

    expect(failure.stderr).toMatch(/no installed workflow named "customWorkflow"/);
    expect(failure.stderr).not.toMatch(/tychonic-workflows\.mjs|stale for this tychonic build/i);
    expect(failure.stderr).not.toMatch(/Failed to connect before the deadline|127\\.0\\.0\\.1:1|ECONNREFUSED|UNAVAILABLE/i);
  }, 20_000);

  it("rejects workflow-specific invalid --config before Temporal connection", async () => {
    const fixture = await createRunDispatchFixture();
    await runCliExpectSuccess(
      ["workflows", "install", "examples/workflows/architectBuilderQaWorkflow"],
      fixture.env
    );
    const configPath = join(fixture.repo, "stock-discovery-profile.yaml");
    await writeFile(
      configPath,
      [
        "version: tychonic.config.v1",
        "states:",
        "  architect:",
        "    type: work",
        "    command: echo architect",
        "  builder:",
        "    type: work",
        "    command: echo builder",
        "  qa:",
        "    type: review",
        "    command: echo qa",
        "policies:",
        "  interaction:",
        "    mode: auto",
        "  loop:",
        "    auto_continue: true",
        "    max_review_iterations: 2",
        ""
      ].join("\n"),
      "utf8"
    );
    const input = JSON.stringify({
      cwd: fixture.repo,
      goal: "discover stocks"
    });

    const failure = await runCliExpectFailure(
      [
        "run",
        "architectBuilderQaWorkflow",
        "--input",
        input,
        "--config",
        configPath,
        "--temporal-address",
        "127.0.0.1:1"
      ],
      fixture.env
    );

    expect(failure.stderr).toMatch(/workflow architectBuilderQaWorkflow preflight failed/);
    expect(failure.stderr).toMatch(/policies\.loop\.auto_continue is not a recognised key/);
    expect(failure.stderr).not.toMatch(/Failed to connect before the deadline|127\\.0\\.0\\.1:1|ECONNREFUSED|UNAVAILABLE/i);
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

async function runCliExpectSuccess(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await execFileAsync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: projectRoot,
    env,
    encoding: "utf8"
  });
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
