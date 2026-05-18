import { describe, expect, it } from "vitest";
import { loadExampleWorkflowSpec } from "./exampleYamlHelpers.js";

describe("pipelineWorkflow YAML example", () => {
  it("threads the pipeline through the YAML state order", async () => {
    const spec = await loadExampleWorkflowSpec("pipelineWorkflow");
    expect(spec.start).toBe("work");
    expect(spec.states.work?.on_pass).toEqual({ goto: "static" });
    expect(spec.states.static?.on_pass).toEqual({ goto: "unit" });
    expect(spec.states.unit?.on_pass).toEqual({ goto: "review_1" });
    expect(spec.states.review_1?.on_pass).toEqual({ goto: "integration" });
    expect(spec.states.integration?.on_pass).toEqual({ goto: "review_2" });
    expect(spec.states.review_2?.on_pass).toEqual({ goto: "security" });
  });

  it("declares failed reviews back to work in workflow.yaml", async () => {
    const spec = await loadExampleWorkflowSpec("pipelineWorkflow");
    expect(spec.states.review_1?.on_fail).toEqual({ goto: "work" });
    expect(spec.states.review_2?.on_fail).toEqual({ goto: "work" });
    expect(spec.profile.states?.review_1).toMatchObject({
      type: "review",
      on_fail_return_to: "work"
    });
    expect(spec.profile.states?.review_2).toMatchObject({
      type: "review",
      on_fail_return_to: "work"
    });
  });

  it("asks for semantic review payload without host wire fields", async () => {
    const spec = await loadExampleWorkflowSpec("pipelineWorkflow");
    expect(spec.states.review_1?.prompt).toContain("Report a semantic review verdict with status, summary, and findings.");
    expect(spec.states.review_1?.prompt).not.toContain("Return only one JSON object");
    expect(spec.states.review_1?.prompt).not.toContain("tychonic.review.v1");
  });
});
