import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installRuntimeWorkflowModule,
  listRuntimeWorkflowModules,
  removeRuntimeWorkflowModule,
  runtimeWorkflowModulesDir
} from "../src/temporal/workflowModules.js";

const DEFAULT_PROFILE_LITERAL = [
  "export const defaultProfile = {",
  "  version: 'tychonic.config.v1',",
  "  states: { verify: { type: 'verify', command: 'echo ok' } }",
  "};"
].join("\n");

describe("workflow bundle install", () => {
  let stateRoot: string;
  let savedStateHome: string | undefined;

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "tychonic-bundle-install-"));
    savedStateHome = process.env.TYCHONIC_STATE_HOME;
    process.env.TYCHONIC_STATE_HOME = stateRoot;
  });

  afterEach(() => {
    if (savedStateHome === undefined) {
      delete process.env.TYCHONIC_STATE_HOME;
    } else {
      process.env.TYCHONIC_STATE_HOME = savedStateHome;
    }
  });

  it("installs a bundle directory, lists it, and removes it", async () => {
    const bundleDir = await makeFixtureBundle({
      name: "exampleWorkflow",
      workflowSource: [
        DEFAULT_PROFILE_LITERAL,
        "export async function exampleWorkflow() { return 'ok'; }"
      ].join("\n")
    });

    const installed = await installRuntimeWorkflowModule({ sourcePath: bundleDir });
    expect(installed.name).toBe("exampleWorkflow");
    expect(installed.path).toBe(join(runtimeWorkflowModulesDir(), "exampleWorkflow"));
    expect(installed.workflowPath).toBe(join(installed.path, "workflow.mjs"));

    const entries = await readdir(installed.path);
    expect(new Set(entries)).toEqual(new Set(["workflow.mjs", "README.md"]));

    const list = await listRuntimeWorkflowModules();
    expect(list.map((entry) => entry.name)).toEqual(["exampleWorkflow"]);

    const removed = await removeRuntimeWorkflowModule("exampleWorkflow");
    expect(removed.name).toBe("exampleWorkflow");
    const after = await listRuntimeWorkflowModules();
    expect(after.map((entry) => entry.name)).toEqual([]);
  });

  it("installs a bundle whose defaultProfile is exported through an export list", async () => {
    const bundleDir = await makeFixtureBundle({
      name: "bundledWorkflow",
      workflowSource: [
        "var defaultProfile = {",
        "  version: 'tychonic.config.v1',",
        "  states: { verify: { type: 'verify', command: 'echo ok' } }",
        "};",
        "async function bundledWorkflow() { return 'ok'; }",
        "export { bundledWorkflow, defaultProfile };"
      ].join("\n")
    });

    const installed = await installRuntimeWorkflowModule({ sourcePath: bundleDir });

    expect(installed.name).toBe("bundledWorkflow");
    expect((await listRuntimeWorkflowModules()).map((entry) => entry.name)).toEqual(["bundledWorkflow"]);
  });

  it("installs a bundle without a README.md", async () => {
    const bundleDir = await makeFixtureBundle({
      name: "noReadmeWorkflow",
      workflowSource: [
        DEFAULT_PROFILE_LITERAL,
        "export async function noReadmeWorkflow() { return 'ok'; }"
      ].join("\n"),
      omitReadme: true
    });
    const installed = await installRuntimeWorkflowModule({ sourcePath: bundleDir });
    expect(installed.name).toBe("noReadmeWorkflow");
    const entries = await readdir(installed.path);
    expect(new Set(entries)).toEqual(new Set(["workflow.mjs"]));
  });

  it("rejects a bundle whose directory name differs from the exported workflow function name", async () => {
    const bundleDir = await makeFixtureBundle({
      name: "wrongName",
      workflowSource: [
        DEFAULT_PROFILE_LITERAL,
        "export async function exampleWorkflow() { return 'ok'; }"
      ].join("\n")
    });
    await expect(installRuntimeWorkflowModule({ sourcePath: bundleDir })).rejects.toThrow(
      /does not match any exported workflow function/
    );
  });

  it("installs a standard package-shaped bundle directory verbatim", async () => {
    const bundleDir = await makeFixtureBundle({
      name: "exampleWorkflow",
      workflowSource: [
        DEFAULT_PROFILE_LITERAL,
        "export async function exampleWorkflow() { return 'ok'; }"
      ].join("\n")
    });
    await writeFile(
      join(bundleDir, "package.json"),
      JSON.stringify({ name: "exampleWorkflow", private: true, type: "module" }),
      "utf8"
    );
    await writeFile(join(bundleDir, "package-lock.json"), "{}", "utf8");
    await writeFile(join(bundleDir, "helper.mjs"), "export const helper = true;\n", "utf8");
    await mkdir(join(bundleDir, "node_modules", "local-helper"), { recursive: true });
    await writeFile(
      join(bundleDir, "node_modules", "local-helper", "package.json"),
      JSON.stringify({ name: "local-helper", type: "module" }),
      "utf8"
    );

    const installed = await installRuntimeWorkflowModule({ sourcePath: bundleDir });
    const entries = await readdir(installed.path);
    expect(new Set(entries)).toEqual(
      new Set(["workflow.mjs", "README.md", "package.json", "package-lock.json", "helper.mjs", "node_modules"])
    );
  });

  it("rejects a bundle that does not export a defaultProfile object", async () => {
    const bundleDir = await makeFixtureBundle({
      name: "exampleWorkflow",
      workflowSource: [
        "export async function exampleWorkflow() { return 'ok'; }"
      ].join("\n")
    });
    await expect(installRuntimeWorkflowModule({ sourcePath: bundleDir })).rejects.toThrow(
      /does not export a 'defaultProfile' object/
    );
  });

  it("rejects a bundle whose defaultProfile fails schema validation", async () => {
    const bundleDir = await makeFixtureBundle({
      name: "exampleWorkflow",
      workflowSource: [
        // Wrong activity type for `verify` — schema must reject.
        "export const defaultProfile = {",
        "  version: 'tychonic.config.v1',",
        "  states: { verify: { type: 'bogus_type', command: 'echo ok' } }",
        "};",
        "export async function exampleWorkflow() { return 'ok'; }"
      ].join("\n")
    });
    await expect(installRuntimeWorkflowModule({ sourcePath: bundleDir })).rejects.toThrow(
      /defaultProfile failed schema validation/
    );
  });

});

async function makeFixtureBundle(options: {
  name: string;
  workflowSource: string;
  readme?: string;
  omitReadme?: boolean;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `tychonic-bundle-src-${options.name}-`));
  const bundleDir = join(root, options.name);
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, "workflow.mjs"), options.workflowSource, "utf8");
  if (!options.omitReadme) {
    await writeFile(join(bundleDir, "README.md"), options.readme ?? "# fixture\n", "utf8");
  }
  return bundleDir;
}
