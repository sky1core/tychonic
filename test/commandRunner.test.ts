import { describe, expect, it } from "vitest";
import { runCommand, sanitizeChildEnv, withPeriodicProgress } from "../src/bootstrap/commandRunner.js";

describe("runCommand", () => {
  it("aborts a running child when the signal fires", async () => {
    const controller = new AbortController();
    const start = Date.now();
    setTimeout(() => controller.abort(), 50).unref();

    const result = await runCommand({
      command: "node -e \"setTimeout(() => process.exit(0), 5_000)\"",
      cwd: process.cwd(),
      timeoutMs: 10_000,
      signal: controller.signal
    });

    expect(result.status).toBe("failed");
    expect(result.timedOut).toBe(false);
    expect(Date.now() - start).toBeLessThan(3_000);
  });

  it("returns a failed result immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runCommand({
      command: "node -e \"process.exit(0)\"",
      cwd: process.cwd(),
      timeoutMs: 1_000,
      signal: controller.signal
    });

    expect(result.status).toBe("failed");
    expect(result.output).toBe("");
  });


  it("adds launchd-safe user CLI directories to child PATH", () => {
    const env = sanitizeChildEnv({
      HOME: "/home/example",
      PATH: "/custom/bin:/usr/bin",
      TYCHONIC_CODEX_REVIEW_COMMAND: "auto",
      TYCHONIC_TEST_REVIEW_COMMAND: "auto"
    });

    expect(env.TYCHONIC_CODEX_REVIEW_COMMAND).toBeUndefined();
    expect(env.TYCHONIC_TEST_REVIEW_COMMAND).toBeUndefined();
    expect(env.PATH?.split(":")).toEqual([
      "/custom/bin",
      "/usr/bin",
      "/home/example/.local/bin",
      "/home/example/.npm-global/bin",
      "/home/example/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/bin"
    ]);
  });

  it("emits periodic progress callbacks while a quiet command is running", async () => {
    let progressCalls = 0;

    const result = await runCommand({
      command: "node -e \"setTimeout(() => process.exit(0), 60)\"",
      cwd: process.cwd(),
      timeoutMs: 1_000,
      progressIntervalMs: 10,
      onProgress: () => {
        progressCalls += 1;
      }
    });

    expect(result.status).toBe("succeeded");
    expect(progressCalls).toBeGreaterThan(1);
  });

  it("keeps progress callbacks alive across post-command async work", async () => {
    let progressCalls = 0;

    await withPeriodicProgress(
      () => {
        progressCalls += 1;
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      },
      10
    );

    expect(progressCalls).toBeGreaterThan(1);
  });

  it("runs multi-line commands in fail-fast mode", async () => {
    const result = await runCommand({
      command: ["printf 'before\\n'", "false", "printf 'after\\n'"].join("\n"),
      cwd: process.cwd(),
      timeoutMs: 1_000
    });

    expect(result.status).toBe("failed");
    expect(result.output).toContain("before");
    expect(result.output).not.toContain("after");
  });
});
