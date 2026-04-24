import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createIsolatedWorktree } from "../src/bootstrap/worktree.js";

const execFileAsync = promisify(execFile);

describe("createIsolatedWorktree", () => {
  it("copies tracked dirty changes and untracked files into a git worktree when HEAD exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-worktree-"));
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Tychonic Test"], { cwd });
    await execFileAsync("git", ["config", "user.email", "tychonic@example.invalid"], { cwd });
    await writeFile(join(cwd, "tracked.txt"), "committed\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd });

    await writeFile(join(cwd, "tracked.txt"), "dirty tracked\n", "utf8");
    await writeFile(join(cwd, "untracked.txt"), "untracked\n", "utf8");

    const isolated = await createIsolatedWorktree({ cwd, runId: "run_with_head" });

    expect(isolated.mode).toBe("git_worktree");
    await expect(readFile(join(isolated.path, "tracked.txt"), "utf8")).resolves.toBe("dirty tracked\n");
    await expect(readFile(join(isolated.path, "untracked.txt"), "utf8")).resolves.toBe("untracked\n");

    const { stdout } = await execFileAsync("git", ["status", "--short"], {
      cwd: isolated.path,
      encoding: "utf8"
    });
    expect(stdout).toContain("M tracked.txt");
    expect(stdout).toContain("?? untracked.txt");
  });

  it("creates a writable node_modules anchor inside the isolated worktree", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-worktree-tool-anchor-"));
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Tychonic Test"], { cwd });
    await execFileAsync("git", ["config", "user.email", "tychonic@example.invalid"], { cwd });
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n", "utf8");
    await writeFile(join(cwd, "package.json"), "{\"scripts\":{\"test\":\"vitest\"}}\n", "utf8");
    await execFileAsync("git", ["add", ".gitignore", "package.json"], { cwd });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd });

    const isolated = await createIsolatedWorktree({ cwd, runId: "run_with_tool_anchor" });

    await expect(stat(join(isolated.path, "node_modules"))).resolves.toMatchObject({
      mode: expect.any(Number)
    });
    await writeFile(join(isolated.path, "node_modules", ".vite-temp-probe"), "ok\n", "utf8");

    const { stdout } = await execFileAsync("git", ["status", "--short", "--untracked-files=all"], {
      cwd: isolated.path,
      encoding: "utf8"
    });
    expect(stdout).toBe("");
  });
});
