import { describe, expect, it } from "vitest";
import { validateTaskWorkflowInput } from "../src/inputValidation.js";
import { renderDeclarativePrompt } from "../src/workflow.js";
import {
  EXAMPLE_WORKFLOW_NAMES,
  loadExampleWorkflowSpec
} from "./exampleYamlHelpers.js";

describe("example workflow input contracts", () => {
  it("standard validator rejects undocumented top-level input fields", () => {
    expect(() =>
      validateTaskWorkflowInput({ cwd: "/tmp/tychonic-test", command: "npm test" })
    ).toThrow(/unsupported input field: command/);
  });

  it("standard validator rejects prompt additions without effective profile states", () => {
    expect(() =>
      validateTaskWorkflowInput({
        cwd: "/tmp/tychonic-test",
        promptAdditions: { architect: "inspect first" }
      })
    ).toThrow(/promptAdditions requires effective profile\.states/);
  });

  it("standard validator rejects prompt additions not keyed by configured promptable state", () => {
    expect(() =>
      validateTaskWorkflowInput({
        cwd: "/tmp/tychonic-test",
        profile: {
          version: "tychonic.config.v1",
          states: {
            architect: { type: "work", agent: "claude" },
            builder: { type: "work", agent: "kiro" },
            qa: { type: "review", on_fail_return_to: "builder", agent: "codex" }
          }
        },
        promptAdditions: { kiroPreReview: "inspect" }
      })
    ).toThrow(/unsupported promptAdditions state: kiroPreReview/);
  });

  it("YAML examples that accept a goal explicitly render it through prompt variables", async () => {
    for (const name of EXAMPLE_WORKFLOW_NAMES) {
      const spec = await loadExampleWorkflowSpec(name);
      const hasPrompt = Object.values(spec.states).some((state) => state.prompt !== undefined);
      if (!hasPrompt) continue;
      const promptedStates = Object.values(spec.states).filter((state) => state.prompt !== undefined);
      expect(promptedStates.some((state) => state.prompt?.includes("{{goal}}")), name).toBe(true);
    }
  });

  it("renders declarative goal prompt variables and fallback text", () => {
    expect(renderDeclarativePrompt("Goal:\n{{goal}}", { goal: "ship the change" })).toBe("Goal:\nship the change");
    expect(renderDeclarativePrompt("Goal:\n{{ goal }}", {})).toBe("Goal:\n(no explicit goal supplied)");
    expect(() => renderDeclarativePrompt("Goal:\n{{unknown}}", {})).toThrow(
      /unsupported declarative prompt variable unknown/
    );
  });

  it("prompt additions are limited to YAML-declared work and review states", async () => {
    const spec = await loadExampleWorkflowSpec("architectBuilderFirstReviewQaWorkflow");
    const promptableStates = Object.entries(spec.profile.states ?? {})
      .filter(([, block]) => block.type === "work" || block.type === "review")
      .map(([name]) => name)
      .sort();
    expect(promptableStates).toEqual(["architect", "builder", "final_qa", "first_review"]);
  });
});
