import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/adapters/openp.js";
import { claimRuntimeStartLock } from "../src/runtime/detached.js";
import { installLaunchdServices } from "../src/service/launchd.js";
import { installRuntimeWorkflowModule } from "../src/temporal/workflowModules.js";

const LEGACY_GIT_PATH_ENV = "TYCHONIC_GIT_PATH";
const LEGACY_OPENP_PATH_ENV = "TYCHONIC_OPENP_PATH";
const LEGACY_KIRO_CLI_PATH_ENV = "TYCHONIC_KIRO_CLI_PATH";

describe("launchd service installer", () => {
  it("writes LaunchAgents that run from a packaged CLI without auto-seeding any workflow bundle", async () => {
    const root = await makeTempRoot("tychonic-launchd-install-");
    const fixture = await makePackagedInstallFixture(root);
    const launchAgentDir = join(root, "LaunchAgents");
    const stateHome = join(root, "state");
    const logHome = join(root, "logs");
    const agentBin = join(root, "agent-bin");
    const unusedBin = join(root, "unused-bin");
    const openpPath = join(agentBin, "openp");
    await mkdir(agentBin, { recursive: true });
    await writeFile(openpPath, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(openpPath, 0o755);

    const originalStateHome = process.env.TYCHONIC_STATE_HOME;
    const originalLogHome = process.env.TYCHONIC_LOG_HOME;
    const originalAllowedHosts = process.env.TYCHONIC_WEB_ALLOWED_HOSTS;
    const originalPath = process.env.PATH;
    const originalAgentPath = process.env.TYCHONIC_AGENT_PATH;
    const originalGitPath = process.env[LEGACY_GIT_PATH_ENV];
    const originalOpenpPath = process.env[LEGACY_OPENP_PATH_ENV];
    const originalKiroPath = process.env[LEGACY_KIRO_CLI_PATH_ENV];
    process.env.TYCHONIC_STATE_HOME = stateHome;
    process.env.TYCHONIC_LOG_HOME = logHome;
    process.env.TYCHONIC_WEB_ALLOWED_HOSTS = "status.example.test";
    process.env.PATH = `${agentBin}:${unusedBin}:/usr/bin:/bin`;
    process.env.TYCHONIC_AGENT_PATH = "/explicit/agents";
    delete process.env[LEGACY_GIT_PATH_ENV];
    delete process.env[LEGACY_OPENP_PATH_ENV];
    delete process.env[LEGACY_KIRO_CLI_PATH_ENV];
    try {
      const installed = await installLaunchdServices({
        projectDir: join(root, "project"),
        nodePath: process.execPath,
        cliPath: fixture.cliPath,
        temporalCliPath: fixture.temporalPath,
        temporalPort: 9233,
        workerShutdownGraceTime: "35m",
        launchAgentDir,
        load: false
      });

      expect(installed.stateDir).toBe(stateHome);
      expect(installed.logDir).toBe(logHome);
      expect(installed.loaded).toBe(false);
      const modulesDir = join(stateHome, "workflows", "modules");
      expect(installed.workflowRefresh).toEqual({ directory: modulesDir, refreshed: [] });
      expect(Object.keys(installed.plists).sort()).toEqual(["temporal", "web", "worker"]);
      const temporalPlist = await readFile(installed.plists.temporal, "utf8");
      expect(temporalPlist).toContain(join(stateHome, "temporal", "temporal.db"));
      expect(temporalPlist).toContain("<string>--port</string>");
      expect(temporalPlist).toContain("<string>9233</string>");
      expect(temporalPlist).toContain("<string>--headless</string>");
      expect(temporalPlist).not.toContain("<string>--ui-port</string>");
      expect(temporalPlist).not.toContain("TYCHONIC_WEB_ALLOWED_HOSTS");
      const workerPlist = await readFile(installed.plists.worker, "utf8");
      expect(workerPlist).toContain("<string>worker</string>");
      expect(workerPlist).toContain("<string>--temporal-mode</string>");
      expect(workerPlist).toContain("<string>managed-local</string>");
      expect(workerPlist).toContain("<string>--temporal-port</string>");
      expect(workerPlist).toContain("<string>9233</string>");
      expect(workerPlist).not.toContain("<string>--mode</string>");
      expect(workerPlist).not.toContain("<string>--frontend-port</string>");
      expect(workerPlist).not.toContain("<string>--ui-port</string>");
      expect(workerPlist).toContain("<string>--shutdown-grace-time</string>");
      expect(workerPlist).toContain("<string>35m</string>");
      expect(workerPlist).not.toContain("TYCHONIC_WEB_ALLOWED_HOSTS");
      expect(workerPlist).toContain("<key>PATH</key>");
      expect(workerPlist).toContain(`<string>/explicit/agents:${agentBin}:/usr/bin:/bin</string>`);
      expect(workerPlist).not.toContain(unusedBin);
      expect(workerPlist).not.toContain(LEGACY_GIT_PATH_ENV);
      expect(workerPlist).not.toContain(LEGACY_OPENP_PATH_ENV);
      expect(workerPlist).not.toContain(LEGACY_KIRO_CLI_PATH_ENV);
      const runtimeExecutables = await readFile(join(stateHome, "runtime-executables.json"), "utf8");
      expect(runtimeExecutables).toContain(agentBin);
      expect(runtimeExecutables).not.toContain(LEGACY_OPENP_PATH_ENV);
      const webPlist = await readFile(installed.plists.web, "utf8");
      expect(webPlist).toContain("<string>web</string>");
      expect(webPlist).toContain("<string>--port</string>");
      expect(webPlist).toContain("<string>19733</string>");
      expect(webPlist).toContain("<string>--temporal-mode</string>");
      expect(webPlist).toContain("<string>managed-local</string>");
      expect(webPlist).toContain("<string>--temporal-port</string>");
      expect(webPlist).toContain("<string>9233</string>");
      expect(webPlist).toContain(join(logHome, "web.out.log"));
      expect(webPlist).toContain(join(logHome, "web.err.log"));
      expect(webPlist).toContain("<key>TYCHONIC_WEB_ALLOWED_HOSTS</key>");
      expect(webPlist).toContain("<string>status.example.test</string>");
      // The host installer does not seed workflow bundles. The runtime
      // workflow modules dir must contain zero bundles until the
      // operator runs `tychonic workflows install` explicitly.
      let installedBundles: string[] = [];
      try {
        installedBundles = await readdir(modulesDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      expect(installedBundles).toEqual([]);
    } finally {
      restoreEnv("TYCHONIC_STATE_HOME", originalStateHome);
      restoreEnv("TYCHONIC_LOG_HOME", originalLogHome);
      restoreEnv("TYCHONIC_WEB_ALLOWED_HOSTS", originalAllowedHosts);
      restoreEnv("PATH", originalPath);
      restoreEnv("TYCHONIC_AGENT_PATH", originalAgentPath);
      restoreEnv(LEGACY_GIT_PATH_ENV, originalGitPath);
      restoreEnv(LEGACY_OPENP_PATH_ENV, originalOpenpPath);
      restoreEnv(LEGACY_KIRO_CLI_PATH_ENV, originalKiroPath);
    }
  });

  it("refreshes already installed workflow bundles before writing LaunchAgents", async () => {
    const root = await makeTempRoot("tychonic-launchd-refresh-");
    const fixture = await makePackagedInstallFixture(root);
    const launchAgentDir = join(root, "LaunchAgents");
    const stateHome = join(root, "state");
    const logHome = join(root, "logs");

    const originalStateHome = process.env.TYCHONIC_STATE_HOME;
    const originalLogHome = process.env.TYCHONIC_LOG_HOME;
    process.env.TYCHONIC_STATE_HOME = stateHome;
    process.env.TYCHONIC_LOG_HOME = logHome;
    try {
      const sourceDir = await makeDeclarativeFixtureBundle(root, "serviceRefreshWorkflow");
      const workflow = await installRuntimeWorkflowModule({ sourcePath: sourceDir });
      await writeFile(workflow.workflowPath, "export const stale = true;\n", "utf8");
      await writeFile(join(workflow.path, "workflow.generated.mmd"), "stale graph\n", "utf8");
      await writeFile(join(workflow.path, "helper.mjs"), "export const helper = true;\n", "utf8");

      const installed = await installLaunchdServices({
        projectDir: join(root, "project"),
        nodePath: process.execPath,
        cliPath: fixture.cliPath,
        temporalCliPath: fixture.temporalPath,
        launchAgentDir,
        load: false
      });

      expect(installed.workflowRefresh.refreshed.map((bundle) => bundle.name)).toEqual(["serviceRefreshWorkflow"]);
      await expect(readFile(workflow.workflowPath, "utf8")).resolves.toContain("createTychonicWorkflowContext");
      await expect(readFile(workflow.workflowPath, "utf8")).resolves.not.toContain("stale");
      await expect(readFile(join(workflow.path, "workflow.generated.mmd"), "utf8")).resolves.toContain("__start");
      await expect(readFile(join(workflow.path, "helper.mjs"), "utf8")).resolves.toContain("helper");
    } finally {
      restoreEnv("TYCHONIC_STATE_HOME", originalStateHome);
      restoreEnv("TYCHONIC_LOG_HOME", originalLogHome);
    }
  });

  it("regenerates missing workflow artifacts for installed workflow source bundles", async () => {
    const root = await makeTempRoot("tychonic-launchd-refresh-missing-generated-");
    const fixture = await makePackagedInstallFixture(root);
    const launchAgentDir = join(root, "LaunchAgents");
    const stateHome = join(root, "state");
    const logHome = join(root, "logs");

    const originalStateHome = process.env.TYCHONIC_STATE_HOME;
    const originalLogHome = process.env.TYCHONIC_LOG_HOME;
    process.env.TYCHONIC_STATE_HOME = stateHome;
    process.env.TYCHONIC_LOG_HOME = logHome;
    try {
      const sourceDir = await makeDeclarativeFixtureBundle(root, "missingGeneratedWorkflow");
      const workflow = await installRuntimeWorkflowModule({ sourcePath: sourceDir });
      await rm(workflow.workflowPath);
      await rm(join(workflow.path, "workflow.generated.mmd"));

      const installed = await installLaunchdServices({
        projectDir: join(root, "project"),
        nodePath: process.execPath,
        cliPath: fixture.cliPath,
        temporalCliPath: fixture.temporalPath,
        launchAgentDir,
        load: false
      });

      expect(installed.workflowRefresh.refreshed.map((bundle) => bundle.name)).toEqual(["missingGeneratedWorkflow"]);
      await expect(readFile(workflow.workflowPath, "utf8")).resolves.toContain("createTychonicWorkflowContext");
      await expect(readFile(join(workflow.path, "workflow.generated.mmd"), "utf8")).resolves.toContain("__start");
    } finally {
      restoreEnv("TYCHONIC_STATE_HOME", originalStateHome);
      restoreEnv("TYCHONIC_LOG_HOME", originalLogHome);
    }
  });

  it("aborts service install without touching installed bundles when any installed workflow is invalid", async () => {
    const root = await makeTempRoot("tychonic-launchd-refresh-invalid-");
    const fixture = await makePackagedInstallFixture(root);
    const launchAgentDir = join(root, "LaunchAgents");
    const stateHome = join(root, "state");
    const logHome = join(root, "logs");

    const originalStateHome = process.env.TYCHONIC_STATE_HOME;
    const originalLogHome = process.env.TYCHONIC_LOG_HOME;
    process.env.TYCHONIC_STATE_HOME = stateHome;
    process.env.TYCHONIC_LOG_HOME = logHome;
    try {
      const sourceDir = await makeDeclarativeFixtureBundle(root, "validRefreshWorkflow");
      const workflow = await installRuntimeWorkflowModule({ sourcePath: sourceDir });
      await writeFile(workflow.workflowPath, "export const stale = true;\n", "utf8");

      const invalidDir = join(stateHome, "workflows", "modules", "invalidRefreshWorkflow");
      await mkdir(invalidDir, { recursive: true });
      await writeFile(join(invalidDir, "workflow.mjs"), "export const stale = true;\n", "utf8");
      await writeFile(join(invalidDir, "workflow.yaml"), minimalWorkflowYaml("differentWorkflowName"), "utf8");

      await expect(
        installLaunchdServices({
          projectDir: join(root, "project"),
          nodePath: process.execPath,
          cliPath: fixture.cliPath,
          temporalCliPath: fixture.temporalPath,
          launchAgentDir,
          load: false
        })
      ).rejects.toThrow(/workflow\.yaml name "differentWorkflowName" must match bundle directory name "invalidRefreshWorkflow"/);

      await expect(readFile(workflow.workflowPath, "utf8")).resolves.toBe("export const stale = true;\n");
      await expect(readdir(launchAgentDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restoreEnv("TYCHONIC_STATE_HOME", originalStateHome);
      restoreEnv("TYCHONIC_LOG_HOME", originalLogHome);
    }
  });

  it("aborts service install before writing LaunchAgents when an installed workflow needs a missing agent executable", async () => {
    const root = await makeTempRoot("tychonic-launchd-refresh-missing-agent-");
    const fixture = await makePackagedInstallFixture(root);
    const launchAgentDir = join(root, "LaunchAgents");
    const stateHome = join(root, "state");
    const logHome = join(root, "logs");

    const originalStateHome = process.env.TYCHONIC_STATE_HOME;
    const originalLogHome = process.env.TYCHONIC_LOG_HOME;
    const restoreAdapter = replaceClaudeExecutables(["definitely-missing-tychonic-agent-service"]);
    process.env.TYCHONIC_STATE_HOME = stateHome;
    process.env.TYCHONIC_LOG_HOME = logHome;
    try {
      const sourceDir = await makeDeclarativeAgentFixtureBundle(root, "serviceMissingAgentWorkflow");
      await installRuntimeWorkflowModule({ sourcePath: sourceDir });

      await expect(
        installLaunchdServices({
          projectDir: join(root, "project"),
          nodePath: process.execPath,
          cliPath: fixture.cliPath,
          temporalCliPath: fixture.temporalPath,
          launchAgentDir,
          load: false
        })
      ).rejects.toThrow(/required agent executable not found.*definitely-missing-tychonic-agent-service/s);

      await expect(readdir(launchAgentDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restoreAdapter();
      restoreEnv("TYCHONIC_STATE_HOME", originalStateHome);
      restoreEnv("TYCHONIC_LOG_HOME", originalLogHome);
    }
  });

  it("does not treat legacy git path env as service executable configuration", async () => {
    const root = await makeTempRoot("tychonic-launchd-legacy-git-");
    const fixture = await makePackagedInstallFixture(root);
    const launchAgentDir = join(root, "LaunchAgents");
    const stateHome = join(root, "state");
    const logHome = join(root, "logs");
    const gitPath = join(root, "not-executable-git");

    const originalStateHome = process.env.TYCHONIC_STATE_HOME;
    const originalLogHome = process.env.TYCHONIC_LOG_HOME;
    const originalPath = process.env.PATH;
    const originalGitPath = process.env[LEGACY_GIT_PATH_ENV];
    process.env.TYCHONIC_STATE_HOME = stateHome;
    process.env.TYCHONIC_LOG_HOME = logHome;
    process.env.PATH = "/usr/bin:/bin";
    process.env[LEGACY_GIT_PATH_ENV] = gitPath;
    try {
      await writeFile(gitPath, "#!/bin/sh\n", "utf8");

      const installed = await installLaunchdServices({
        projectDir: join(root, "project"),
        nodePath: process.execPath,
        cliPath: fixture.cliPath,
        temporalCliPath: fixture.temporalPath,
        launchAgentDir,
        load: false
      });
      const workerPlist = await readFile(installed.plists.worker, "utf8");
      expect(workerPlist).not.toContain(LEGACY_GIT_PATH_ENV);
    } finally {
      restoreEnv("TYCHONIC_STATE_HOME", originalStateHome);
      restoreEnv("TYCHONIC_LOG_HOME", originalLogHome);
      restoreEnv("PATH", originalPath);
      restoreEnv(LEGACY_GIT_PATH_ENV, originalGitPath);
    }
  });

  it("refuses service install before writing LaunchAgents when an operational runtime pid is live", async () => {
    const root = await makeTempRoot("tychonic-launchd-runtime-pid-");
    const fixture = await makePackagedInstallFixture(root);
    const launchAgentDir = join(root, "LaunchAgents");
    const stateHome = join(root, "state");
    const logHome = join(root, "logs");

    const originalStateHome = process.env.TYCHONIC_STATE_HOME;
    const originalLogHome = process.env.TYCHONIC_LOG_HOME;
    process.env.TYCHONIC_STATE_HOME = stateHome;
    process.env.TYCHONIC_LOG_HOME = logHome;
    try {
      await mkdir(stateHome, { recursive: true });
      await writeFile(join(stateHome, "runtime.pid"), `${process.pid}\n`, "utf8");

      await expect(
        installLaunchdServices({
          projectDir: join(root, "project"),
          nodePath: process.execPath,
          cliPath: fixture.cliPath,
          temporalCliPath: fixture.temporalPath,
          launchAgentDir,
          load: false
        })
      ).rejects.toThrow(/runtime PID file .*runtime\.pid points at live process .*refusing service install/s);

      await expect(readdir(launchAgentDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      restoreEnv("TYCHONIC_STATE_HOME", originalStateHome);
      restoreEnv("TYCHONIC_LOG_HOME", originalLogHome);
    }
  });

  it("refuses service install before writing LaunchAgents while operational runtime start is in progress", async () => {
    const root = await makeTempRoot("tychonic-launchd-runtime-start-lock-");
    const fixture = await makePackagedInstallFixture(root);
    const launchAgentDir = join(root, "LaunchAgents");
    const stateHome = join(root, "state");
    const logHome = join(root, "logs");

    const originalStateHome = process.env.TYCHONIC_STATE_HOME;
    const originalLogHome = process.env.TYCHONIC_LOG_HOME;
    process.env.TYCHONIC_STATE_HOME = stateHome;
    process.env.TYCHONIC_LOG_HOME = logHome;
    const lock = await claimRuntimeStartLock(join(stateHome, "runtime.start.lock"));
    try {
      await expect(
        installLaunchdServices({
          projectDir: join(root, "project"),
          nodePath: process.execPath,
          cliPath: fixture.cliPath,
          temporalCliPath: fixture.temporalPath,
          launchAgentDir,
          load: false
        })
      ).rejects.toThrow(/runtime start is already in progress/);

      await expect(readdir(launchAgentDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await lock.release();
      restoreEnv("TYCHONIC_STATE_HOME", originalStateHome);
      restoreEnv("TYCHONIC_LOG_HOME", originalLogHome);
    }
  });

  it("preserves TYCHONIC_WEB_ALLOWED_HOSTS from existing web plist when process env does not set it", async () => {
    const root = await makeTempRoot("tychonic-launchd-preserve-hosts-");
    const fixture = await makePackagedInstallFixture(root);
    const launchAgentDir = join(root, "LaunchAgents");
    const stateHome = join(root, "state");
    const logHome = join(root, "logs");

    const originalStateHome = process.env.TYCHONIC_STATE_HOME;
    const originalLogHome = process.env.TYCHONIC_LOG_HOME;
    const originalAllowedHosts = process.env.TYCHONIC_WEB_ALLOWED_HOSTS;
    process.env.TYCHONIC_STATE_HOME = stateHome;
    process.env.TYCHONIC_LOG_HOME = logHome;

    try {
      // First install: set TYCHONIC_WEB_ALLOWED_HOSTS in process.env
      process.env.TYCHONIC_WEB_ALLOWED_HOSTS = "gateway.example.test";
      const first = await installLaunchdServices({
        projectDir: join(root, "project"),
        nodePath: process.execPath,
        cliPath: fixture.cliPath,
        temporalCliPath: fixture.temporalPath,
        launchAgentDir,
        load: false
      });
      const firstWebPlist = await readFile(first.plists.web, "utf8");
      expect(firstWebPlist).toContain("<key>TYCHONIC_WEB_ALLOWED_HOSTS</key>");
      expect(firstWebPlist).toContain("<string>gateway.example.test</string>");

      // Second install: WITHOUT the env var — must preserve from existing plist
      delete process.env.TYCHONIC_WEB_ALLOWED_HOSTS;
      const second = await installLaunchdServices({
        projectDir: join(root, "project"),
        nodePath: process.execPath,
        cliPath: fixture.cliPath,
        temporalCliPath: fixture.temporalPath,
        launchAgentDir,
        load: false
      });
      const secondWebPlist = await readFile(second.plists.web, "utf8");
      expect(secondWebPlist).toContain("<key>TYCHONIC_WEB_ALLOWED_HOSTS</key>");
      expect(secondWebPlist).toContain("<string>gateway.example.test</string>");

      // Temporal and worker plists must not have the setting
      const temporalPlist = await readFile(second.plists.temporal, "utf8");
      const workerPlist = await readFile(second.plists.worker, "utf8");
      expect(temporalPlist).not.toContain("TYCHONIC_WEB_ALLOWED_HOSTS");
      expect(workerPlist).not.toContain("TYCHONIC_WEB_ALLOWED_HOSTS");
    } finally {
      restoreEnv("TYCHONIC_STATE_HOME", originalStateHome);
      restoreEnv("TYCHONIC_LOG_HOME", originalLogHome);
      restoreEnv("TYCHONIC_WEB_ALLOWED_HOSTS", originalAllowedHosts);
    }
  });

  it("overrides existing TYCHONIC_WEB_ALLOWED_HOSTS when process env provides a new value", async () => {
    const root = await makeTempRoot("tychonic-launchd-override-hosts-");
    const fixture = await makePackagedInstallFixture(root);
    const launchAgentDir = join(root, "LaunchAgents");
    const stateHome = join(root, "state");
    const logHome = join(root, "logs");

    const originalStateHome = process.env.TYCHONIC_STATE_HOME;
    const originalLogHome = process.env.TYCHONIC_LOG_HOME;
    const originalAllowedHosts = process.env.TYCHONIC_WEB_ALLOWED_HOSTS;
    process.env.TYCHONIC_STATE_HOME = stateHome;
    process.env.TYCHONIC_LOG_HOME = logHome;

    try {
      // First install with old value
      process.env.TYCHONIC_WEB_ALLOWED_HOSTS = "old.example.test";
      await installLaunchdServices({
        projectDir: join(root, "project"),
        nodePath: process.execPath,
        cliPath: fixture.cliPath,
        temporalCliPath: fixture.temporalPath,
        launchAgentDir,
        load: false
      });

      // Second install with new value — must use the new value
      process.env.TYCHONIC_WEB_ALLOWED_HOSTS = "new.example.test";
      const second = await installLaunchdServices({
        projectDir: join(root, "project"),
        nodePath: process.execPath,
        cliPath: fixture.cliPath,
        temporalCliPath: fixture.temporalPath,
        launchAgentDir,
        load: false
      });
      const webPlist = await readFile(second.plists.web, "utf8");
      expect(webPlist).toContain("<string>new.example.test</string>");
      expect(webPlist).not.toContain("old.example.test");
    } finally {
      restoreEnv("TYCHONIC_STATE_HOME", originalStateHome);
      restoreEnv("TYCHONIC_LOG_HOME", originalLogHome);
      restoreEnv("TYCHONIC_WEB_ALLOWED_HOSTS", originalAllowedHosts);
    }
  });

  it("refuses to install services from a source checkout CLI by default", async () => {
    const root = await makeTempRoot("tychonic-launchd-source-");
    const cliPath = join(root, "dist", "cli", "main.js");
    await mkdir(join(root, "dist", "cli"), { recursive: true });
    await mkdir(join(root, "src", "cli"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "tychonic" }), "utf8");
    await writeFile(join(root, "tsconfig.json"), "{}", "utf8");
    await writeFile(join(root, "src", "cli", "main.ts"), "", "utf8");
    await writeFile(cliPath, "#!/usr/bin/env node\n", "utf8");

    await expect(
      installLaunchdServices({
        projectDir: root,
        nodePath: process.execPath,
        cliPath,
        temporalCliPath: process.execPath,
        launchAgentDir: join(root, "LaunchAgents"),
        load: false
      })
    ).rejects.toThrow(/refusing to install launchd services from source checkout CLI/);
  });

});

async function makeTempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function makePackagedInstallFixture(
  root: string
): Promise<{ cliPath: string; temporalPath: string }> {
  const packageRoot = join(root, "app", "node_modules", "tychonic");
  const cliPath = join(packageRoot, "dist", "cli", "main.js");
  const temporalPath = join(root, "bin", "temporal");
  await mkdir(join(packageRoot, "dist", "cli"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "tychonic" }), "utf8");
  await writeFile(cliPath, "#!/usr/bin/env node\n", "utf8");
  await writeFile(temporalPath, "#!/bin/sh\n", "utf8");
  await chmod(temporalPath, 0o755);
  return { cliPath, temporalPath };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function makeDeclarativeFixtureBundle(root: string, name: string): Promise<string> {
  const bundleDir = join(root, "bundles", name);
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, "workflow.yaml"), minimalWorkflowYaml(name), "utf8");
  await writeFile(join(bundleDir, "README.md"), "# fixture\n", "utf8");
  return bundleDir;
}

async function makeDeclarativeAgentFixtureBundle(root: string, name: string): Promise<string> {
  const bundleDir = join(root, "bundles", name);
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, "workflow.yaml"), minimalAgentWorkflowYaml(name), "utf8");
  await writeFile(join(bundleDir, "README.md"), "# fixture\n", "utf8");
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

function minimalAgentWorkflowYaml(name: string): string {
  return [
    "version: tychonic.workflow.v1",
    `name: ${name}`,
    "worktree: true",
    "max_steps: 3",
    "start: work",
    "states:",
    "  work:",
    "    type: work",
    "    agent: claude",
    "    prompt: |",
    "      Complete the requested work.",
    "    on_pass:",
    "      finish: true",
    "    on_fail:",
    "      finish: work failed",
    ""
  ].join("\n");
}

function replaceClaudeExecutables(executables: string[]): () => void {
  const adapter = claudeAdapter as unknown as { executables: readonly string[] };
  const previous = adapter.executables;
  adapter.executables = executables;
  return () => {
    adapter.executables = previous;
  };
}
