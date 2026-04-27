import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("uses standard git ignore rules when copying a repository with no HEAD", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-worktree-no-head-"));
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, ".gitignore"), ".env\n*.local.md\n", "utf8");
    await writeFile(join(cwd, ".env"), "SECRET=value\n", "utf8");
    await writeFile(join(cwd, "notes.local.md"), "private notes\n", "utf8");
    await writeFile(join(cwd, "README.md"), "visible\n", "utf8");
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "app.ts"), "export const visible = true;\n", "utf8");

    const isolated = await createIsolatedWorktree({ cwd, runId: "run_no_head_ignore" });

    expect(isolated.mode).toBe("directory_copy_no_head");
    await expect(readFile(join(isolated.path, ".gitignore"), "utf8")).resolves.toBe(".env\n*.local.md\n");
    await expect(readFile(join(isolated.path, "README.md"), "utf8")).resolves.toBe("visible\n");
    await expect(readFile(join(isolated.path, "src", "app.ts"), "utf8")).resolves.toBe(
      "export const visible = true;\n"
    );
    await expect(readFile(join(isolated.path, ".env"), "utf8")).rejects.toThrow();
    await expect(readFile(join(isolated.path, "notes.local.md"), "utf8")).rejects.toThrow();
  });
});
