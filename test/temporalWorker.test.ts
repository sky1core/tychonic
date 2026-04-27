import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const workerCreateMock = vi.fn();
const workerRunMock = vi.fn();
const workerShutdownMock = vi.fn();
const nativeConnectionConnectMock = vi.fn();
const normalizeTemporalConfigMock = vi.fn();
const bundleWorkflowCodeMock = vi.fn();

vi.mock("@temporalio/worker", () => ({
  NativeConnection: {
    connect: nativeConnectionConnectMock
  },
  Worker: {
    create: workerCreateMock
  },
  bundleWorkflowCode: bundleWorkflowCodeMock
}));

vi.mock("../src/temporal/manager.js", () => ({
  normalizeTemporalConfig: normalizeTemporalConfigMock,
  tychonicRuntimeDirs: vi.fn(() => ({ stateDir: "/tmp/tychonic-test-state" }))
}));

vi.mock("../src/temporal/workflowModules.js", () => ({
  assertNoInstalledWorkflowExportConflicts: vi.fn(),
  listRuntimeWorkflowModules: vi.fn(async () => [
    {
      name: "simpleWorkflow",
      path: "/tmp/tychonic-test-state/workflows/modules/simpleWorkflow",
      workflowPath: "/tmp/tychonic-test-state/workflows/modules/simpleWorkflow/workflow.mjs"
    }
  ]),
  workflowModuleFileUrl: vi.fn((path: string) => `file://${path}`)
}));

describe("runTemporalWorker", () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.TYCHONIC_WORKER_MAX_HEARTBEAT_THROTTLE_INTERVAL;
    delete process.env.TYCHONIC_WORKER_DEFAULT_HEARTBEAT_THROTTLE_INTERVAL;
    delete process.env.TYCHONIC_WORKER_SHUTDOWN_GRACE_TIME;
  });

  it("sets low heartbeat throttle defaults for local progress visibility", async () => {
    await mkdir("/tmp/tychonic-test-state/workflows/modules/simpleWorkflow", { recursive: true });
    await writeFile(
      "/tmp/tychonic-test-state/workflows/modules/simpleWorkflow/workflow.mjs",
      "export function simpleWorkflow() {}",
      "utf8"
    );
    nativeConnectionConnectMock.mockResolvedValue({ id: "conn" });
    normalizeTemporalConfigMock.mockReturnValue({
      address: "127.0.0.1:7233",
      namespace: "default",
      taskQueue: "tychonic"
    });

    workerCreateMock.mockResolvedValue({
      run: workerRunMock,
      shutdown: workerShutdownMock
    });

    bundleWorkflowCodeMock.mockResolvedValue({ code: "bundle" });
    workerRunMock.mockResolvedValue(undefined);

    const workerModule = await import("../src/temporal/worker.js");
    await workerModule.runTemporalWorker({ shutdownSignals: false });

    expect(workerCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskQueue: "tychonic",
        maxHeartbeatThrottleInterval: "5s",
        defaultHeartbeatThrottleInterval: "5s"
      })
    );
  });

  it("allows heartbeat throttle env overrides", async () => {
    await mkdir("/tmp/tychonic-test-state/workflows/modules/simpleWorkflow", { recursive: true });
    await writeFile(
      "/tmp/tychonic-test-state/workflows/modules/simpleWorkflow/workflow.mjs",
      "export function simpleWorkflow() {}",
      "utf8"
    );
    process.env.TYCHONIC_WORKER_MAX_HEARTBEAT_THROTTLE_INTERVAL = "2s";
    process.env.TYCHONIC_WORKER_DEFAULT_HEARTBEAT_THROTTLE_INTERVAL = "3s";

    nativeConnectionConnectMock.mockResolvedValue({ id: "conn" });
    normalizeTemporalConfigMock.mockReturnValue({
      address: "127.0.0.1:7233",
      namespace: "default",
      taskQueue: "tychonic"
    });

    workerCreateMock.mockResolvedValue({
      run: workerRunMock,
      shutdown: workerShutdownMock
    });

    bundleWorkflowCodeMock.mockResolvedValue({ code: "bundle" });
    workerRunMock.mockResolvedValue(undefined);

    const workerModule = await import("../src/temporal/worker.js");
    await workerModule.runTemporalWorker({ shutdownSignals: false });

    expect(workerCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        maxHeartbeatThrottleInterval: "2s",
        defaultHeartbeatThrottleInterval: "3s"
      })
    );
  });
});
