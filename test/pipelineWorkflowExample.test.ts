import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectBundle } from "../src/temporal/workflowModules.js";

const WORKFLOW_PATH = new URL("../examples/workflows/pipelineWorkflow/workflow.mjs", import.meta.url);
const WORKFLOW_FILE_PATH = fileURLToPath(WORKFLOW_PATH);

describe("pipelineWorkflow bundle example", () => {
  it("falls back to goal when launched through the generic workflow starter", async () => {
    const source = await readFile(WORKFLOW_PATH, "utf8");
    expect(source).toContain("prompt: input.prompt ?? input.goal ?? \"\"");
  });

  it("routes blocked review stages to triage instead of falling through to success", async () => {
    const source = await readFile(WORKFLOW_PATH, "utf8");
    expect(source).toContain("gateReviewStage(run, review1, \"review_1\")");
    expect(source).toContain("addReviewTriageInbox");
  });

  it("uses a structured review contract by default", async () => {
    const source = await readFile(WORKFLOW_PATH, "utf8");
    expect(source).toContain("structuredReviewPrompt(\"work stages 1-3\")");
    expect(source).toContain("\"schema_version\": \"tychonic.review.v1\"");
  });

  it("declares its workflow-default profile via the defaultProfile export", async () => {
    const inspection = await inspectBundle({
      name: "pipelineWorkflow",
      workflowPath: WORKFLOW_FILE_PATH
    });
    const states = inspection.defaultProfile.states ?? {};
    expect(states.work?.type).toBe("work");
    expect(states.review_1?.type).toBe("review");
    expect(states.review_2?.type).toBe("review");
    expect(states.security?.type).toBe("verify");
    expect(states.integration?.type).toBe("integration");
    expect(inspection.defaultProfile.version).toBe("tychonic.config.v1");
  });
});
