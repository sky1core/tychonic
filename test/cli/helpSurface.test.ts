import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const CLI_PATH = join(process.cwd(), "dist", "cli", "main.js");

async function cliHelp(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
    env: process.env
  });
  return stdout;
}

async function cliResult(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      env: process.env
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

describe("CLI help public surface", () => {
  it("keeps the top-level help focused on ordinary commands", async () => {
    const stdout = await cliHelp(["--help"]);

    expect(stdout).toContain("run");
    expect(stdout).toContain("wait");
    expect(stdout).not.toContain("--instance");
    expect(stdout).not.toContain("signal [options]");
    expect(stdout).not.toContain("service");
    expect(stdout).not.toContain("temporal");
    expect(stdout).not.toContain("Temporal");
    expect(stdout).not.toContain("web [options]");
    expect(stdout).toContain("sessions [options]");
    expect(stdout).toContain("Basic flow:");
  });

  it("shows file input and wait on run without promoting inline JSON or Temporal wiring", async () => {
    const stdout = await cliHelp(["run", "--help"]);

    expect(stdout).toContain("--input-file <file>");
    expect(stdout).toContain("--wait");
    expect(stdout).not.toContain("--input <json>");
    expect(stdout).not.toContain("--temporal-");
  });

  it.each(["wait", "signal", "status", "approve", "reject", "modify", "rerun", "artifacts", "logs", "inbox", "sessions"])(
    "hides Temporal connection wiring from %s help",
    async (command) => {
      const stdout = await cliHelp([command, "--help"]);

      expect(stdout).not.toContain("--temporal-");
    }
  );

  it("keeps advanced status filtering accepted but out of the ordinary help surface", async () => {
    const stdout = await cliHelp(["status", "--help"]);

    expect(stdout).toContain("--workflow-id <id>");
    expect(stdout).not.toContain("--visibility-query");
    expect(stdout).not.toContain("--include-result");
    expect(stdout).not.toContain("Temporal");
  });

  it("keeps runtime-level Temporal configuration discoverable where it belongs", async () => {
    const runtimeHelp = await cliHelp(["runtime", "up", "--help"]);
    const temporalHelp = await cliHelp(["temporal", "doctor", "--help"]);

    expect(runtimeHelp).toContain("--temporal-port <port>");
    expect(temporalHelp).toContain("--temporal-port <port>");
  });

  it("keeps destructive cleanup hidden while listing the graceful runtime stop command", async () => {
    const runtimeHelp = await cliHelp(["runtime", "--help"]);
    const temporalHelp = await cliHelp(["temporal", "--help"]);

    expect(runtimeHelp).toContain("up [options]");
    expect(runtimeHelp).not.toContain("reset [options]");
    expect(runtimeHelp).toContain("stop");
    expect(runtimeHelp).toContain("Gracefully stop");
    expect(runtimeHelp).toContain("status UI");
    expect(temporalHelp).toContain("status [options]");
    expect(temporalHelp).toContain("doctor [options]");
    expect(temporalHelp).not.toContain("start [options]");
    expect(temporalHelp).not.toContain("worker [options]");
  });

  it("shows web as part of the operational service lifecycle", async () => {
    const serviceHelp = await cliHelp(["service", "--help"]);
    const installHelp = await cliHelp(["service", "install", "--help"]);

    expect(serviceHelp).toContain("terminate-web");
    expect(installHelp).toContain("--web-port <port>");
    expect(installHelp).toContain("Temporal, worker, and web status UI");
  });

  it("keeps hidden standalone web compatible with service Temporal options", async () => {
    const result = await cliResult(["web", "--temporal-mode", "managed-local", "--port", "0"]);
    const output = result.stderr + result.stdout;

    expect(result.exitCode).not.toBe(0);
    expect(output).toContain("--port must be an integer between 1 and 65535");
    expect(output).not.toContain("unknown option '--temporal-mode'");
  });
});
