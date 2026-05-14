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

  it("keeps pending interaction wait examples aligned with the CLI message", async () => {
    const message = stoppedWorkflowMessage({
      reason: "pending_interaction",
      workflowId: "wf_123",
      pendingState: "qa"
    });
    const messageField = `"message": ${JSON.stringify(message)}`;

    await expect(readFile("README.md", "utf8")).resolves.toContain(messageField);
    await expect(readFile("README.ko.md", "utf8")).resolves.toContain(messageField);
    await expect(readFile("skills/tychonic-cli/SKILL.md", "utf8")).resolves.toContain(messageField);
  });

  it("documents that wait output does not carry the full raw run result", async () => {
    const spec = await readFile("src/cli/SPEC.md", "utf8");

    expect(spec).toContain("The wait payload does not include the full raw run result.");
    expect(spec).not.toContain("`result` carries the full run result");
  });

  it("keeps the root SPEC linked to every module SPEC", async () => {
    const rootSpec = await readFile("SPEC.md", "utf8");
    const moduleSpecs = [
      "src/workflows/SPEC.md",
      "src/domain/SPEC.md",
      "src/activities/SPEC.md",
      "src/bootstrap/SPEC.md",
      "src/temporal/SPEC.md",
      "src/catalog/SPEC.md",
      "src/contracts/SPEC.md",
      "src/adapters/SPEC.md",
      "src/review/SPEC.md",
      "src/interaction/SPEC.md",
      "src/cli/SPEC.md",
      "src/runtime/SPEC.md",
      "src/service/SPEC.md",
      "src/storage/SPEC.md",
      "src/web/SPEC.md",
      "examples/workflows/SPEC.md"
    ];

    for (const specPath of moduleSpecs) {
      await expect(readFile(specPath, "utf8"), specPath).resolves.toContain("# ");
      expect(rootSpec, `root SPEC must link ${specPath}`).toContain(`[${specPath}](${specPath})`);
    }
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
        `examples/workflows/${entry.name}/workflow.yaml`
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
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      for (const field of retiredFields) {
        expect(text, `${file} must not expose ${field}`).not.toContain(field);
      }
    }
  });

  it("keeps standard interaction command examples complete in bundle READMEs", async () => {
    const exampleDirs = await readdir("examples/workflows", { withFileTypes: true });
    const bundleReadmes = exampleDirs
      .filter((entry) => entry.isDirectory())
      .map((entry) => `examples/workflows/${entry.name}/README.md`);

    for (const readme of bundleReadmes) {
      const text = await readFile(readme, "utf8");
      if (text.includes("standard Tychonic interaction commands")) {
        expect(text, `${readme} must include the full standard interaction command set`).toContain(
          "tychonic rerun"
        );
      }
    }
  });
});
