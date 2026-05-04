import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = new URL("../examples/workflows/checkpointWorkflow/workflow.mjs", import.meta.url);

describe("checkpointWorkflow bundle example", () => {
  it("passes the optional goal into both review prompts", async () => {
    const source = await readFile(WORKFLOW_PATH, "utf8");

    expect(source).toContain('ctx.review("semantic_review", structuredReviewPrompt("changes", input.goal))');
    expect(source).toContain('ctx.review("test_review", structuredReviewPrompt("test coverage", input.goal))');
    expect(source).toContain("Workflow goal and review scope:");
  });
});
