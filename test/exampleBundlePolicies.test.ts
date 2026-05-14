import { describe, expect, it } from "vitest";
import { loadExampleWorkflowSpec } from "./exampleYamlHelpers.js";

describe("example workflow.yaml policy blocks", () => {
  it("does not carry runtime-ignored loop policies in generated examples", async () => {
    for (const name of [
      "simpleWorkflow",
      "architectBuilderQaWorkflow",
      "architectBuilderFinalQaWorkflow",
      "architectBuilderFirstReviewQaWorkflow"
    ] as const) {
      const spec = await loadExampleWorkflowSpec(name);
      expect(spec.profile.policies?.loop).toBeUndefined();
    }
  });

  it("does not carry runtime-ignored integration policy in checkpointWorkflow", async () => {
    const spec = await loadExampleWorkflowSpec("checkpointWorkflow");
    expect(spec.profile.policies?.integration).toBeUndefined();
  });

  it("does not carry runtime-ignored interaction policy in examples", async () => {
    const spec = await loadExampleWorkflowSpec("structuralIssueDiscoveryWorkflow");
    expect(spec.profile.policies?.interaction).toBeUndefined();
  });
});
