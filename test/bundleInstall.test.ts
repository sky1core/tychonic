import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installRuntimeWorkflowModule,
  listRuntimeWorkflowModules,
  packagedWorkflowBundleRoot,
  removeRuntimeWorkflowModule,
  runtimeWorkflowModulesDir
} from "../src/temporal/workflowModules.js";

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
        "export const requires = { states: [ { name: 'verify', type: 'verify' } ] };",
        "export async function exampleWorkflow() { return 'ok'; }"
      ].join("\n")
    });

    const installed = await installRuntimeWorkflowModule({ sourcePath: bundleDir });
    expect(installed.name).toBe("exampleWorkflow");
    expect(installed.path).toBe(join(runtimeWorkflowModulesDir(), "exampleWorkflow"));
    expect(installed.workflowPath).toBe(join(installed.path, "workflow.mjs"));
    expect(installed.configPath).toBe(join(installed.path, "config.yaml"));

    const entries = await readdir(installed.path);
    expect(new Set(entries)).toEqual(new Set(["workflow.mjs", "config.yaml", "README.md"]));

    const list = await listRuntimeWorkflowModules();
    expect(list.map((entry) => entry.name)).toEqual(["exampleWorkflow"]);

    const removed = await removeRuntimeWorkflowModule("exampleWorkflow");
    expect(removed.name).toBe("exampleWorkflow");
    const after = await listRuntimeWorkflowModules();
    expect(after.map((entry) => entry.name)).toEqual([]);
  });

  it("rejects a bundle whose directory name differs from the exported workflow function name", async () => {
    const bundleDir = await makeFixtureBundle({
      name: "wrongName",
      workflowSource: [
        "export const requires = { states: [ { name: 'verify', type: 'verify' } ] };",
        "export async function exampleWorkflow() { return 'ok'; }"
      ].join("\n"),
      config: "version: tychonic.config.v1\nstates:\n  verify:\n    type: verify\n    command: echo ok\n"
    });
    await expect(installRuntimeWorkflowModule({ sourcePath: bundleDir })).rejects.toThrow(
      /does not match any exported workflow function/
    );
  });

  it("rejects a bundle with unexpected extra files", async () => {
    const bundleDir = await makeFixtureBundle({
      name: "exampleWorkflow",
      workflowSource: [
        "export const requires = { states: [ { name: 'verify', type: 'verify' } ] };",
        "export async function exampleWorkflow() { return 'ok'; }"
      ].join("\n")
    });
    await writeFile(join(bundleDir, "extra.json"), "{}", "utf8");
    await expect(installRuntimeWorkflowModule({ sourcePath: bundleDir })).rejects.toThrow(/extra\.json/);
  });

  it("rejects a bundle whose config.yaml is missing a required state block", async () => {
    const bundleDir = await makeFixtureBundle({
      name: "exampleWorkflow",
      workflowSource: [
        "export const requires = { states: [ { name: 'verify', type: 'verify' } ] };",
        "export async function exampleWorkflow() { return 'ok'; }"
      ].join("\n"),
      config: "version: tychonic.config.v1\nstates: {}\n"
    });
    await expect(installRuntimeWorkflowModule({ sourcePath: bundleDir })).rejects.toThrow(/no matching states\.verify block/);
  });

  it("packagedWorkflowBundleRoot points at dist/workflow-bundles", () => {
    const root = packagedWorkflowBundleRoot("/tmp/pkg");
    expect(root).toBe("/tmp/pkg/dist/workflow-bundles");
  });
});

async function makeFixtureBundle(options: {
  name: string;
  workflowSource: string;
  config?: string;
  readme?: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `tychonic-bundle-src-${options.name}-`));
  const bundleDir = join(root, options.name);
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, "workflow.mjs"), options.workflowSource, "utf8");
  const defaultConfig = "version: tychonic.config.v1\nstates:\n  verify:\n    type: verify\n    command: echo ok\n";
  await writeFile(join(bundleDir, "config.yaml"), options.config ?? defaultConfig, "utf8");
  await writeFile(join(bundleDir, "README.md"), options.readme ?? "# fixture\n", "utf8");
  return bundleDir;
}
