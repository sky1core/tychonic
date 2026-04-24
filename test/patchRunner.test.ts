import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runSimpleWorkflow } from "../src/bootstrap/simpleWorkflowRunner.js";
import { checkOrApplyWorkerPatch } from "../src/bootstrap/patchRunner.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

describe("checkOrApplyWorkerPatch", () => {
  it("rejects the removed built-in simple_workflow starter command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-fix-cli-result-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    await expect(
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          cliPath,
          "simple_workflow",
          "--cwd",
          cwd
        ],
        { cwd: projectRoot, encoding: "utf8" }
      )
    ).rejects.toMatchObject({ stderr: expect.stringContaining("unknown command 'simple_workflow'") });
  }, 15000);

  it("checks a simple_workflow run worker patch without mutating until apply is requested", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-patch-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const runResult = await runSimpleWorkflow({
      cwd,
      runId: "delegate_patch_check",
      command: "node -e \"require('fs').writeFileSync('delegated.txt', 'ok\\n')\"",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('delegated.txt') ? 0 : 1)\"",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });
    const patchArtifact = runResult.run.artifacts.find((artifact) => artifact.kind === "worker_patch");
    if (!patchArtifact) {
      throw new Error("worker_patch artifact missing");
    }
    const patchFile = join(cwd, patchArtifact.path);

    const checked = await checkOrApplyWorkerPatch({
      cwd,
      patchFile,
      env: process.env
    });

    expect(checked.mode).toBe("check");
    expect(checked.status).toBe("applies");
    expect(checked.artifact.kind).toBe("worker_patch");
    await expect(access(join(cwd, "delegated.txt"))).rejects.toThrow();

    const applied = await checkOrApplyWorkerPatch({
      cwd,
      patchFile,
      apply: true,
      env: process.env
    });

    expect(applied.mode).toBe("apply");
    expect(applied.status).toBe("applied");
    await expect(readFile(join(cwd, "delegated.txt"), "utf8")).resolves.toBe("ok\n");
  });

  it("checks and applies an explicit Temporal patch artifact without run.json", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-patch-temporal-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");
    const artifactDir = join(cwd, ".tychonic", "runs", "delegate_temporal_patch", "artifacts");
    const patchFile = join(artifactDir, "worker.patch");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      patchFile,
      [
        "diff --git a/delegated.txt b/delegated.txt",
        "new file mode 100644",
        "index 0000000..1269488",
        "--- /dev/null",
        "+++ b/delegated.txt",
        "@@ -0,0 +1 @@",
        "+temporal",
        ""
      ].join("\n"),
      "utf8"
    );

    const checked = await checkOrApplyWorkerPatch({
      cwd,
      patchFile,
      env: process.env
    });

    expect(checked.mode).toBe("check");
    expect(checked.status).toBe("applies");
    expect(checked.run.id).toBe("explicit_patch");
    expect(checked.artifact.kind).toBe("worker_patch");
    await expect(access(join(cwd, "delegated.txt"))).rejects.toThrow();

    const applied = await checkOrApplyWorkerPatch({
      cwd,
      patchFile,
      apply: true,
      env: process.env
    });

    expect(applied.status).toBe("applied");
    await expect(readFile(join(cwd, "delegated.txt"), "utf8")).resolves.toBe("temporal\n");
  });

  it("reports a non-applying worker patch without overwriting source files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-patch-conflict-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const runResult = await runSimpleWorkflow({
      cwd,
      runId: "delegate_patch_conflict",
      command: "node -e \"require('fs').writeFileSync('delegated.txt', 'worker\\n')\"",
      verifyCommand:
        "node -e \"process.exit(require('fs').readFileSync('delegated.txt', 'utf8') === 'worker\\n' ? 0 : 1)\"",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });
    const patchArtifact = runResult.run.artifacts.find((artifact) => artifact.kind === "worker_patch");
    if (!patchArtifact) {
      throw new Error("worker_patch artifact missing");
    }
    const patchFile = join(cwd, patchArtifact.path);
    await writeFile(join(cwd, "delegated.txt"), "source\n", "utf8");

    const checked = await checkOrApplyWorkerPatch({
      cwd,
      patchFile,
      env: process.env
    });

    expect(checked.status).toBe("does_not_apply");
    expect(checked.exitCode).not.toBe(0);
    await expect(readFile(join(cwd, "delegated.txt"), "utf8")).resolves.toBe("source\n");
  });

  it("exposes the patch check through the CLI without mutating", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-patch-cli-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");

    const runResult = await runSimpleWorkflow({
      cwd,
      runId: "delegate_patch_cli",
      command: "node -e \"require('fs').writeFileSync('delegated.txt', 'cli\\n')\"",
      verifyCommand:
        "node -e \"process.exit(require('fs').existsSync('delegated.txt') ? 0 : 1)\"",
      now: () => new Date("2026-04-19T00:00:00.000Z"),
      env: process.env,
      commandTimeoutMs: 10_000
    });
    const patchArtifact = runResult.run.artifacts.find((artifact) => artifact.kind === "worker_patch");
    if (!patchArtifact) {
      throw new Error("worker_patch artifact missing");
    }
    const patchFile = join(cwd, patchArtifact.path);

    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliPath, "simple_workflow:patch", "--patch-file", patchFile, "--cwd", cwd],
      { cwd: projectRoot, encoding: "utf8" }
    );
    const parsed = JSON.parse(stdout) as { ok: boolean; mode: string; status: string };

    expect(parsed).toMatchObject({ ok: true, mode: "check", status: "applies" });
    await expect(access(join(cwd, "delegated.txt"))).rejects.toThrow();
  });

  it("checks an explicit patch artifact through the CLI without reading run.json", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-patch-cli-explicit-"));
    await execFileAsync("git", ["init"], { cwd });
    const artifactDir = join(cwd, ".tychonic", "runs", "delegate_temporal_cli", "artifacts");
    const patchFile = join(artifactDir, "worker.patch");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      patchFile,
      [
        "diff --git a/delegated.txt b/delegated.txt",
        "new file mode 100644",
        "index 0000000..b72eb3a",
        "--- /dev/null",
        "+++ b/delegated.txt",
        "@@ -0,0 +1 @@",
        "+cli",
        ""
      ].join("\n"),
      "utf8"
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliPath, "simple_workflow:patch", "--patch-file", patchFile, "--cwd", cwd],
      { cwd: projectRoot, encoding: "utf8" }
    );
    const parsed = JSON.parse(stdout) as { ok: boolean; artifact_id: string; mode: string; status: string };

    expect(parsed).toMatchObject({
      ok: true,
      artifact_id: "explicit_worker_patch",
      mode: "check",
      status: "applies"
    });
    await expect(access(join(cwd, "delegated.txt"))).rejects.toThrow();
  });
});
