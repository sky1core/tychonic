import { describe, expect, it } from "vitest";
import { loadExampleWorkflowSpec, loadGeneratedExampleWorkflowSource } from "./exampleYamlHelpers.js";

describe("checkpointWorkflow YAML example", () => {
  it("declares both review prompts in workflow.yaml", async () => {
    const spec = await loadExampleWorkflowSpec("checkpointWorkflow");
    expect(spec.states.semantic_review?.prompt).toContain("Review changes for correctness");
    expect(spec.states.test_review?.prompt).toContain("Review test coverage for correctness");
    expect(spec.states.semantic_review?.prompt).toContain("{{goal}}");
    expect(spec.states.test_review?.prompt).toContain("{{goal}}");
  });

  it("renders the optional run goal into generated review prompts", async () => {
    const source = await loadGeneratedExampleWorkflowSource("checkpointWorkflow");
    expect(source).toContain("renderDeclarativePrompt(");
    expect(source).toContain("typeof input.goal === \"string\"");
  });

  it("routes failed reviews to the declared integration return state", async () => {
    const spec = await loadExampleWorkflowSpec("checkpointWorkflow");
    expect(spec.profile.states?.semantic_review?.on_fail_return_to).toBe("integration");
    expect(spec.profile.states?.test_review?.on_fail_return_to).toBe("integration");
    expect(spec.states.semantic_review?.on_fail).toEqual({ goto: "integration" });
    expect(spec.states.test_review?.on_fail).toEqual({ goto: "integration" });
  });
});
