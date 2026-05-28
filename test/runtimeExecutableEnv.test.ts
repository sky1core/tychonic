import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { checkAgentExecutables } from "../src/adapters/executablePreflight.js";
import {
  applyPersistedRuntimeExecutableEnv,
  applyRuntimeExecutableEnv,
  loadRuntimeExecutableEnv,
  prepareRuntimeExecutableEnv,
  resolveRuntimeExecutableEnv,
  runtimeExecutableEnvPath,
  writeRuntimeExecutableEnv
} from "../src/runtime/executableEnv.js";
import { installRuntimeWorkflowModule } from "../src/temporal/workflowModules.js";
import type { TychonicConfig } from "../src/catalog/types.js";

const execFileAsync = promisify(execFile);
const LEGACY_OPENP_PATH_ENV = "TYCHONIC_OPENP_PATH";
const LEGACY_GIT_PATH_ENV = "TYCHONIC_GIT_PATH";

describe("runtime executable env", () => {
  it("captures executable directories and validates required profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "tychonic-runtime-executable-env-"));
    const binDir = join(root, "bin");
    const openpPath = join(binDir, "openp");
    await writeOpenPBackendExecutables(binDir, ["claude", "codex"]);
    const gitPath = await currentGitPath();

    const runtimeEnv = await resolveRuntimeExecutableEnv({
      env: {
        HOME: root,
        PATH: `${binDir}:${dirname(gitPath)}:/usr/bin:/bin`
      },
      requiredProfiles: [{ name: "uses-openp", profile: profileWithAgent("claude") }]
    });

    expect(runtimeEnv.PATH).toContain(binDir);
    expect(runtimeEnv.PATH).toContain(dirname(gitPath));
    expect(runtimeEnv[LEGACY_OPENP_PATH_ENV]).toBeUndefined();
    expect(runtimeEnv[LEGACY_GIT_PATH_ENV]).toBeUndefined();

    const check = await checkAgentExecutables(profileWithAgent("codex"), {
      env: {
        HOME: root,
        PATH: "/definitely/missing",
        ...runtimeEnv
      }
    });
    expect(check.missing).toEqual([]);
    expect(check.resolved[0]?.path).toBe(openpPath);
  });

  it("captures OpenP backend executable directories required by installed profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "tychonic-runtime-executable-openp-backends-"));
    const openpBin = join(root, "openp-bin");
    const claudeBin = join(root, "claude-bin");
    const codexBin = join(root, "codex-bin");
    await writeExecutable(join(openpBin, "openp"));
    await writeExecutable(join(claudeBin, "claude"));
    await writeExecutable(join(claudeBin, "openp"));
    await writeExecutable(join(codexBin, "codex"));
    const gitPath = await currentGitPath();

    const runtimeEnv = await resolveRuntimeExecutableEnv({
      env: {
        HOME: root,
        PATH: `${openpBin}:${claudeBin}:${codexBin}:${dirname(gitPath)}:/usr/bin:/bin`
      },
      requiredProfiles: [{ name: "uses-claude-and-codex", profile: profileWithAgents(["claude", "codex"]) }]
    });

    const pathEntries = runtimeEnv.PATH.split(delimiter);
    expect(pathEntries).toEqual(
      expect.arrayContaining([openpBin, claudeBin, codexBin, dirname(gitPath)])
    );
    expect(pathEntries.indexOf(openpBin)).toBeLessThan(pathEntries.indexOf(claudeBin));
    expect(pathEntries.indexOf(openpBin)).toBeLessThan(pathEntries.indexOf(codexBin));
    const claudeCheck = await checkAgentExecutables(profileWithAgent("claude"), {
      env: { HOME: root, PATH: "/definitely/missing", ...runtimeEnv }
    });
    const codexCheck = await checkAgentExecutables(profileWithAgent("codex"), {
      env: { HOME: root, PATH: "/definitely/missing", ...runtimeEnv }
    });
    expect(claudeCheck.missing).toEqual([]);
    expect(codexCheck.missing).toEqual([]);
    expect(claudeCheck.resolved.find((entry) => entry.executable === "openp")?.path).toBe(
      join(openpBin, "openp")
    );
  });

  it("ignores legacy per-executable env vars for adapters not required by installed profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "tychonic-runtime-executable-unused-stale-"));
    const binDir = join(root, "bin");
    const openpPath = join(binDir, "openp");
    await writeOpenPBackendExecutables(binDir, ["claude"]);
    const gitPath = await currentGitPath();

    const runtimeEnv = await resolveRuntimeExecutableEnv({
      env: {
        HOME: root,
        PATH: `${binDir}:${dirname(gitPath)}:/usr/bin:/bin`,
      },
      requiredProfiles: [{ name: "uses-openp", profile: profileWithAgent("claude") }]
    });

    expect(runtimeEnv.PATH).toContain(binDir);
    expect(runtimeEnv[LEGACY_OPENP_PATH_ENV]).toBeUndefined();
  });

  it("preserves the discovered executable path instead of persisting its symlink target", async () => {
    const root = await mkdtemp(join(tmpdir(), "tychonic-runtime-executable-symlink-"));
    const binDir = join(root, "bin");
    const targetDir = join(root, "targets");
    const targetOpenp = join(targetDir, "openp");
    const targetClaude = join(targetDir, "claude");
    const linkedOpenp = join(binDir, "openp");
    const linkedClaude = join(binDir, "claude");
    await writeExecutable(targetOpenp);
    await writeExecutable(targetClaude);
    await mkdir(binDir, { recursive: true });
    await symlink(targetOpenp, linkedOpenp);
    await symlink(targetClaude, linkedClaude);
    const gitPath = await currentGitPath();

    const runtimeEnv = await resolveRuntimeExecutableEnv({
      env: {
        HOME: root,
        PATH: `${binDir}:${dirname(gitPath)}:/usr/bin:/bin`
      },
      requiredProfiles: [{ name: "uses-openp", profile: profileWithAgent("claude") }]
    });

    expect(runtimeEnv.PATH).toContain(binDir);
    expect(runtimeEnv.PATH).not.toContain(targetDir);
  });

  it("rejects missing required executables without honoring legacy per-executable env vars", async () => {
    const root = await mkdtemp(join(tmpdir(), "tychonic-runtime-executable-required-stale-"));
    const legacyBin = join(root, "legacy");
    await writeExecutable(join(legacyBin, "openp"));
    const gitPath = await currentGitPath();

    await expect(
      resolveRuntimeExecutableEnv({
        env: {
          HOME: root,
          PATH: `${dirname(gitPath)}:/usr/bin:/bin`,
          [LEGACY_OPENP_PATH_ENV]: join(legacyBin, "openp")
        },
        requiredProfiles: [{ name: "uses-openp", profile: profileWithAgent("claude") }]
      })
    ).rejects.toThrow(
      /runtime workflow uses-openp: required agent executable not found.*openp.*states\.work\.agent=claude/s
    );
  });

  it("persists the runtime executable env under the active runtime state dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "tychonic-runtime-executable-persist-"));
    const binDir = join(root, "bin");
    const openpPath = join(binDir, "openp");
    await writeOpenPBackendExecutables(binDir, ["claude"]);
    const gitPath = await currentGitPath();
    const originalStateHome = process.env.TYCHONIC_STATE_HOME;
    const originalPath = process.env.PATH;
    const originalOpenpPath = process.env[LEGACY_OPENP_PATH_ENV];
    try {
      process.env.TYCHONIC_STATE_HOME = join(root, "state");
      process.env.PATH = `${binDir}:${dirname(gitPath)}:/usr/bin:/bin`;
      delete process.env[LEGACY_OPENP_PATH_ENV];

      const runtimeEnv = await prepareRuntimeExecutableEnv({
        requiredProfiles: [{ name: "uses-openp", profile: profileWithAgent("claude") }]
      });
      const stored = await loadRuntimeExecutableEnv();
      applyRuntimeExecutableEnv(runtimeEnv);

      expect(stored?.PATH).toContain(binDir);
      expect(stored?.[LEGACY_OPENP_PATH_ENV]).toBeUndefined();
      expect(await readFile(runtimeExecutableEnvPath(), "utf8")).toContain("tychonic.runtimeExecutables.v1");
      expect(process.env.PATH).toContain(binDir);
      expect(process.env[LEGACY_OPENP_PATH_ENV]).toBeUndefined();
    } finally {
      restoreEnv("TYCHONIC_STATE_HOME", originalStateHome);
      restoreEnv("PATH", originalPath);
      restoreEnv(LEGACY_OPENP_PATH_ENV, originalOpenpPath);
    }
  });

  it("rejects persisted stale executable paths when an installed profile requires them", async () => {
    const root = await mkdtemp(join(tmpdir(), "tychonic-runtime-executable-persist-stale-"));
    const stateHome = join(root, "state");
    const bundleSource = join(root, "bundles", "staleOpenpWorkflow");
    const gitPath = await currentGitPath();
    const originalStateHome = process.env.TYCHONIC_STATE_HOME;
    const originalPath = process.env.PATH;
    const originalOpenpPath = process.env[LEGACY_OPENP_PATH_ENV];
    try {
      process.env.TYCHONIC_STATE_HOME = stateHome;
      process.env.PATH = `${dirname(gitPath)}:/usr/bin:/bin`;
      delete process.env[LEGACY_OPENP_PATH_ENV];
      await mkdir(bundleSource, { recursive: true });
      await writeFile(join(bundleSource, "workflow.yaml"), minimalAgentWorkflowYaml("staleOpenpWorkflow"), "utf8");
      await installRuntimeWorkflowModule({ sourcePath: bundleSource });
      await writeRuntimeExecutableEnv({
        [LEGACY_GIT_PATH_ENV]: gitPath,
        [LEGACY_OPENP_PATH_ENV]: join(root, "missing-openp"),
        PATH: `${dirname(gitPath)}:/usr/bin:/bin`
      });

      await expect(applyPersistedRuntimeExecutableEnv()).rejects.toThrow(
        /runtime workflow staleOpenpWorkflow: required agent executable not found.*openp.*states\.work\.agent=claude/s
      );
    } finally {
      restoreEnv("TYCHONIC_STATE_HOME", originalStateHome);
      restoreEnv("PATH", originalPath);
      restoreEnv(LEGACY_OPENP_PATH_ENV, originalOpenpPath);
    }
  });

  it("sanitizes persisted stale optional executable paths before applying them", async () => {
    const root = await mkdtemp(join(tmpdir(), "tychonic-runtime-executable-optional-stale-"));
    const stateHome = join(root, "state");
    const gitPath = await currentGitPath();
    const originalStateHome = process.env.TYCHONIC_STATE_HOME;
    const originalPath = process.env.PATH;
    const originalOpenpPath = process.env[LEGACY_OPENP_PATH_ENV];
    try {
      process.env.TYCHONIC_STATE_HOME = stateHome;
      process.env.PATH = `${dirname(gitPath)}:/usr/bin:/bin`;
      process.env[LEGACY_OPENP_PATH_ENV] = join(root, "old-process-openp");
      await writeRuntimeExecutableEnv({
        [LEGACY_GIT_PATH_ENV]: gitPath,
        [LEGACY_OPENP_PATH_ENV]: join(root, "missing-openp"),
        PATH: `${dirname(gitPath)}:/usr/bin:/bin`
      });

      await expect(applyPersistedRuntimeExecutableEnv()).resolves.toBe(true);
      const stored = await loadRuntimeExecutableEnv();

      expect(process.env[LEGACY_OPENP_PATH_ENV]).toBeUndefined();
      expect(stored?.[LEGACY_OPENP_PATH_ENV]).toBeUndefined();
      expect(stored?.[LEGACY_GIT_PATH_ENV]).toBeUndefined();
      expect(stored?.PATH).toContain(dirname(gitPath));
    } finally {
      restoreEnv("TYCHONIC_STATE_HOME", originalStateHome);
      restoreEnv("PATH", originalPath);
      restoreEnv(LEGACY_OPENP_PATH_ENV, originalOpenpPath);
    }
  });
});

function profileWithAgent(agent: "claude" | "codex"): TychonicConfig {
  return {
    version: "tychonic.config.v1",
    states: {
      work: {
        type: "work",
        agent
      }
    }
  };
}

function profileWithAgents(agents: Array<"claude" | "codex">): TychonicConfig {
  return {
    version: "tychonic.config.v1",
    states: Object.fromEntries(
      agents.map((agent, index) => [
        `work_${index}`,
        {
          type: "work",
          agent
        }
      ])
    )
  } as TychonicConfig;
}

async function currentGitPath(): Promise<string> {
  const { stdout } = await execFileAsync("/bin/sh", ["-lc", "command -v git"], { encoding: "utf8" });
  return await realpath(stdout.trim());
}

async function writeExecutable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
}

async function writeOpenPBackendExecutables(binDir: string, backends: string[]): Promise<void> {
  await writeExecutable(join(binDir, "openp"));
  for (const backend of backends) {
    await writeExecutable(join(binDir, backend));
  }
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
