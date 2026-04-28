import { afterEach, describe, expect, it, vi } from "vitest";

describe("named workflow Temporal client behavior", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@temporalio/client");
  });

  it("starts all workflows through the same generic client path", async () => {
    const connect = vi.fn(async () => ({}));
    const start = vi.fn(async (_workflowType: string, options: { workflowId: string }) => ({
      workflowId: options.workflowId,
      firstExecutionRunId: `run-${options.workflowId}`,
      result: vi.fn(async () => undefined)
    }));

    vi.doMock("@temporalio/client", async () => {
      const actual = await vi.importActual<typeof import("@temporalio/client")>("@temporalio/client");
      class FakeClient {
        workflow = { start };
      }
      return {
        ...actual,
        Connection: { connect },
        Client: FakeClient
      };
    });

    const mod = await import("../src/temporal/client.js");
    await mod.startNamedTemporalWorkflow({
      workflowType: "sampleWorkflow",
      input: { cwd: "/repo", goal: "sample" },
      address: "127.0.0.1:7233",
      namespace: "default",
      taskQueue: "tychonic"
    });
    await mod.startNamedTemporalWorkflow({
      workflowType: "customWorkflow",
      input: { cwd: "/repo", goal: "custom" },
      address: "127.0.0.1:7233",
      namespace: "default",
      taskQueue: "tychonic"
    });

    expect(start).toHaveBeenNthCalledWith(
      1,
      "sampleWorkflow",
      expect.objectContaining({
        args: [{ cwd: "/repo", goal: "sample" }],
        taskQueue: "tychonic",
        workflowId: expect.stringMatching(/^tychonic_sampleWorkflow_/)
      })
    );
    expect(start).toHaveBeenNthCalledWith(
      2,
      "customWorkflow",
      expect.objectContaining({
        args: [{ cwd: "/repo", goal: "custom" }],
        taskQueue: "tychonic",
        workflowId: expect.stringMatching(/^tychonic_customWorkflow_/)
      })
    );
  });

  it("filters workflow visibility by tychonic workflow id prefix only", async () => {
    const connect = vi.fn(async () => ({}));
    const list = vi.fn(async function* () {
      yield {
        workflowId: "temporal-generated-id",
        runId: "run-unprefixed",
        type: "sampleWorkflow",
        taskQueue: "tychonic",
        status: { code: 1, name: "RUNNING" },
        historyLength: 4,
        startTime: new Date("2026-04-22T00:00:00.000Z"),
        searchAttributes: {},
        typedSearchAttributes: {},
        raw: {}
      };
      yield {
        workflowId: "tychonic_sampleWorkflow_test",
        runId: "run-packaged",
        type: "sampleWorkflow",
        taskQueue: "tychonic",
        status: { code: 1, name: "RUNNING" },
        historyLength: 5,
        startTime: new Date("2026-04-22T00:01:00.000Z"),
        searchAttributes: {},
        typedSearchAttributes: {},
        raw: {}
      };
      yield {
        workflowId: "tychonic_customWorkflow_test",
        runId: "run-custom",
        type: "customWorkflow",
        taskQueue: "tychonic",
        status: { code: 1, name: "RUNNING" },
        historyLength: 6,
        startTime: new Date("2026-04-22T00:02:00.000Z"),
        searchAttributes: {},
        typedSearchAttributes: {},
        raw: {}
      };
    });

    vi.doMock("@temporalio/client", async () => {
      const actual = await vi.importActual<typeof import("@temporalio/client")>("@temporalio/client");
      class FakeClient {
        workflow = { list };
      }
      return {
        ...actual,
        Connection: { connect },
        Client: FakeClient
      };
    });

    const mod = await import("../src/temporal/client.js");
    const result = await mod.listTychonicTemporalWorkflows({
      address: "127.0.0.1:7233",
      namespace: "default",
      taskQueue: "tychonic"
    });

    expect(result.workflows).toEqual([
      expect.objectContaining({
        workflowId: "tychonic_sampleWorkflow_test",
        type: "sampleWorkflow",
        status: "RUNNING"
      }),
      expect.objectContaining({
        workflowId: "tychonic_customWorkflow_test",
        type: "customWorkflow",
        status: "RUNNING"
      })
    ]);
  });
});
