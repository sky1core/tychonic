import { defaultDataConverter, toPayloads } from "@temporalio/common";
import { Connection, type WorkflowExecutionDescription, type WorkflowExecutionInfo } from "@temporalio/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  signalInteractionApproveState,
  signalInteractionModifyState,
  signalInteractionRejectState,
  signalSimpleWorkflowContinuation,
  signalSimpleWorkflowRegisterSession,
  signalSimpleWorkflowResumeSession,
  summarizeTemporalWorkflowDescription,
  summarizeTemporalWorkflowInfo
} from "../src/temporal/client.js";
import type { WorkflowStateRecord } from "../src/domain/types.js";

describe("Temporal workflow status summaries", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@temporalio/client");
    vi.doUnmock("../src/temporal/workflowModules.js");
  });

  it("rejects inline secrets in simple_workflow signals before opening Temporal connection", async () => {
    await expect(
      signalSimpleWorkflowContinuation({
        workflowId: "wf",
        inboxItemId: "inbox_1",
        command: "node worker.js",
        verifyCommand: "env API_TOKEN=literal npm test"
      })
    ).rejects.toThrow(/inline secret/);

    await expect(
      signalSimpleWorkflowRegisterSession({
        workflowId: "wf",
        id: "session_1",
        agent: "codex",
        role: "worker",
        cwd: "/repo",
        resumeCommand: "tool --token literal",
        startedAt: "2026-04-20T00:00:00.000Z"
      })
    ).rejects.toThrow(/inline secret/);

    await expect(
      signalSimpleWorkflowResumeSession({
        workflowId: "wf",
        sessionId: "session_1",
        prompt: "continue",
        verifyCommand: "npm test",
        reviewCommand: "review --api-key literal"
      })
    ).rejects.toThrow(/inline secret/);

    await expect(
      signalSimpleWorkflowContinuation({
        workflowId: "wf",
        inboxItemId: "inbox_1",
        verifyCommand: "npm test",
        reviewCandidates: [{ agent: "reviewer", command: "review --json", resumeCommand: "review --resume" }]
      })
    ).rejects.toThrow(/review candidate reviewer must not set resumeCommand/);
  });

  it("summarizes workflow visibility info without repo-local state", () => {
    const info = fakeWorkflowInfo();

    expect(summarizeTemporalWorkflowInfo(info)).toEqual({
      workflowId: "tychonic_simple_workflow_test",
      runId: "temporal-run-id",
      type: "simpleWorkflow",
      taskQueue: "tychonic",
      status: "RUNNING",
      historyLength: 12,
      startTime: "2026-04-19T00:00:00.000Z"
    });
  });

  it("omits historyLength when Temporal visibility reports 0 for a running workflow", () => {
    const info = fakeWorkflowInfo({ historyLength: 0 });

    expect(summarizeTemporalWorkflowInfo(info)).toEqual({
      workflowId: "tychonic_simple_workflow_test",
      runId: "temporal-run-id",
      type: "simpleWorkflow",
      taskQueue: "tychonic",
      status: "RUNNING",
      startTime: "2026-04-19T00:00:00.000Z"
    });
  });

  it("decodes pending activity heartbeat details from Temporal describe", () => {
    const payloads = toPayloads(defaultDataConverter.payloadConverter, {
      runId: "run_123",
      step: "worker"
    });
    const description = {
      ...fakeWorkflowInfo(),
      raw: {
        pendingActivities: [
          {
            activityId: "1",
            activityType: { name: "runSimpleWorkflowActivity" },
            attempt: 1,
            lastHeartbeatTime: { seconds: 1776556801, nanos: 200_000_000 },
            heartbeatDetails: { payloads }
          }
        ]
      },
      staticDetails: async () => undefined,
      staticSummary: async () => undefined
    } as WorkflowExecutionDescription;

    expect(summarizeTemporalWorkflowDescription(description)).toMatchObject({
      workflowId: "tychonic_simple_workflow_test",
      pendingActivities: [
        {
          activityId: "1",
          activityType: "runSimpleWorkflowActivity",
          attempt: 1,
          lastHeartbeatTime: "2026-04-19T00:00:01.200Z",
          heartbeatDetails: [{ runId: "run_123", step: "worker" }]
        }
      ]
    });
  });

  it("summarizes pending workflow task details from Temporal describe", () => {
    const description = {
      ...fakeWorkflowInfo(),
      raw: {
        pendingActivities: [],
        pendingWorkflowTask: {
          state: 1,
          attempt: 3,
          scheduledTime: { seconds: 1776556805, nanos: 0 },
          originalScheduledTime: { seconds: 1776556801, nanos: 0 }
        }
      },
      staticDetails: async () => undefined,
      staticSummary: async () => undefined
    } as WorkflowExecutionDescription;

    expect(summarizeTemporalWorkflowDescription(description)).toMatchObject({
      workflowId: "tychonic_simple_workflow_test",
      pendingWorkflowTask: {
        state: "scheduled",
        attempt: 3,
        scheduledTime: "2026-04-19T00:00:05.000Z",
        originalScheduledTime: "2026-04-19T00:00:01.000Z"
      }
    });
  });

  it("omits pending workflow task detail once the workflow is closed", () => {
    const description = {
      ...fakeWorkflowInfo({ status: { code: 2, name: "COMPLETED" } }),
      raw: {
        pendingActivities: [],
        pendingWorkflowTask: {
          state: 1,
          attempt: 1,
          scheduledTime: { seconds: 1776556805, nanos: 0 }
        }
      },
      staticDetails: async () => undefined,
      staticSummary: async () => undefined
    } as WorkflowExecutionDescription;

    expect(summarizeTemporalWorkflowDescription(description)).toEqual({
      workflowId: "tychonic_simple_workflow_test",
      runId: "temporal-run-id",
      type: "simpleWorkflow",
      taskQueue: "tychonic",
      status: "COMPLETED",
      historyLength: 12,
      startTime: "2026-04-19T00:00:00.000Z",
      pendingActivities: []
    });
  });
});

describe("Interaction signal senders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("@temporalio/client");
  });

  it("rejects approveState with an empty state name before connecting", async () => {
    await expect(
      signalInteractionApproveState({
        workflowId: "wf",
        state: ""
      })
    ).rejects.toThrow(/'state' must be a non-empty string/);
  });

  it("rejects rejectState with a missing feedback string", async () => {
    await expect(
      signalInteractionRejectState({
        workflowId: "wf",
        state: "work",
        feedback: ""
      })
    ).rejects.toThrow(/feedback must be a non-empty string/);
  });

  it("rejects modifyState when patch.status is not terminal", async () => {
    await expect(
      signalInteractionModifyState({
        workflowId: "wf",
        state: "work",
        patch: { status: "running" as never }
      })
    ).rejects.toThrow(/patch.status must be terminal/);
  });

  it("rejects modifyState when patch is not an object", async () => {
    await expect(
      signalInteractionModifyState({
        workflowId: "wf",
        state: "work",
        patch: "oops" as unknown as never
      })
    ).rejects.toThrow(/patch must be a StateRecordPatch object/);
  });

  it("accepts an empty patch (no-op overlay is a valid signal)", async () => {
    // The signal itself validates; actual delivery requires a connection.
    // The mocked connection boundary keeps this unit test out of Temporal startup.
    const connectSpy = vi.spyOn(Connection, "connect").mockRejectedValue(new Error("connection boundary reached"));

    await expect(
      signalInteractionModifyState({
        workflowId: "wf",
        state: "work",
        patch: {}
      })
    ).rejects.toThrow(/connection boundary reached/);
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});

function fakeWorkflowInfo(
  overrides: Partial<Pick<WorkflowExecutionInfo, "status" | "historyLength" | "startTime" | "executionTime" | "closeTime">> = {}
): WorkflowExecutionInfo {
  return {
    workflowId: "tychonic_simple_workflow_test",
    runId: "temporal-run-id",
    type: "simpleWorkflow",
    taskQueue: "tychonic",
    status: overrides.status ?? { code: 1, name: "RUNNING" },
    historyLength: overrides.historyLength ?? 12,
    startTime: overrides.startTime ?? new Date("2026-04-19T00:00:00.000Z"),
    ...(overrides.executionTime ? { executionTime: overrides.executionTime } : {}),
    ...(overrides.closeTime ? { closeTime: overrides.closeTime } : {}),
    searchAttributes: {},
    typedSearchAttributes: {},
    raw: {}
  } as WorkflowExecutionInfo;
}
