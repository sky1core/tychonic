import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installRuntimeWorkflowModule,
  inspectBundle,
  listRuntimeWorkflowModules,
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
    const bundleDir = await makeDeclarativeFixtureBundle({ name: "exampleWorkflow" });

    const installed = await installRuntimeWorkflowModule({ sourcePath: bundleDir });
    expect(installed.name).toBe("exampleWorkflow");
    expect(installed.path).toBe(join(runtimeWorkflowModulesDir(), "exampleWorkflow"));
    expect(installed.workflowPath).toBe(join(installed.path, "workflow.mjs"));

    const entries = await readdir(installed.path);
    expect(new Set(entries)).toEqual(
      new Set(["workflow.yaml", "workflow.mjs", "workflow.generated.mmd", "README.md"])
    );

    const list = await listRuntimeWorkflowModules();
    expect(list.map((entry) => entry.name)).toEqual(["exampleWorkflow"]);

    const removed = await removeRuntimeWorkflowModule("exampleWorkflow");
    expect(removed.name).toBe("exampleWorkflow");
    const after = await listRuntimeWorkflowModules();
    expect(after.map((entry) => entry.name)).toEqual([]);
  });

  it("installs a bundle without a README.md", async () => {
    const bundleDir = await makeDeclarativeFixtureBundle({ name: "noReadmeWorkflow", omitReadme: true });
    const installed = await installRuntimeWorkflowModule({ sourcePath: bundleDir });
    expect(installed.name).toBe("noReadmeWorkflow");
    const entries = await readdir(installed.path);
    expect(new Set(entries)).toEqual(new Set(["workflow.yaml", "workflow.mjs", "workflow.generated.mmd"]));
  });

  it("installs a declarative workflow.yaml bundle with generated module and Mermaid", async () => {
    const bundleDir = await makeDeclarativeFixtureBundle({
      name: "yamlWorkflow",
      yaml: [
        "version: tychonic.workflow.v1",
        "name: yamlWorkflow",
        "worktree: false",
        "max_steps: 3",
        "start: verify",
        "states:",
        "  verify:",
        "    type: verify",
        "    command: echo ok",
        "    on_pass:",
        "      finish: true",
        "    on_fail:",
        "      finish: verify failed",
        ""
      ].join("\n")
    });

    const installed = await installRuntimeWorkflowModule({ sourcePath: bundleDir });
    expect(installed.name).toBe("yamlWorkflow");
    expect(installed.workflowPath).toBe(join(installed.path, "workflow.mjs"));

    const entries = await readdir(installed.path);
    expect(new Set(entries)).toEqual(
      new Set(["workflow.yaml", "workflow.mjs", "workflow.generated.mmd", "README.md"])
    );
    const generatedWorkflow = await readFile(join(installed.path, "workflow.mjs"), "utf8");
    expect(generatedWorkflow).toContain("createTychonicWorkflowContext");
    expect(generatedWorkflow).toContain("case \"verify\"");
    expect(generatedWorkflow).not.toContain(bundleDir);
    await expect(readFile(join(installed.path, "workflow.generated.mmd"), "utf8")).resolves.toContain(
      "s0 -->|pass| __finish"
    );

    const list = await listRuntimeWorkflowModules();
    expect(list.map((entry) => entry.name)).toEqual(["yamlWorkflow"]);
    const inspection = await inspectBundle({ name: installed.name, workflowPath: installed.workflowPath });
    expect(inspection.workflowFunctionNames).toEqual(["yamlWorkflow"]);
    expect(inspection.defaultProfile.states?.verify?.type).toBe("verify");
  });

  it("rejects a bundle whose directory name differs from workflow.yaml name", async () => {
    const bundleDir = await makeDeclarativeFixtureBundle({
      name: "wrongName",
      yaml: minimalWorkflowYaml("exampleWorkflow")
    });
    await expect(installRuntimeWorkflowModule({ sourcePath: bundleDir })).rejects.toThrow(
      /workflow\.yaml name "exampleWorkflow" must match bundle directory name "wrongName"/
    );
  });

  it("installs a standard package-shaped bundle directory verbatim", async () => {
    const bundleDir = await makeDeclarativeFixtureBundle({ name: "exampleWorkflow" });
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
      new Set([
        "workflow.yaml",
        "workflow.mjs",
        "workflow.generated.mmd",
        "README.md",
        "package.json",
        "package-lock.json",
        "helper.mjs",
        "node_modules"
      ])
    );
  });

  it("rejects hand-written workflow.mjs source bundles", async () => {
    const root = await mkdtemp(join(tmpdir(), "tychonic-bundle-src-js-"));
    const bundleDir = join(root, "exampleWorkflow");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "workflow.mjs"), "export async function exampleWorkflow() {}\n", "utf8");
    await expect(installRuntimeWorkflowModule({ sourcePath: bundleDir })).rejects.toThrow(
      /must not contain hand-written 'workflow\.mjs'/
    );
  });

  it("rejects workflow.yaml whose derived profile fails schema validation", async () => {
    const bundleDir = await makeDeclarativeFixtureBundle({
      name: "exampleWorkflow",
      yaml: [
        "version: tychonic.workflow.v1",
        "name: exampleWorkflow",
        "worktree: false",
        "max_steps: 3",
        "start: verify",
        "states:",
        "  verify:",
        "    type: verify",
        "    agent: claude",
        "    on_pass:",
        "      finish: true",
        "    on_fail:",
        "      finish: verify failed",
        ""
      ].join("\n")
    });
    await expect(installRuntimeWorkflowModule({ sourcePath: bundleDir })).rejects.toThrow(
      /states.<name>.command is required for type verify/
    );
  });

  it("rejects a declarative workflow.yaml whose review fail target is review", async () => {
    const bundleDir = await makeDeclarativeFixtureBundle({
      name: "badYamlWorkflow",
      yaml: [
        "version: tychonic.workflow.v1",
        "name: badYamlWorkflow",
        "worktree: true",
        "max_steps: 4",
        "start: work",
        "states:",
        "  work:",
        "    type: work",
        "    agent: claude",
        "    prompt: work",
        "    on_pass:",
        "      goto: review",
        "    on_fail:",
        "      finish: work failed",
        "  review:",
        "    type: review",
        "    agent: codex",
        "    on_fail_return_to: review_fix",
        "    prompt: review",
        "    on_pass:",
        "      finish: true",
        "    on_fail:",
        "      goto: review_fix",
        "  review_fix:",
        "    type: review",
        "    agent: claude",
        "    on_fail_return_to: work",
        "    prompt: fix review",
        "    on_pass:",
        "      finish: true",
        "    on_fail:",
        "      goto: work",
        ""
      ].join("\n")
    });

    await expect(installRuntimeWorkflowModule({ sourcePath: bundleDir })).rejects.toThrow(
      /on_fail_return_to must name a non-review state/
    );
  });

  it("rejects declarative workflow.yaml files without an explicit name", async () => {
    const bundleDir = await makeDeclarativeFixtureBundle({
      name: "missingNameWorkflow",
      yaml: [
        "version: tychonic.workflow.v1",
        "worktree: false",
        "max_steps: 3",
        "start: verify",
        "states:",
        "  verify:",
        "    type: verify",
        "    command: echo ok",
        "    on_pass:",
        "      finish: true",
        "    on_fail:",
        "      finish: verify failed",
        ""
      ].join("\n")
    });

    await expect(installRuntimeWorkflowModule({ sourcePath: bundleDir })).rejects.toThrow(
      /workflow\.yaml failed schema validation/
    );
  });

  it("rejects prompt on declarative verify states", async () => {
    const bundleDir = await makeDeclarativeFixtureBundle({
      name: "verifyPromptWorkflow",
      yaml: [
        "version: tychonic.workflow.v1",
        "name: verifyPromptWorkflow",
        "worktree: false",
        "max_steps: 3",
        "start: verify",
        "states:",
        "  verify:",
        "    type: verify",
        "    command: echo ok",
        "    prompt: ignored prompt",
        "    on_pass:",
        "      finish: true",
        "    on_fail:",
        "      finish: verify failed",
        ""
      ].join("\n")
    });

    await expect(installRuntimeWorkflowModule({ sourcePath: bundleDir })).rejects.toThrow(
      /prompt is not allowed for type verify/
    );
  });

  it("rejects unsupported declarative prompt variables", async () => {
    for (const [prompt, expected] of [
      ["Do {{unknown}}", /unsupported variable "unknown"/],
      ["Do {{goal.text}}", /unsupported variable "goal\.text"/],
      ["Do {{goal-name}}", /unsupported variable "goal-name"/],
      ["Do {{ }}", /unsupported variable ""/]
    ] as const) {
      const bundleDir = await makeDeclarativeFixtureBundle({
        name: "badPromptVariableWorkflow",
        yaml: [
          "version: tychonic.workflow.v1",
          "name: badPromptVariableWorkflow",
          "worktree: true",
          "max_steps: 3",
          "start: work",
          "states:",
          "  work:",
          "    type: work",
          "    agent: claude",
          `    prompt: ${JSON.stringify(prompt)}`,
          "    on_pass:",
          "      finish: true",
          "    on_fail:",
          "      finish: work failed",
          ""
        ].join("\n")
      });

      await expect(installRuntimeWorkflowModule({ sourcePath: bundleDir })).rejects.toThrow(expected);
    }
  });

});

async function makeDeclarativeFixtureBundle(options: {
  name: string;
  yaml?: string;
  readme?: string;
  omitReadme?: boolean;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `tychonic-bundle-src-${options.name}-`));
  const bundleDir = join(root, options.name);
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, "workflow.yaml"), options.yaml ?? minimalWorkflowYaml(options.name), "utf8");
  if (!options.omitReadme) {
    await writeFile(join(bundleDir, "README.md"), options.readme ?? "# fixture\n", "utf8");
  }
  return bundleDir;
}

function minimalWorkflowYaml(name: string): string {
  return [
    "version: tychonic.workflow.v1",
    `name: ${name}`,
    "worktree: false",
    "max_steps: 3",
    "start: verify",
    "states:",
    "  verify:",
    "    type: verify",
    "    command: echo ok",
    "    on_pass:",
    "      finish: true",
    "    on_fail:",
    "      finish: verify failed",
    ""
  ].join("\n");
}
