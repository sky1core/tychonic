import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bundle modules export plain JS, no TS types.
import { checkpointWorkflow } from "../examples/workflows/checkpointWorkflow/workflow.mjs";
import { architectBuilderQaWorkflow } from "../examples/workflows/architectBuilderQaWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { architectBuilderKiroQaWorkflow } from "../examples/workflows/architectBuilderKiroQaWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { architectBuilderKiroRepairQaWorkflow } from "../examples/workflows/architectBuilderKiroRepairQaWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { pipelineWorkflow } from "../examples/workflows/pipelineWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { verifyOnlyWorkflow } from "../examples/workflows/verifyOnlyWorkflow/workflow.mjs";

describe("example workflow input contracts", () => {
  it("rejects task input without cwd before starting activities", async () => {
    await expect(
      checkpointWorkflow({ goal: "inspect" })
    ).rejects.toThrow(/cwd must be a non-empty string/);
  });

  it("checkpointWorkflow rejects undocumented input fields", async () => {
    await expect(
      checkpointWorkflow({ cwd: "/tmp/tychonic-test", autonomy: "review" })
    ).rejects.toThrow(/unsupported input field: autonomy/);
  });

  it("architectBuilderQaWorkflow rejects undocumented input fields", async () => {
    await expect(
      architectBuilderQaWorkflow({ cwd: "/tmp/tychonic-test", runId: "manual" })
    ).rejects.toThrow(/unsupported input field: runId/);
  });

  it("architectBuilderKiroQaWorkflow rejects undocumented input fields", async () => {
    await expect(
      architectBuilderKiroQaWorkflow({ cwd: "/tmp/tychonic-test", reviewer: "kiro" })
    ).rejects.toThrow(/unsupported input field: reviewer/);
  });

  it("architectBuilderKiroRepairQaWorkflow rejects undocumented input fields", async () => {
    await expect(
      architectBuilderKiroRepairQaWorkflow({ cwd: "/tmp/tychonic-test", repairAgent: "kiro" })
    ).rejects.toThrow(/unsupported input field: repairAgent/);
  });

  it("pipelineWorkflow rejects undocumented input fields", async () => {
    await expect(
      pipelineWorkflow({ cwd: "/tmp/tychonic-test", verifyCommand: "npm test" })
    ).rejects.toThrow(/unsupported input field: verifyCommand/);
  });

  it("rejects retired top-level prompt override fields", async () => {
    await expect(
      architectBuilderKiroRepairQaWorkflow({
        cwd: "/tmp/tychonic-test",
        kiroPreReviewPrompt: "inspect"
      })
    ).rejects.toThrow(/unsupported input field: kiroPreReviewPrompt/);
  });

  it("rejects prompt additions that are not keyed by an allowed state NAME", async () => {
    await expect(
      architectBuilderQaWorkflow({
        cwd: "/tmp/tychonic-test",
        promptAdditions: { kiroPreReview: "inspect" }
      })
    ).rejects.toThrow(/unsupported promptAdditions state: kiroPreReview/);
  });

  it("rejects prompt additions that do not match the configured state NAMEs", async () => {
    await expect(
      architectBuilderQaWorkflow({
        cwd: "/tmp/tychonic-test",
        profile: { states: { architect: {}, builder: {} } },
        promptAdditions: { qa: "review carefully" }
      })
    ).rejects.toThrow(/promptAdditions\.qa does not match a configured state/);
  });

  it("rejects prompt additions when effective profile states are absent", async () => {
    await expect(
      architectBuilderQaWorkflow({
        cwd: "/tmp/tychonic-test",
        promptAdditions: { architect: "inspect first" }
      })
    ).rejects.toThrow(/promptAdditions requires effective profile\.states/);
  });

  it("rejects non-string prompt addition values", async () => {
    await expect(
      pipelineWorkflow({
        cwd: "/tmp/tychonic-test",
        promptAdditions: { review_1: ["review"] }
      })
    ).rejects.toThrow(/promptAdditions\.review_1 must be a non-empty string/);
  });

  it("verifyOnlyWorkflow rejects undocumented input fields", async () => {
    await expect(
      verifyOnlyWorkflow({ cwd: "/tmp/tychonic-test", command: "npm test" })
    ).rejects.toThrow(/unsupported input field: command/);
  });

  it("verifyOnlyWorkflow rejects goal because that workflow exposes no task prompt", async () => {
    await expect(
      verifyOnlyWorkflow({ cwd: "/tmp/tychonic-test", goal: "run tests" })
    ).rejects.toThrow(/unsupported input field: goal/);
  });
});
