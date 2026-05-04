import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CLI_PATH = join(process.cwd(), "dist", "cli", "main.js");

/**
 * `tychonic signal <workflow-id> <signal-name>` is the workflow-agnostic
 * Temporal signal verb. The host has no opinion on signal name or
 * payload schema; the bundle author owns both. These tests pin the
 * argument parser, the payload-file IO contract, and the underlying
 * client call shape — they do not require a live Temporal cluster.
 */

async function runCli(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...(options.env ?? {}) }
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

describe("tychonic signal CLI parser", () => {
  it("requires both <workflow-id> and <signal-name>", async () => {
    // No positional arguments at all.
    const r1 = await runCli(["signal"]);
    expect(r1.exitCode).not.toBe(0);
    expect(r1.stderr + r1.stdout).toMatch(/missing required argument/i);

    // Only workflow-id; signal-name missing.
    const r2 = await runCli(["signal", "wf_id"]);
    expect(r2.exitCode).not.toBe(0);
    expect(r2.stderr + r2.stdout).toMatch(/missing required argument.*signal-name/i);
  });

  it("fails when --payload-file points at a non-existent path", async () => {
    const result = await runCli([
      "signal",
      "wf_id",
      "tychonic.simple_workflow.dismiss_inbox",
      "--payload-file",
      "/tmp/does-not-exist-tychonic-signal-smoke.json"
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/failed to read --payload-file/);
  });

  it("fails when --payload-file JSON is malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tychonic-cli-signal-bad-"));
    const file = join(dir, "bad.json");
    await writeFile(file, "{ not json", "utf8");
    const result = await runCli([
      "signal",
      "wf_id",
      "tychonic.simple_workflow.dismiss_inbox",
      "--payload-file",
      file
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/contains invalid JSON/);
  });

  it("prints usage that names the generic signal contract", async () => {
    const result = await runCli(["signal", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Send an arbitrary Temporal signal/);
    expect(result.stdout).toMatch(/--payload-file/);
    expect(result.stdout).toMatch(/--run-id/);
  });
});

describe("signalNamedWorkflow client contract", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@temporalio/client");
  });

  it("dispatches the signal name verbatim with the parsed JSON payload", async () => {
    const connect = vi.fn(async () => ({}));
    const signal = vi.fn(async () => undefined);
    const getHandle = vi.fn((workflowId: string, runId?: string) => ({
      workflowId,
      runId,
      signal
    }));

    vi.doMock("@temporalio/client", async () => {
      const actual = await vi.importActual<typeof import("@temporalio/client")>("@temporalio/client");
      class FakeClient {
        workflow = { getHandle };
      }
      return {
        ...actual,
        Connection: { connect },
        Client: FakeClient
      };
    });

    const mod = await import("../src/temporal/client.js");
    const result = await mod.signalNamedWorkflow({
      workflowId: "tychonic_simpleWorkflow_test",
      signalName: "example.signal",
      payload: { note: "operator input" },
      address: "127.0.0.1:7233",
      namespace: "default",
      taskQueue: "tychonic"
    });

    expect(getHandle).toHaveBeenCalledWith("tychonic_simpleWorkflow_test", undefined);
    expect(signal).toHaveBeenCalledWith("example.signal", {
      note: "operator input"
    });
    expect(result).toEqual({
      workflowId: "tychonic_simpleWorkflow_test",
      signaled: true
    });
  });

  it("forwards --run-id to getHandle when set", async () => {
    const connect = vi.fn(async () => ({}));
    const signal = vi.fn(async () => undefined);
    const getHandle = vi.fn(() => ({ signal }));

    vi.doMock("@temporalio/client", async () => {
      const actual = await vi.importActual<typeof import("@temporalio/client")>("@temporalio/client");
      class FakeClient {
        workflow = { getHandle };
      }
      return {
        ...actual,
        Connection: { connect },
        Client: FakeClient
      };
    });

    const mod = await import("../src/temporal/client.js");
    const result = await mod.signalNamedWorkflow({
      workflowId: "tychonic_simpleWorkflow_test",
      runId: "run-xyz",
      signalName: "tychonic.simple_workflow.dismiss_inbox",
      payload: { inboxItemId: "inbox-1" },
      address: "127.0.0.1:7233",
      namespace: "default",
      taskQueue: "tychonic"
    });

    expect(getHandle).toHaveBeenCalledWith("tychonic_simpleWorkflow_test", "run-xyz");
    expect(result).toEqual({
      workflowId: "tychonic_simpleWorkflow_test",
      runId: "run-xyz",
      signaled: true
    });
  });

  it("dispatches without a payload argument when payload is undefined", async () => {
    const connect = vi.fn(async () => ({}));
    const signal = vi.fn(async () => undefined);
    const getHandle = vi.fn(() => ({ signal }));

    vi.doMock("@temporalio/client", async () => {
      const actual = await vi.importActual<typeof import("@temporalio/client")>("@temporalio/client");
      class FakeClient {
        workflow = { getHandle };
      }
      return {
        ...actual,
        Connection: { connect },
        Client: FakeClient
      };
    });

    const mod = await import("../src/temporal/client.js");
    await mod.signalNamedWorkflow({
      workflowId: "tychonic_simpleWorkflow_test",
      signalName: "fire_and_forget",
      address: "127.0.0.1:7233",
      namespace: "default",
      taskQueue: "tychonic"
    });

    // `handle.signal(signalName)` — single arg form for fire-and-forget
    // signals whose handler takes no payload.
    expect(signal).toHaveBeenCalledWith("fire_and_forget");
  });

  it("rejects empty workflowId or signalName before opening a connection", async () => {
    const connect = vi.fn(async () => ({}));
    const getHandle = vi.fn(() => ({ signal: vi.fn() }));

    vi.doMock("@temporalio/client", async () => {
      const actual = await vi.importActual<typeof import("@temporalio/client")>("@temporalio/client");
      class FakeClient {
        workflow = { getHandle };
      }
      return {
        ...actual,
        Connection: { connect },
        Client: FakeClient
      };
    });

    const mod = await import("../src/temporal/client.js");

    await expect(
      mod.signalNamedWorkflow({
        workflowId: "",
        signalName: "x",
        address: "127.0.0.1:7233",
        namespace: "default",
        taskQueue: "tychonic"
      })
    ).rejects.toThrow(/workflowId must be a non-empty string/);

    await expect(
      mod.signalNamedWorkflow({
        workflowId: "wf_id",
        signalName: "",
        address: "127.0.0.1:7233",
        namespace: "default",
        taskQueue: "tychonic"
      })
    ).rejects.toThrow(/signalName must be a non-empty string/);

    expect(connect).not.toHaveBeenCalled();
    expect(getHandle).not.toHaveBeenCalled();
  });
});
