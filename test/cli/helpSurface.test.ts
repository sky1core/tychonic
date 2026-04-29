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

  it.each(["wait", "signal", "status", "approve", "reject", "modify", "artifacts", "logs", "inbox", "sessions"])(
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
    expect(temporalHelp).toContain("status [options]");
    expect(temporalHelp).toContain("doctor [options]");
    expect(temporalHelp).not.toContain("start [options]");
    expect(temporalHelp).not.toContain("worker [options]");
  });
});
