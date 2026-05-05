import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  calls: [] as string[],
  interactive: false,
  workResults: [] as Array<{ halted: boolean; passed: boolean; summary?: string }>,
  verifyResults: [] as Array<{ halted: boolean; passed: boolean; summary?: string }>,
  reviewResults: [] as Array<{ halted: boolean; passed: boolean; summary?: string }>
}));

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: vi.fn(() => ({
    collectGitFactsActivity: async () => {
      harness.calls.push("activity:collectGitFacts");
      return { delta: {} };
    },
    startRunActivity: async () => ({ id: "run_abq_test" }),
    runVerifyActivity: async () => ({ delta: {} }),
    finalizeRunActivity: async () => ({ delta: {} })
  }))
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
    isInteractive: () => harness.interactive,
    apply: async () => {
      harness.calls.push("apply");
    },
    work: async (stateName: string) => {
      harness.calls.push(`work:${stateName}`);
      const result = harness.workResults.shift();
      if (!result) throw new Error(`missing work result for ${stateName}`);
      return result;
    },
    verify: async (stateName: string) => {
      harness.calls.push(`verify:${stateName}`);
      const result = harness.verifyResults.shift();
      if (!result) throw new Error(`missing verify result for ${stateName}`);
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
const { architectBuilderKiroQaWorkflow } = await import(
  "../examples/workflows/architectBuilderKiroQaWorkflow/workflow.mjs"
);
const { architectBuilderKiroRepairQaWorkflow } = await import(
  "../examples/workflows/architectBuilderKiroRepairQaWorkflow/workflow.mjs"
);
const { tychonicSelfCheckWorkflow } = await import(
  "../tools/workflows/tychonicSelfCheckWorkflow/workflow.mjs"
);

describe("architectBuilderQaWorkflow control flow", () => {
  beforeEach(() => {
    harness.calls = [];
    harness.interactive = false;
    harness.workResults = [];
    harness.verifyResults = [];
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

  it("does not report completion when interactive QA fails", async () => {
    harness.interactive = true;
    harness.workResults = [
      { halted: false, passed: true },
      { halted: false, passed: true }
    ];
    harness.reviewResults = [{ halted: false, passed: false, summary: "qa failed" }];

    await architectBuilderQaWorkflow({ cwd: "/tmp/repo", goal: "test goal" });

    expect(harness.calls).toEqual([
      "start",
      "createWorktree",
      "work:architect",
      "work:builder",
      "review:qa",
      "finish:qa failed"
    ]);
  });

  it("finishes without a forced success summary when QA passes", async () => {
    harness.workResults = [
      { halted: false, passed: true },
      { halted: false, passed: true }
    ];
    harness.reviewResults = [{ halted: false, passed: true }];

    await architectBuilderQaWorkflow({ cwd: "/tmp/repo", goal: "test goal" });

    expect(harness.calls).toContain("finish:");
  });
});

describe("kiro QA workflow control flow", () => {
  beforeEach(() => {
    harness.calls = [];
    harness.interactive = false;
    harness.workResults = [];
    harness.verifyResults = [];
    harness.reviewResults = [];
  });

  it("does not report completion when Kiro QA fails", async () => {
    harness.workResults = [
      { halted: false, passed: true },
      { halted: false, passed: true }
    ];
    harness.reviewResults = [{ halted: false, passed: false, summary: "qa failed" }];

    await architectBuilderKiroQaWorkflow({ cwd: "/tmp/repo", goal: "test goal" });

    expect(harness.calls).toEqual([
      "start",
      "createWorktree",
      "work:architect",
      "work:builder",
      "review:qa",
      "finish:qa failed"
    ]);
  });

  it("finishes Kiro QA without a forced success summary when QA passes", async () => {
    harness.workResults = [
      { halted: false, passed: true },
      { halted: false, passed: true }
    ];
    harness.reviewResults = [{ halted: false, passed: true }];

    await architectBuilderKiroQaWorkflow({ cwd: "/tmp/repo", goal: "test goal" });

    expect(harness.calls).toContain("finish:");
  });

  it("does not report completion when final QA fails after Kiro repair", async () => {
    harness.workResults = [
      { halted: false, passed: true },
      { halted: false, passed: true },
      { halted: false, passed: true },
      { halted: false, passed: true }
    ];
    harness.reviewResults = [{ halted: false, passed: false, summary: "final qa failed" }];

    await architectBuilderKiroRepairQaWorkflow({ cwd: "/tmp/repo", goal: "test goal" });

    expect(harness.calls).toEqual([
      "start",
      "createWorktree",
      "work:architect",
      "work:builder",
      "work:kiro_pre_review",
      "work:kiro_fix",
      "review:final_qa",
      "finish:final qa failed"
    ]);
  });

  it("finishes Kiro repair without a forced success summary when final QA passes", async () => {
    harness.workResults = [
      { halted: false, passed: true },
      { halted: false, passed: true },
      { halted: false, passed: true },
      { halted: false, passed: true }
    ];
    harness.reviewResults = [{ halted: false, passed: true }];

    await architectBuilderKiroRepairQaWorkflow({ cwd: "/tmp/repo", goal: "test goal" });

    expect(harness.calls).toContain("finish:");
  });
});

describe("single-pass workflow completion summaries", () => {
  beforeEach(() => {
    harness.calls = [];
    harness.interactive = false;
    harness.workResults = [];
    harness.verifyResults = [];
    harness.reviewResults = [];
  });

  it("does not force a success summary onto verifyOnlyWorkflow finalization", async () => {
    const source = await readFile(
      new URL("../examples/workflows/verifyOnlyWorkflow/workflow.mjs", import.meta.url),
      "utf8"
    );

    expect(source).toContain("return ctx.finish();");
    expect(source).not.toContain("verifyOnlyWorkflow completed");
  });

  it("does not force a success summary onto checkpointWorkflow finalization", async () => {
    const source = await readFile(
      new URL("../examples/workflows/checkpointWorkflow/workflow.mjs", import.meta.url),
      "utf8"
    );

    expect(source).toContain("return ctx.finish();");
    expect(source).not.toContain("checkpointWorkflow completed");
  });

  it("does not force a success summary onto self-check failures", async () => {
    harness.verifyResults = [{ halted: false, passed: false, summary: "bootstrap failed" }];

    await tychonicSelfCheckWorkflow({ cwd: "/tmp/repo" });

    expect(harness.calls).toEqual([
      "start",
      "activity:collectGitFacts",
      "apply",
      "verify:bootstrap",
      "finish:"
    ]);
  });

  it("does not pass success-worded summaries to workflow finalization", async () => {
    const workflowFiles = [
      "../examples/workflows/architectBuilderQaWorkflow/workflow.mjs",
      "../examples/workflows/architectBuilderKiroQaWorkflow/workflow.mjs",
      "../examples/workflows/architectBuilderKiroRepairQaWorkflow/workflow.mjs",
      "../examples/workflows/checkpointWorkflow/workflow.mjs",
      "../examples/workflows/pipelineWorkflow/workflow.mjs",
      "../examples/workflows/verifyOnlyWorkflow/workflow.mjs",
      "../tools/workflows/tychonicSelfCheckWorkflow/workflow.mjs"
    ];
    const successFinishPattern =
      /ctx\.finish\(\s*(?:"[^"]*(?:completed|finished|succeeded|success)|`[^`]*(?:completed|finished|succeeded|success))/;

    for (const workflowFile of workflowFiles) {
      const source = await readFile(new URL(workflowFile, import.meta.url), "utf8");
      expect(source, workflowFile).not.toMatch(successFinishPattern);
    }
  });
});
