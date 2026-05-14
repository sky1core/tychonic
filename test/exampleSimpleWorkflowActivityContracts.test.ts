import { describe, expect, it } from "vitest";
import {
  loadExampleWorkflowSpec,
  loadGeneratedExampleWorkflowSource
} from "./exampleYamlHelpers.js";

describe("simpleWorkflow YAML activity contract", () => {
  it("declares work, verify, and review states in workflow.yaml", async () => {
    const spec = await loadExampleWorkflowSpec("simpleWorkflow");
    expect(spec.states.work?.type).toBe("work");
    expect(spec.states.verify?.type).toBe("verify");
    expect(spec.states.review?.type).toBe("review");
    expect(spec.profile.states?.review?.on_fail_return_to).toBe("work");
  });

  it("generates work -> verify -> review -> work failure routing with feedback", async () => {
    const source = await loadGeneratedExampleWorkflowSource("simpleWorkflow");
    expect(source).toContain('const result = await ctx.work("work"');
    expect(source).toContain('const result = await ctx.verify("verify");');
    expect(source).toContain('const result = await ctx.review("review"');
    expect(source).toContain('const returnTo = assertReviewFailReturnTo(input.profile, "review", "work");');
    expect(source).toContain(
      'addDeclarativeReviewFeedback(feedbacksByState, returnTo, declarativeReviewFeedback("review", result));'
    );
    expect(source).toContain('current = returnTo;');
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
