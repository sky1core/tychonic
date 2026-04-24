import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = new URL("../examples/workflows/pipelineWorkflow/workflow.mjs", import.meta.url);
const CONFIG_PATH = new URL("../examples/workflows/pipelineWorkflow/config.yaml", import.meta.url);

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

  it("declares its required state set via the requires export", async () => {
    const source = await readFile(WORKFLOW_PATH, "utf8");
    expect(source).toContain("export const requires");
    expect(source).toContain("{ name: \"work\", type: \"work\" }");
    expect(source).toContain("{ name: \"review_1\", type: \"review\" }");
  });

  it("ships its config.yaml with matching state blocks", async () => {
    const config = await readFile(CONFIG_PATH, "utf8");
    expect(config).toContain("version: tychonic.config.v1");
    expect(config).toContain("review_1:");
    expect(config).toContain("review_2:");
    expect(config).toContain("security:");
  });
});
