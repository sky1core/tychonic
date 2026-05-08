import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { stoppedWorkflowMessage } from "../src/cli/waitMessages.js";

describe("documentation consistency", () => {
  it("keeps README success wait examples aligned with the CLI message", async () => {
    const message = stoppedWorkflowMessage({
      reason: "run_status",
      workflowId: "wf_123",
      status: "succeeded"
    });
    const example = `{ "ok": true, "message": ${JSON.stringify(message)}, "workflowId": "wf_123", "status": "succeeded" }`;

    await expect(readFile("README.md", "utf8")).resolves.toContain(example);
    await expect(readFile("README.ko.md", "utf8")).resolves.toContain(example);
  });

  it("documents that wait output does not carry the full raw run result", async () => {
    const spec = await readFile("SPEC.md", "utf8");

    expect(spec).toContain("The wait payload does not include the full raw run result.");
    expect(spec).not.toContain("`result` carries the full run result");
  });

  it("does not document success-worded ctx.finish summaries", async () => {
    const docs = [
      "docs/plugin-workflows.md",
      "skills/tychonic-cli/workflow-module-contract.md"
    ];
    const successFinishPattern =
      /ctx\.finish\(\s*(?:"[^"]*(?:completed|finished|succeeded|success)|`[^`]*(?:completed|finished|succeeded|success))/;

    for (const doc of docs) {
      await expect(readFile(doc, "utf8"), doc).resolves.not.toMatch(successFinishPattern);
    }
  });

  it("keeps retired per-workflow prompt input fields out of public examples", async () => {
    const retiredFields = [
      "architectPrompt",
      "builderPrompt",
      "qaPrompt",
      "kiroPreReviewPrompt",
      "kiroFixPrompt",
      "finalQaPrompt",
      "reviewPrompt",
      "reviewPrompt2"
    ];
    const exampleDirs = await readdir("examples/workflows", { withFileTypes: true });
    const publicExampleFiles = exampleDirs
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => [
        `examples/workflows/${entry.name}/README.md`,
        `examples/workflows/${entry.name}/workflow.mjs`
      ]);
    const files = [
      "README.md",
      "README.ko.md",
      "docs/plugin-workflows.md",
      "skills/tychonic-cli/SKILL.md",
      "skills/tychonic-cli/workflow-module-contract.md",
      "scripts/tychonic-bootstrap-check.mjs",
      ...publicExampleFiles
    ];

    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const field of retiredFields) {
        expect(text, `${file} must not expose ${field}`).not.toContain(field);
      }
    }
  });
});
