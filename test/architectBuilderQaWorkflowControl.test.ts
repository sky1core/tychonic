import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  calls: [] as string[],
  workResults: [] as Array<{ halted: boolean; passed: boolean; summary?: string }>,
  reviewResults: [] as Array<{ halted: boolean; passed: boolean; summary?: string }>
}));

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: vi.fn(() => ({}))
}));

vi.mock("tychonic/workflow", () => ({
  createTychonicWorkflowContext: vi.fn(() => ({
    start: async () => {
      harness.calls.push("start");
    },
    createWorktree: async () => {
      harness.calls.push("createWorktree");
      return "/tmp/tychonic-worktree";
    },
    run: () => ({ id: "run_abq_test" }),
    worktreePath: () => "/tmp/tychonic-worktree",
    isInteractive: () => false,
    work: async (stateName: string) => {
      harness.calls.push(`work:${stateName}`);
      const result = harness.workResults.shift();
      if (!result) throw new Error(`missing work result for ${stateName}`);
      return result;
    },
    review: async (stateName: string) => {
      harness.calls.push(`review:${stateName}`);
      const result = harness.reviewResults.shift();
      if (!result) throw new Error(`missing review result for ${stateName}`);
      return result;
    },
    finish: async (summary?: string) => {
      harness.calls.push(`finish:${summary ?? ""}`);
      return { runId: "run_abq_test", status: "failed", run: { id: "run_abq_test" }, artifactRoot: "/tmp" };
    },
    finishWaitingUser: async (summary: string) => {
      harness.calls.push(`finishWaitingUser:${summary}`);
      return { runId: "run_abq_test", status: "waiting_user", run: { id: "run_abq_test" }, artifactRoot: "/tmp" };
    }
  }))
}));

const { architectBuilderQaWorkflow } = await import(
  "../examples/workflows/architectBuilderQaWorkflow/workflow.mjs"
);

describe("architectBuilderQaWorkflow control flow", () => {
  beforeEach(() => {
    harness.calls = [];
    harness.workResults = [];
    harness.reviewResults = [];
  });

  it("stops before builder when architect work fails in auto mode", async () => {
    harness.workResults = [{ halted: false, passed: false, summary: "architect failed" }];

    await architectBuilderQaWorkflow({ cwd: "/tmp/repo", goal: "test goal" });

    expect(harness.calls).toEqual([
      "start",
      "createWorktree",
      "work:architect",
      "finish:architect failed"
    ]);
  });

  it("stops before QA when builder work fails in auto mode", async () => {
    harness.workResults = [
      { halted: false, passed: true },
      { halted: false, passed: false, summary: "builder failed" }
    ];

    await architectBuilderQaWorkflow({ cwd: "/tmp/repo", goal: "test goal" });

    expect(harness.calls).toEqual([
      "start",
      "createWorktree",
      "work:architect",
      "work:builder",
      "finish:builder failed"
    ]);
  });
});
