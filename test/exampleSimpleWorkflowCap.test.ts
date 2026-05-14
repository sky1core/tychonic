import { describe, expect, it } from "vitest";
import { loadExampleWorkflowSpec, loadGeneratedExampleWorkflowSource } from "./exampleYamlHelpers.js";

describe("YAML workflow review loop cap", () => {
  it("uses max_steps as the declarative loop stop condition", async () => {
    const spec = await loadExampleWorkflowSpec("simpleWorkflow");
    expect(spec.max_steps).toBe(8);
    const source = await loadGeneratedExampleWorkflowSource("simpleWorkflow");
    expect(source).toContain("exceeded max_steps (8)");
    expect(source).toContain("finishWaitingUser(");
  });

  it("does not expose an unused loop policy in the YAML-derived profile", async () => {
    const spec = await loadExampleWorkflowSpec("simpleWorkflow");
    expect(spec.profile.policies?.loop).toBeUndefined();
  });
});
