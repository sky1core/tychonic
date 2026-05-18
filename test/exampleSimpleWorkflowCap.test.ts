import { describe, expect, it } from "vitest";
import { loadExampleWorkflowSpec } from "./exampleYamlHelpers.js";

describe("YAML workflow review loop cap", () => {
  it("does not expose an unused loop policy in the YAML-derived profile", async () => {
    const spec = await loadExampleWorkflowSpec("simpleWorkflow");
    expect(spec.profile.policies?.loop).toBeUndefined();
  });
});
