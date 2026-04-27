import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bundle modules export plain JS, no TS types.
import { checkpointWorkflow } from "../examples/workflows/checkpointWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { selfRepairWorkflow } from "../examples/workflows/selfRepairWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { architectBuilderQaWorkflow } from "../examples/workflows/architectBuilderQaWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { pipelineWorkflow } from "../examples/workflows/pipelineWorkflow/workflow.mjs";

describe("example workflow input contracts", () => {
  it("checkpointWorkflow rejects undocumented input fields", async () => {
    await expect(
      checkpointWorkflow({ cwd: "/tmp/tychonic-test", autonomy: "review" })
    ).rejects.toThrow(/unsupported input field: autonomy/);
  });

  it("selfRepairWorkflow rejects undocumented input fields", async () => {
    await expect(
      selfRepairWorkflow({ cwd: "/tmp/tychonic-test", targetSessionId: "old-session" })
    ).rejects.toThrow(/unsupported input field: targetSessionId/);
  });

  it("architectBuilderQaWorkflow rejects undocumented input fields", async () => {
    await expect(
      architectBuilderQaWorkflow({ cwd: "/tmp/tychonic-test", runId: "manual" })
    ).rejects.toThrow(/unsupported input field: runId/);
  });

  it("pipelineWorkflow rejects undocumented input fields", async () => {
    await expect(
      pipelineWorkflow({ cwd: "/tmp/tychonic-test", verifyCommand: "npm test" })
    ).rejects.toThrow(/unsupported input field: verifyCommand/);
  });
});
