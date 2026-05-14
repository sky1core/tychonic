import { describe, expect, it } from "vitest";
import { loadExampleWorkflowSpec, loadGeneratedExampleWorkflowSource } from "./exampleYamlHelpers.js";

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

  it("routes failed reviews back to work with generated feedback", async () => {
    const source = await loadGeneratedExampleWorkflowSource("pipelineWorkflow");
    expect(source).toContain('assertReviewFailReturnTo(input.profile, "review_1", "work")');
    expect(source).toContain('assertReviewFailReturnTo(input.profile, "review_2", "work")');
    expect(source).toContain("appendDeclarativeReviewFeedback");
    expect(source).toContain("declarativeReviewFeedback");
  });

  it("asks for semantic review payload without host wire fields", async () => {
    const spec = await loadExampleWorkflowSpec("pipelineWorkflow");
    expect(spec.states.review_1?.prompt).toContain("Report a semantic review verdict with status, summary, and findings.");
    expect(spec.states.review_1?.prompt).not.toContain("Return only one JSON object");
    expect(spec.states.review_1?.prompt).not.toContain("tychonic.review.v1");
  });
});
