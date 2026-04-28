import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installLaunchdServices } from "../src/service/launchd.js";

describe("launchd service installer", () => {
  it("writes LaunchAgents that run from a packaged CLI without auto-seeding any workflow bundle", async () => {
    const root = await makeTempRoot("tychonic-launchd-install-");
    const fixture = await makePackagedInstallFixture(root);
    const launchAgentDir = join(root, "LaunchAgents");
    const stateHome = join(root, "state");
    const logHome = join(root, "logs");

    const originalStateHome = process.env.TYCHONIC_STATE_HOME;
    const originalLogHome = process.env.TYCHONIC_LOG_HOME;
    process.env.TYCHONIC_STATE_HOME = stateHome;
    process.env.TYCHONIC_LOG_HOME = logHome;
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
      const webPlist = await readFile(installed.plists.web, "utf8");
      expect(webPlist).toContain(process.execPath);
      expect(webPlist).toContain(fixture.cliPath);
      expect(webPlist).toContain(join(root, "project"));
      expect(webPlist).toContain(stateHome);
      expect(webPlist).toContain("<key>EnvironmentVariables</key>");
      expect(webPlist).toContain("<key>PATH</key>");
      expect(webPlist).toContain("/opt/homebrew/bin");
      expect(webPlist).not.toContain(process.cwd());
      const temporalPlist = await readFile(installed.plists.temporal, "utf8");
      expect(temporalPlist).toContain(join(stateHome, "temporal", "temporal.db"));
      expect(temporalPlist).toContain("<string>--port</string>");
      expect(temporalPlist).toContain("<string>9233</string>");
      expect(temporalPlist).toContain("<string>--headless</string>");
      expect(temporalPlist).not.toContain("<string>--ui-port</string>");
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
      expect(webPlist).toContain("<string>--project-dir</string>");
      expect(webPlist).toContain(join(root, "project"));
      expect(webPlist).toContain("<string>--temporal-mode</string>");
      expect(webPlist).toContain("<string>managed-local</string>");
      expect(webPlist).toContain("<string>--temporal-port</string>");
      expect(webPlist).toContain("<string>9233</string>");
      expect(webPlist).not.toContain("<string>--mode</string>");
      expect(webPlist).not.toContain("<string>--cwd</string>");
      expect(webPlist).not.toContain("<string>--frontend-port</string>");
      expect(webPlist).not.toContain("<string>--ui-port</string>");
      // After Step 2 the host installer no longer seeds any workflow bundle.
      // The runtime workflow modules dir must contain zero bundles until the
      // operator runs `tychonic workflows install` explicitly.
      const modulesDir = join(stateHome, "workflows", "modules");
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

  it("refuses non-loopback web binds by default", async () => {
    const root = await makeTempRoot("tychonic-launchd-bind-");
    const packageRoot = join(root, "app", "node_modules", "tychonic");
    const cliPath = join(packageRoot, "dist", "cli", "main.js");
    const temporalPath = join(root, "bin", "temporal");
    await mkdir(join(packageRoot, "dist", "cli"), { recursive: true });
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "tychonic" }), "utf8");
    await writeFile(cliPath, "#!/usr/bin/env node\n", "utf8");
    await writeFile(temporalPath, "#!/bin/sh\n", "utf8");

    await expect(
      installLaunchdServices({
        projectDir: root,
        webHost: "0.0.0.0",
        nodePath: process.execPath,
        cliPath,
        temporalCliPath: temporalPath,
        launchAgentDir: join(root, "LaunchAgents"),
        load: false
      })
    ).rejects.toThrow(/refusing to bind Tychonic web API to non-loopback host/);
  });

  it("passes the explicit network-bind escape hatch to the web LaunchAgent", async () => {
    const root = await makeTempRoot("tychonic-launchd-bind-allow-");
    const fixture = await makePackagedInstallFixture(root);
    const launchAgentDir = join(root, "LaunchAgents");
    const originalStateHome = process.env.TYCHONIC_STATE_HOME;
    const originalLogHome = process.env.TYCHONIC_LOG_HOME;
    process.env.TYCHONIC_STATE_HOME = join(root, "state");
    process.env.TYCHONIC_LOG_HOME = join(root, "logs");

    try {
      const installed = await installLaunchdServices({
        projectDir: root,
        webHost: "0.0.0.0",
        allowNetworkBind: true,
        nodePath: process.execPath,
        cliPath: fixture.cliPath,
        temporalCliPath: fixture.temporalPath,
        launchAgentDir,
        load: false
      });

      const webPlist = await readFile(installed.plists.web, "utf8");
      expect(webPlist).toContain("<string>0.0.0.0</string>");
      expect(webPlist).toContain("<string>--allow-network-bind</string>");
    } finally {
      restoreEnv("TYCHONIC_STATE_HOME", originalStateHome);
      restoreEnv("TYCHONIC_LOG_HOME", originalLogHome);
    }
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
  return { cliPath, temporalPath };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
