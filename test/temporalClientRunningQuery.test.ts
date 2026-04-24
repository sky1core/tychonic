import { afterEach, describe, expect, it, vi } from "vitest";

describe("describeTychonicTemporalWorkflow running result queries", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.doUnmock("@temporalio/client");
  });

  it("returns a resultError when a running workflow query does not answer", async () => {
    vi.useFakeTimers();

    const query = vi.fn(() => new Promise<undefined>(() => {}));
    const describeWorkflow = vi.fn(async () => ({
      workflowId: "wf_timeout",
      runId: "run_timeout",
      type: "simpleWorkflow",
      taskQueue: "tychonic",
      status: { code: 1, name: "RUNNING" },
      historyLength: 20,
      startTime: new Date("2026-04-19T00:00:00.000Z"),
      searchAttributes: {},
      typedSearchAttributes: {},
      raw: { pendingActivities: [] },
      staticDetails: async () => undefined,
      staticSummary: async () => undefined
    }));
    const getHandle = vi.fn(() => ({ describe: describeWorkflow, query }));
    const connect = vi.fn(async () => ({}));

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
    const resultPromise = mod.describeTychonicTemporalWorkflow({
      workflowId: "wf_timeout",
      includeResult: true,
      address: "127.0.0.1:7233",
      namespace: "default",
      taskQueue: "tychonic"
    });

    await vi.advanceTimersByTimeAsync(2_000);

    await expect(resultPromise).resolves.toMatchObject({
      workflowId: "wf_timeout",
      status: "RUNNING",
      resultError: "running workflow state query timed out after 2000ms"
    });
  });
});
