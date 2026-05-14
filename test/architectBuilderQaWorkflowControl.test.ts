import { describe, expect, it } from "vitest";
import {
  generateDeclarativeWorkflowModule,
  parseDeclarativeWorkflowSpecYaml
} from "../src/declarative/workflowSpec.js";
import {
  loadExampleWorkflowSpec,
  loadGeneratedExampleWorkflowSource
} from "./exampleYamlHelpers.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("architect/builder/QA YAML control flow", () => {
  it("routes QA failure back to builder in the generated wrapper", async () => {
    const source = await loadGeneratedExampleWorkflowSource("architectBuilderQaWorkflow");
    expect(source).toContain('let current = "architect";');
    expect(source).toContain('current = "builder";');
    expect(source).toContain('const returnTo = assertReviewFailReturnTo(input.profile, "qa", "builder");');
    expect(source).toContain(
      'addDeclarativeReviewFeedback(feedbacksByState, returnTo, declarativeReviewFeedback("qa", result));'
    );
    expect(source).toContain("finishWaitingUser(");
  });

  it("routes both first_review and final_qa failures back to builder", async () => {
    const source = await loadGeneratedExampleWorkflowSource("architectBuilderFirstReviewQaWorkflow");
    expect(source).toContain('const returnTo = assertReviewFailReturnTo(input.profile, "first_review", "builder");');
    expect(source).toContain('const returnTo = assertReviewFailReturnTo(input.profile, "final_qa", "builder");');
    expect(source).toContain('current = "final_qa";');
  });

  it("keeps final QA role split from Kiro builder", async () => {
    const spec = await loadExampleWorkflowSpec("architectBuilderFinalQaWorkflow");
    expect(spec.profile.states?.builder).toMatchObject({
      type: "work",
      agent: "kiro",
      model: "claude-opus-4.6",
      trust_all_tools: true
    });
    expect(spec.profile.states?.qa).toMatchObject({
      type: "review",
      agent: "codex",
      model: "gpt-5.5",
      reasoning_effort: "xhigh"
    });
  });
});

describe("single-pass workflow completion summaries", () => {
  it("generated example workflows do not force success-worded finish summaries", async () => {
    const workflowNames = [
      "architectBuilderQaWorkflow",
      "architectBuilderFinalQaWorkflow",
      "architectBuilderFirstReviewQaWorkflow",
      "checkpointWorkflow",
      "pipelineWorkflow",
      "verifyOnlyWorkflow"
    ] as const;
    const successFinishPattern =
      /ctx\.finish\(\s*(?:"[^"]*(?:completed|finished|succeeded|success)|`[^`]*(?:completed|finished|succeeded|success))/;

    for (const workflowName of workflowNames) {
      const source = await loadGeneratedExampleWorkflowSource(workflowName);
      expect(source, workflowName).not.toMatch(successFinishPattern);
    }
  });

  it("does not force a success summary onto the self-check workflow", async () => {
    const name = "tychonicSelfCheckWorkflow";
    const yaml = await readFile(join(process.cwd(), "tools", "workflows", name, "workflow.yaml"), "utf8");
    const spec = parseDeclarativeWorkflowSpecYaml({ bundleName: name, source: yaml });
    const source = generateDeclarativeWorkflowModule({ bundleName: name, spec });
    const successFinishPattern =
      /ctx\.finish\(\s*(?:"[^"]*(?:completed|finished|succeeded|success)|`[^`]*(?:completed|finished|succeeded|success))/;
    expect(source).not.toMatch(successFinishPattern);
  });
});
