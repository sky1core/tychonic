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


  it("keeps child PATH limited to explicit agent paths and ambient PATH", () => {
    const env = sanitizeChildEnv({
      HOME: "/home/example",
      PATH: "/custom/bin:/usr/bin",
      TYCHONIC_AGENT_PATH: "/explicit/agents",
      TYCHONIC_CODEX_REVIEW_COMMAND: "auto",
      TYCHONIC_TEST_REVIEW_COMMAND: "auto"
    });

    expect(env.TYCHONIC_CODEX_REVIEW_COMMAND).toBeUndefined();
    expect(env.TYCHONIC_TEST_REVIEW_COMMAND).toBeUndefined();
    expect(env.PATH?.split(":")).toEqual([
      "/explicit/agents",
      "/custom/bin",
      "/usr/bin"
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
      { intervalMs: 10 }
    );

    expect(progressCalls).toBeGreaterThan(1);
  });

  it("does not let a throwing periodic-progress callback escape", async () => {
    let ticks = 0;

    const result = await withPeriodicProgress(
      () => {
        ticks += 1;
        throw new Error("boom from tick");
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return "ok";
      },
      { intervalMs: 10 }
    );

    expect(result).toBe("ok");
    expect(ticks).toBeGreaterThan(1);
  });

  it("does not let a throwing onProgress escape runCommand", async () => {
    const result = await runCommand({
      command: "node -e \"process.stdout.write('x'); setTimeout(() => process.exit(0), 60)\"",
      cwd: process.cwd(),
      timeoutMs: 1_000,
      progressIntervalMs: 10,
      onProgress: () => {
        throw new Error("boom");
      }
    });

    expect(result.status).toBe("succeeded");
  });

  it("calls onAfter after run resolves and propagates its throw", async () => {
    const order: string[] = [];

    await expect(
      withPeriodicProgress(
        undefined,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          order.push("run-done");
        },
        {
          onAfter: () => {
            order.push("after");
            throw new Error("surface");
          }
        }
      )
    ).rejects.toThrow("surface");

    expect(order).toEqual(["run-done", "after"]);
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

  it("can retain the tail of large command output", async () => {
    const result = await runCommand({
      command: "node -e \"process.stdout.write('a'.repeat(120)); process.stdout.write('TAIL')\"",
      cwd: process.cwd(),
      timeoutMs: 1_000,
      maxOutputBytes: 16,
      outputCapture: "tail"
    });

    expect(result.status).toBe("succeeded");
    expect(result.output).toBe("aaaaaaaaaaaaTAIL");
  });
});
