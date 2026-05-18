import { describe, expect, it } from "vitest";
import { loadExampleWorkflowSpec } from "./exampleYamlHelpers.js";

describe("simpleWorkflow YAML activity contract", () => {
  it("declares work, verify, and review states in workflow.yaml", async () => {
    const spec = await loadExampleWorkflowSpec("simpleWorkflow");
    expect(spec.states.work?.type).toBe("work");
    expect(spec.states.verify?.type).toBe("verify");
    expect(spec.states.review?.type).toBe("review");
    expect(spec.profile.states?.review?.on_fail_return_to).toBe("work");
  });

  it("declares work -> verify -> review -> work failure routing in workflow.yaml", async () => {
    const spec = await loadExampleWorkflowSpec("simpleWorkflow");
    expect(spec.start).toBe("work");
    expect(spec.states.work?.on_pass).toEqual({ goto: "verify" });
    expect(spec.states.verify?.on_pass).toEqual({ goto: "review" });
    expect(spec.states.review?.on_fail).toEqual({ goto: "work" });
  });

  it("keeps the generic npm verification command", async () => {
    const spec = await loadExampleWorkflowSpec("simpleWorkflow");
    const command = spec.profile.states?.verify?.command;
    expect(command).toContain("npm run typecheck");
    expect(command).toContain("npm run build");
    expect(command).toContain("npm test");
    expect(command).not.toContain("validate:examples");
  });
});
