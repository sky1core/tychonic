import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectBundle } from "../src/temporal/workflowModules.js";

describe("inspectBundle defaultProfile extraction", () => {
  it("returns a TychonicConfig for a valid object literal", async () => {
    const workflowPath = await writeWorkflow(
      [
        "export const defaultProfile = {",
        "  version: 'tychonic.config.v1',",
        "  states: { verify: { type: 'verify', command: 'echo ok' } },",
        "  policies: { loop: { auto_continue: true, max_review_iterations: 3 } }",
        "};",
        generatedWorkflowDefinitionSource(),
        "export async function exampleWorkflow() { return 'ok'; }"
      ].join("\n")
    );
    const inspection = await inspectBundle({ name: "exampleWorkflow", workflowPath });
    expect(inspection.defaultProfile.version).toBe("tychonic.config.v1");
    expect(inspection.defaultProfile.states?.verify?.command).toBe("echo ok");
    expect(inspection.defaultProfile.policies?.loop?.max_review_iterations).toBe(3);
    expect(inspection.exportNames).toContain("defaultProfile");
    expect(inspection.exportNames).toContain("exampleWorkflow");
    expect(inspection.workflowFunctionNames).toContain("exampleWorkflow");
  });

  it("rejects a defaultProfile that fails the schema (wrong activity type)", async () => {
    const workflowPath = await writeWorkflow(
      [
        "export const defaultProfile = {",
        "  version: 'tychonic.config.v1',",
        "  states: { verify: { type: 'not_a_real_type', command: 'echo ok' } }",
        "};",
        generatedWorkflowDefinitionSource(),
        "export async function exampleWorkflow() { return 'ok'; }"
      ].join("\n")
    );
    await expect(inspectBundle({ name: "exampleWorkflow", workflowPath })).rejects.toThrow(
      /defaultProfile failed schema validation/
    );
  });

  it("rejects a workflow that does not export defaultProfile", async () => {
    const workflowPath = await writeWorkflow(
      [generatedWorkflowDefinitionSource(), "export async function exampleWorkflow() { return 'ok'; }"].join("\n")
    );
    await expect(inspectBundle({ name: "exampleWorkflow", workflowPath })).rejects.toThrow(
      /does not export a generated 'defaultProfile' object/
    );
  });

  it("rejects a bundle-name export that is not a workflow function", async () => {
    const workflowPath = await writeWorkflow(
      [
        "export const defaultProfile = {",
        "  version: 'tychonic.config.v1',",
        "  states: { verify: { type: 'verify', command: 'echo ok' } }",
        "};",
        generatedWorkflowDefinitionSource(),
        "export const exampleWorkflow = 123;"
      ].join("\n")
    );
    await expect(inspectBundle({ name: "exampleWorkflow", workflowPath })).rejects.toThrow(
      /does not match any exported workflow function/
    );
  });

  it("accepts a workflow function exported through an export list", async () => {
    const workflowPath = await writeWorkflow(
      [
        "const defaultProfile = {",
        "  version: 'tychonic.config.v1',",
        "  states: { verify: { type: 'verify', command: 'echo ok' } }",
        "};",
        "const workflowDefinition = { version: 'tychonic.workflow.v1', name: 'exampleWorkflow' };",
        "async function exampleWorkflow() { return 'ok'; }",
        "export { defaultProfile, workflowDefinition, exampleWorkflow };"
      ].join("\n")
    );
    const inspection = await inspectBundle({ name: "exampleWorkflow", workflowPath });
    expect(inspection.workflowFunctionNames).toContain("exampleWorkflow");
  });

  it("rejects a defaultProfile defined through a dynamic expression (function call)", async () => {
    const workflowPath = await writeWorkflow(
      [
        "function build() {",
        "  return { version: 'tychonic.config.v1' };",
        "}",
        "export const defaultProfile = build();",
        generatedWorkflowDefinitionSource(),
        "export async function exampleWorkflow() { return 'ok'; }"
      ].join("\n")
    );
    await expect(inspectBundle({ name: "exampleWorkflow", workflowPath })).rejects.toThrow(
      /generated metadata must be JSON-literal/
    );
  });

  it("rejects a defaultProfile that contains an interpolated template literal", async () => {
    const workflowPath = await writeWorkflow(
      [
        "const cmd = 'echo';",
        "export const defaultProfile = {",
        "  version: 'tychonic.config.v1',",
        "  states: { verify: { type: 'verify', command: `${cmd} ok` } }",
        "};",
        generatedWorkflowDefinitionSource(),
        "export async function exampleWorkflow() { return 'ok'; }"
      ].join("\n")
    );
    await expect(inspectBundle({ name: "exampleWorkflow", workflowPath })).rejects.toThrow(
      /template literal with interpolation is not supported/
    );
  });

  it("rejects an installed workflow.mjs that does not export generated workflowDefinition", async () => {
    const workflowPath = await writeWorkflow(
      [
        "export const defaultProfile = {",
        "  version: 'tychonic.config.v1',",
        "  states: { verify: { type: 'verify', command: 'echo ok' } }",
        "};",
        "export async function exampleWorkflow() { return 'ok'; }"
      ].join("\n")
    );
    await expect(inspectBundle({ name: "exampleWorkflow", workflowPath })).rejects.toThrow(
      /does not export a generated 'workflowDefinition' object/
    );
  });
});

function generatedWorkflowDefinitionSource(): string {
  return "export const workflowDefinition = { version: 'tychonic.workflow.v1', name: 'exampleWorkflow' };";
}

async function writeWorkflow(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tychonic-default-profile-"));
  const dir = join(root, "exampleWorkflow");
  await mkdir(dir, { recursive: true });
  const workflowPath = join(dir, "workflow.mjs");
  await writeFile(workflowPath, source, "utf8");
  return workflowPath;
}
