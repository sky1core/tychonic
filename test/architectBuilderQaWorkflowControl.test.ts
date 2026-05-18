import { describe, expect, it } from "vitest";
import { loadExampleWorkflowSpec } from "./exampleYamlHelpers.js";

describe("architect/builder/QA YAML control flow", () => {
  it("declares QA failure return to builder in workflow.yaml", async () => {
    const spec = await loadExampleWorkflowSpec("architectBuilderQaWorkflow");
    expect(spec.start).toBe("architect");
    expect(spec.states.architect?.on_pass).toEqual({ goto: "builder" });
    expect(spec.states.builder?.on_pass).toEqual({ goto: "qa" });
    expect(spec.states.qa?.on_fail).toEqual({ goto: "builder" });
    expect(spec.profile.states?.qa).toMatchObject({
      type: "review",
      on_fail_return_to: "builder"
    });
  });

  it("declares both first_review and final_qa failures back to builder", async () => {
    const spec = await loadExampleWorkflowSpec("architectBuilderFirstReviewQaWorkflow");
    expect(spec.states.builder?.on_pass).toEqual({ goto: "first_review" });
    expect(spec.states.first_review?.on_pass).toEqual({ goto: "final_qa" });
    expect(spec.states.first_review?.on_fail).toEqual({ goto: "builder" });
    expect(spec.states.final_qa?.on_fail).toEqual({ goto: "builder" });
    expect(spec.profile.states?.first_review).toMatchObject({
      type: "review",
      on_fail_return_to: "builder"
    });
    expect(spec.profile.states?.final_qa).toMatchObject({
      type: "review",
      on_fail_return_to: "builder"
    });
  });

  it("keeps final QA role split from Kiro builder", async () => {
    const spec = await loadExampleWorkflowSpec("architectBuilderFinalQaWorkflow");
    expect(spec.profile.states?.builder).toMatchObject({
      type: "work",
      agent: "kiro"
    });
    expect(spec.profile.states?.qa).toMatchObject({
      type: "review",
      agent: "codex"
    });
  });
});
