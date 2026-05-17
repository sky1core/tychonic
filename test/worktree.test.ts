import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createIsolatedWorktree } from "../src/bootstrap/worktree.js";

const execFileAsync = promisify(execFile);

describe("createIsolatedWorktree", () => {
  it("copies tracked dirty changes and untracked files into a git worktree when HEAD exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-worktree-"));
    const worktreeParentDir = await makeWorktreeParentDir();
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Tychonic Test"], { cwd });
    await execFileAsync("git", ["config", "user.email", "tychonic@example.invalid"], { cwd });
    await writeFile(join(cwd, "tracked.txt"), "committed\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd });

    await writeFile(join(cwd, "tracked.txt"), "dirty tracked\n", "utf8");
    await writeFile(join(cwd, "untracked.txt"), "untracked\n", "utf8");

    const isolated = await createIsolatedWorktree({ cwd, runId: "run_with_head", worktreeParentDir });

    expect(isolated.mode).toBe("git_worktree");
    expect(isolated.worktreeParentDir).toBe(worktreeParentDir);
    expect(isolated.path).toMatch(/tychonic-worktree-run_with_head-.+[\\/]worktree$/);
    expect((await realpath(isolated.path)).startsWith(`${await realpath(worktreeParentDir)}/`)).toBe(true);
    await expect(access(join(cwd, ".tychonic", "worktrees", "run_with_head"))).rejects.toThrow();
    await expect(readFile(join(isolated.path, "tracked.txt"), "utf8")).resolves.toBe("dirty tracked\n");
    await expect(readFile(join(isolated.path, "untracked.txt"), "utf8")).resolves.toBe("untracked\n");

    const { stdout } = await execFileAsync("git", ["status", "--short"], {
      cwd: isolated.path,
      encoding: "utf8"
    });
    expect(stdout).toContain("M tracked.txt");
    expect(stdout).toContain("?? untracked.txt");

    const sourceWorktrees = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8"
    });
    expect(sourceWorktrees.stdout).toContain(isolated.path);
  });

  it("uses standard git ignore rules when copying a repository with no HEAD", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-worktree-no-head-"));
    const worktreeParentDir = await makeWorktreeParentDir();
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, ".gitignore"), ".env\n*.local.md\n", "utf8");
    await writeFile(join(cwd, ".env"), "SECRET=value\n", "utf8");
    await writeFile(join(cwd, "notes.local.md"), "private notes\n", "utf8");
    await writeFile(join(cwd, "README.md"), "visible\n", "utf8");
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "app.ts"), "export const visible = true;\n", "utf8");

    const isolated = await createIsolatedWorktree({ cwd, runId: "run_no_head_ignore", worktreeParentDir });

    expect(isolated.mode).toBe("directory_copy_no_head");
    expect(isolated.path).toMatch(/tychonic-worktree-run_no_head_ignore-.+[\\/]worktree$/);
    expect((await realpath(isolated.path)).startsWith(`${await realpath(worktreeParentDir)}/`)).toBe(true);
    await expect(access(join(cwd, ".tychonic", "worktrees", "run_no_head_ignore"))).rejects.toThrow();
    await expect(readFile(join(isolated.path, ".gitignore"), "utf8")).resolves.toBe(".env\n*.local.md\n");
    await expect(readFile(join(isolated.path, "README.md"), "utf8")).resolves.toBe("visible\n");
    await expect(readFile(join(isolated.path, "src", "app.ts"), "utf8")).resolves.toBe(
      "export const visible = true;\n"
    );
    await expect(readFile(join(isolated.path, ".env"), "utf8")).rejects.toThrow();
    await expect(readFile(join(isolated.path, "notes.local.md"), "utf8")).rejects.toThrow();
  });

  it("keeps a local HEAD when the source HEAD has an empty tree", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-worktree-empty-head-"));
    const worktreeParentDir = await makeWorktreeParentDir();
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Tychonic Test"], { cwd });
    await execFileAsync("git", ["config", "user.email", "tychonic@example.invalid"], { cwd });
    await execFileAsync("git", ["commit", "--allow-empty", "-m", "empty"], { cwd });
    await writeFile(join(cwd, "new.txt"), "new\n", "utf8");

    const isolated = await createIsolatedWorktree({ cwd, runId: "run_empty_head", worktreeParentDir });

    expect(isolated.mode).toBe("git_worktree");
    await expect(
      execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: isolated.path, encoding: "utf8" })
    ).resolves.toMatchObject({ stdout: expect.stringMatching(/[0-9a-f]{40}/) });
    const { stdout } = await execFileAsync("git", ["status", "--short"], {
      cwd: isolated.path,
      encoding: "utf8"
    });
    expect(stdout).toContain("?? new.txt");
  });

  it("copies tracked files even when .gitattributes marks them export-ignore", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-worktree-export-ignore-"));
    const worktreeParentDir = await makeWorktreeParentDir();
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Tychonic Test"], { cwd });
    await execFileAsync("git", ["config", "user.email", "tychonic@example.invalid"], { cwd });
    await writeFile(join(cwd, ".gitattributes"), "hidden.txt export-ignore\n", "utf8");
    await writeFile(join(cwd, "hidden.txt"), "must stay in worker snapshot\n", "utf8");
    await execFileAsync("git", ["add", ".gitattributes", "hidden.txt"], { cwd });
    await execFileAsync("git", ["commit", "-m", "tracked export ignored file"], { cwd });

    const isolated = await createIsolatedWorktree({ cwd, runId: "run_export_ignore", worktreeParentDir });

    expect(isolated.mode).toBe("git_worktree");
    await expect(readFile(join(isolated.path, "hidden.txt"), "utf8")).resolves.toBe(
      "must stay in worker snapshot\n"
    );
  });

  it("initializes submodules in the isolated worktree so submodule files are readable", async () => {
    const submoduleSource = await mkdtemp(join(tmpdir(), "tychonic-submodule-source-"));
    await execFileAsync("git", ["init"], { cwd: submoduleSource });
    await execFileAsync("git", ["config", "user.name", "Tychonic Test"], { cwd: submoduleSource });
    await execFileAsync("git", ["config", "user.email", "tychonic@example.invalid"], { cwd: submoduleSource });
    await writeFile(join(submoduleSource, "library.txt"), "library content\n", "utf8");
    await execFileAsync("git", ["add", "library.txt"], { cwd: submoduleSource });
    await execFileAsync("git", ["commit", "-m", "library seed"], { cwd: submoduleSource });

    const cwd = await mkdtemp(join(tmpdir(), "tychonic-worktree-submodule-"));
    const worktreeParentDir = await makeWorktreeParentDir();
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Tychonic Test"], { cwd });
    await execFileAsync("git", ["config", "user.email", "tychonic@example.invalid"], { cwd });

    // Git's CVE-2022-39253 mitigation disables the `file://` submodule transport
    // by default. The local fixture above uses a `file:` path, so allow that
    // protocol via env vars so each git sub-process (submodule add, then the
    // `git submodule update --init --recursive` run inside `createIsolatedWorktree`)
    // inherits the override.
    const fileAllowEnv = {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "protocol.file.allow",
      GIT_CONFIG_VALUE_0: "always"
    };
    await execFileAsync("git", ["submodule", "add", submoduleSource, "vendor/lib"], {
      cwd,
      env: fileAllowEnv
    });
    await execFileAsync("git", ["commit", "-m", "add submodule"], { cwd });

    const prevCount = process.env.GIT_CONFIG_COUNT;
    const prevKey = process.env.GIT_CONFIG_KEY_0;
    const prevValue = process.env.GIT_CONFIG_VALUE_0;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
    process.env.GIT_CONFIG_VALUE_0 = "always";
    let isolated;
    try {
      isolated = await createIsolatedWorktree({ cwd, runId: "run_submodule", worktreeParentDir });
    } finally {
      if (prevCount === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = prevCount;
      if (prevKey === undefined) delete process.env.GIT_CONFIG_KEY_0;
      else process.env.GIT_CONFIG_KEY_0 = prevKey;
      if (prevValue === undefined) delete process.env.GIT_CONFIG_VALUE_0;
      else process.env.GIT_CONFIG_VALUE_0 = prevValue;
    }

    expect(isolated.mode).toBe("git_worktree");
    await expect(readFile(join(isolated.path, "vendor", "lib", "library.txt"), "utf8")).resolves.toBe(
      "library content\n"
    );
  });

  it("does not follow TMPDIR back into the target project", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-worktree-env-tmpdir-"));
    const worktreeParentDir = await makeWorktreeParentDir();
    await execFileAsync("git", ["init"], { cwd });
    await writeFile(join(cwd, "README.md"), "visible\n", "utf8");

    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = join(cwd, ".tychonic", "tmp");
    try {
      const isolated = await createIsolatedWorktree({ cwd, runId: "run_env_tmpdir", worktreeParentDir });

      expect(isolated.path).toMatch(/tychonic-worktree-run_env_tmpdir-.+[\\/]worktree$/);
      expect((await realpath(isolated.path)).startsWith(`${await realpath(worktreeParentDir)}/`)).toBe(true);
      await expect(access(join(cwd, ".tychonic", "tmp"))).rejects.toThrow();
      await expect(access(join(cwd, ".tychonic", "worktrees", "run_env_tmpdir"))).rejects.toThrow();
    } finally {
      if (originalTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTmpdir;
      }
    }
  });

  it("removes git worktree metadata when snapshot copy fails after worktree creation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-worktree-copy-fail-"));
    const worktreeParentDir = await makeWorktreeParentDir();
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Tychonic Test"], { cwd });
    await execFileAsync("git", ["config", "user.email", "tychonic@example.invalid"], { cwd });
    await writeFile(join(cwd, "tracked.txt"), "committed\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd });

    const unreadablePath = join(cwd, "unreadable.txt");
    await writeFile(unreadablePath, "cannot copy\n", "utf8");
    await chmod(unreadablePath, 0o000);
    try {
      await expect(
        createIsolatedWorktree({ cwd, runId: "run_copy_failure", worktreeParentDir })
      ).rejects.toThrow();
    } finally {
      await chmod(unreadablePath, 0o600).catch(() => undefined);
    }

    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8"
    });
    expect(stdout).not.toContain("run_copy_failure");
  });
});

async function makeWorktreeParentDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "tychonic-state-worktrees-"));
}
