import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bundle modules export plain JS, no TS types.
import { checkpointWorkflow } from "../examples/workflows/checkpointWorkflow/workflow.mjs";
import { architectBuilderQaWorkflow } from "../examples/workflows/architectBuilderQaWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { architectBuilderFinalQaWorkflow } from "../examples/workflows/architectBuilderFinalQaWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { architectBuilderFirstReviewQaWorkflow } from "../examples/workflows/architectBuilderFirstReviewQaWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { architectBuilderReviewRepairQaWorkflow } from "../examples/workflows/architectBuilderReviewRepairQaWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { pipelineWorkflow } from "../examples/workflows/pipelineWorkflow/workflow.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { verifyOnlyWorkflow } from "../examples/workflows/verifyOnlyWorkflow/workflow.mjs";
import { validateTaskWorkflowInput } from "../src/inputValidation.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { defaultProfile as structuralIssueDiscoveryProfile } from "../examples/workflows/structuralIssueDiscoveryWorkflow/workflow.mjs";

describe("example workflow input contracts", () => {
  it("rejects task input without cwd before starting activities", async () => {
    await expect(
      checkpointWorkflow({ goal: "inspect" })
    ).rejects.toThrow(/cwd must be a non-empty string/);
  });

  it("checkpointWorkflow rejects undocumented input fields", async () => {
    await expect(
      checkpointWorkflow({ cwd: "/tmp/tychonic-test", autonomy: "review" })
    ).rejects.toThrow(/unsupported input field: autonomy/);
  });

  it("architectBuilderQaWorkflow rejects undocumented input fields", async () => {
    await expect(
      architectBuilderQaWorkflow({ cwd: "/tmp/tychonic-test", runId: "manual" })
    ).rejects.toThrow(/unsupported input field: runId/);
  });

  it("architectBuilderFinalQaWorkflow rejects undocumented input fields", async () => {
    await expect(
      architectBuilderFinalQaWorkflow({ cwd: "/tmp/tychonic-test", reviewer: "kiro" })
    ).rejects.toThrow(/unsupported input field: reviewer/);
  });

  it("architectBuilderFirstReviewQaWorkflow rejects undocumented input fields", async () => {
    await expect(
      architectBuilderFirstReviewQaWorkflow({ cwd: "/tmp/tychonic-test", reviewerAgent: "kiro" })
    ).rejects.toThrow(/unsupported input field: reviewerAgent/);
  });

  it("architectBuilderReviewRepairQaWorkflow rejects undocumented input fields", async () => {
    await expect(
      architectBuilderReviewRepairQaWorkflow({ cwd: "/tmp/tychonic-test", repairAgent: "kiro" })
    ).rejects.toThrow(/unsupported input field: repairAgent/);
  });

  it("pipelineWorkflow rejects undocumented input fields", async () => {
    await expect(
      pipelineWorkflow({ cwd: "/tmp/tychonic-test", verifyCommand: "npm test" })
    ).rejects.toThrow(/unsupported input field: verifyCommand/);
  });

  it("rejects retired top-level prompt override fields", async () => {
    await expect(
      architectBuilderReviewRepairQaWorkflow({
        cwd: "/tmp/tychonic-test",
        kiroPreReviewPrompt: "inspect"
      })
    ).rejects.toThrow(/unsupported input field: kiroPreReviewPrompt/);
  });

  it("rejects prompt additions when effective profile states are absent", async () => {
    await expect(
      architectBuilderQaWorkflow({
        cwd: "/tmp/tychonic-test",
        promptAdditions: { architect: "inspect first" }
      })
    ).rejects.toThrow(/promptAdditions requires effective profile\.states/);
  });

  it("rejects prompt additions that are not keyed by a promptable state NAME", async () => {
    await expect(
      architectBuilderQaWorkflow({
        cwd: "/tmp/tychonic-test",
        profile: {
          states: {
            architect: { type: "work" },
            builder: { type: "work" },
            qa: { type: "review" }
          }
        },
        promptAdditions: { kiroPreReview: "inspect" }
      })
    ).rejects.toThrow(/unsupported promptAdditions state: kiroPreReview/);
  });

  it("rejects prompt additions that do not match a configured state", async () => {
    await expect(
      architectBuilderQaWorkflow({
        cwd: "/tmp/tychonic-test",
        profile: {
          states: {
            architect: { type: "work" },
            builder: { type: "work" }
          }
        },
        promptAdditions: { qa: "review carefully" }
      })
    ).rejects.toThrow(/unsupported promptAdditions state: qa/);
  });

  it("rejects non-string prompt addition values", async () => {
    await expect(
      pipelineWorkflow({
        cwd: "/tmp/tychonic-test",
        profile: {
          states: {
            review_1: { type: "review", agent: "claude" }
          }
        },
        promptAdditions: { review_1: ["review"] }
      })
    ).rejects.toThrow(/promptAdditions\.review_1 must be a non-empty string/);
  });

  it("verifyOnlyWorkflow rejects undocumented input fields", async () => {
    await expect(
      verifyOnlyWorkflow({ cwd: "/tmp/tychonic-test", command: "npm test" })
    ).rejects.toThrow(/unsupported input field: command/);
  });

  it("structuralIssueDiscoveryWorkflow accepts prompt additions only for promptable state NAMEs", () => {
    expect(() =>
      validateTaskWorkflowInput({
        cwd: "/tmp/tychonic-test",
        profile: structuralIssueDiscoveryProfile,
        promptAdditions: {
          workflow_review: "look at recovery",
          adapter_review: "look at parser",
          docs_review: "look at README",
          finding_audit: "audit duplicates"
        }
      })
    ).not.toThrow();

    expect(() =>
      validateTaskWorkflowInput({
        cwd: "/tmp/tychonic-test",
        profile: structuralIssueDiscoveryProfile,
        promptAdditions: { claude: "agent names are not state names" }
      })
    ).toThrow(/unsupported promptAdditions state: claude/);
  });

  it("structuralIssueDiscoveryWorkflow rejects undocumented top-level fields", () => {
    expect(() =>
      validateTaskWorkflowInput({
        cwd: "/tmp/tychonic-test",
        knownIssues: []
      })
    ).toThrow(/unsupported input field: knownIssues/);
  });
});
