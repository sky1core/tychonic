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

  it("verifyOnlyWorkflow rejects undocumented input fields", async () => {
    await expect(
      verifyOnlyWorkflow({ cwd: "/tmp/tychonic-test", command: "npm test" })
    ).rejects.toThrow(/unsupported input field: command/);
  });
});
