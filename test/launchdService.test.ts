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
      expect(Object.prototype.hasOwnProperty.call(installed.plists, "web")).toBe(false);
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
      // The host installer does not seed workflow bundles. The runtime
      // workflow modules dir must contain zero bundles until the
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
