import { ApplicationFailure } from "@temporalio/common";
import { execFile, spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gitChildEnv, resolveGitExecutable } from "./executables.js";

const execFileAsync = promisify(execFile);

export interface IsolatedWorktree {
  path: string;
  worktreeParentDir: string;
  mode: "git_worktree" | "directory_copy_no_head";
  reason: string;
  baseHead: string;
}

export async function createIsolatedWorktree(input: {
  cwd: string;
  runId: string;
  worktreeParentDir: string;
}): Promise<IsolatedWorktree> {
  const { root, target } = await temporaryWorktreeTarget(input.runId, input.worktreeParentDir);
  let gitWorktreeAddStarted = false;

  try {
    const hasHead = await gitHeadExists(input.cwd);
    if (hasHead) {
      const baseHead = (await gitOutput(input.cwd, ["rev-parse", "--verify", "HEAD"])).trim();
      const git = await resolveGitExecutable();
      gitWorktreeAddStarted = true;
      await execFileAsync(git, ["worktree", "add", "--detach", target, "HEAD"], {
        cwd: input.cwd,
        env: gitChildEnv(process.env, git)
      });
      await initializeSubmodules(target);
      await copyWorkingTreeSnapshot(input.cwd, target);
      return {
        path: target,
        worktreeParentDir: input.worktreeParentDir,
        mode: "git_worktree",
        reason: "created detached git worktree from HEAD with working tree snapshot",
        baseHead
      };
    }

    await mkdir(target, { recursive: true });
    await copyNoHeadWorkingTreeSnapshot(input.cwd, target);
    await initializeIsolatedBaseline(target);
    const baseHead = (await gitOutput(target, ["rev-parse", "--verify", "HEAD"])).trim();
    return {
      path: target,
      worktreeParentDir: input.worktreeParentDir,
      mode: "directory_copy_no_head",
      baseHead,
      reason:
        "repository has no HEAD; copied working files into an isolated directory with a local baseline commit"
    };
  } catch (error) {
    await cleanupFailedWorktree({ cwd: input.cwd, root, target, gitWorktreeAddStarted });
    throw error;
  }
}

export async function worktreePatch(input: {
  worktreePath: string;
  baseHead: string;
  worktreeParentDir: string;
}): Promise<string> {
  await validateOwnedWorktreePath(input.worktreePath, input.worktreeParentDir);
  const git = await resolveGitExecutable();
  await execFileAsync(git, ["add", "--all"], {
    cwd: input.worktreePath,
    env: gitChildEnv(process.env, git)
  });
  return await gitOutput(input.worktreePath, ["diff", "--binary", "--cached", input.baseHead, "--", "."]);
}

async function temporaryWorktreeTarget(runId: string, worktreeParentDir: string): Promise<{ root: string; target: string }> {
  const safeRunId = runId.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  await mkdir(worktreeParentDir, { recursive: true });
  const root = await mkdtemp(join(worktreeParentDir, `tychonic-worktree-${safeRunId}-`));
  return { root, target: join(root, "worktree") };
}

/**
 * Initialize git submodules inside the isolated worktree. `git worktree add`
 * does not init submodules, so a worktree of a submodule-using repo would
 * otherwise have empty submodule directories and `work` commands could not
 * read those files. Runs unconditionally after `git worktree add`; a repo
 * with no `.gitmodules` makes this a no-op (`git submodule update --init`
 * exits 0 with nothing to do).
 */
async function initializeSubmodules(target: string): Promise<void> {
  try {
    const git = await resolveGitExecutable();
    await execFileAsync(git, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"], {
      cwd: target,
      env: gitChildEnv(process.env, git)
    });
  } catch (error) {
    throw new Error(
      `failed to initialize submodules in isolated worktree: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function initializeIsolatedBaseline(target: string): Promise<void> {
  const git = await resolveGitExecutable();
  const env = {
    ...gitChildEnv(process.env, git),
    GIT_AUTHOR_NAME: "Tychonic",
    GIT_AUTHOR_EMAIL: "tychonic@example.invalid",
    GIT_COMMITTER_NAME: "Tychonic",
    GIT_COMMITTER_EMAIL: "tychonic@example.invalid"
  };
  await execFileAsync(git, ["init"], { cwd: target, env });
  await execFileAsync(git, ["symbolic-ref", "HEAD", "refs/heads/tychonic-baseline"], { cwd: target, env });
  await execFileAsync(git, ["add", "."], { cwd: target, env });
  try {
    const { stdout: tree } = await execFileAsync(git, ["write-tree"], { cwd: target, env, encoding: "utf8" });
    const { stdout: commit } = await execFileAsync(git, ["commit-tree", tree.trim(), "-m", "tychonic isolated baseline"], {
      cwd: target,
      env,
      encoding: "utf8"
    });
    await execFileAsync(git, ["update-ref", "HEAD", commit.trim()], { cwd: target, env });
  } catch (error) {
    throw new Error(`failed to create isolated baseline commit: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function cleanupFailedWorktree(input: {
  cwd: string;
  root: string;
  target: string;
  gitWorktreeAddStarted: boolean;
}): Promise<void> {
  let gitRemoveFailed = false;
  if (input.gitWorktreeAddStarted) {
    try {
      const git = await resolveGitExecutable();
      await execFileAsync(git, ["worktree", "remove", "--force", input.target], {
        cwd: input.cwd,
        env: gitChildEnv(process.env, git)
      });
    } catch {
      gitRemoveFailed = true;
    }
  }
  await rm(input.root, { recursive: true, force: true });
  if (input.gitWorktreeAddStarted && gitRemoveFailed) {
    const git = await resolveGitExecutable();
    await execFileAsync(git, ["worktree", "prune"], {
      cwd: input.cwd,
      env: gitChildEnv(process.env, git)
    }).catch(() => undefined);
  }
}

async function validateOwnedWorktreePath(worktreePath: string, worktreeParentDir: string): Promise<string> {
  if (basename(worktreePath) !== "worktree") {
    throw ApplicationFailure.nonRetryable(
      `refusing to operate on non-Tychonic worktree path: ${worktreePath}`,
      "WorktreePathRejected"
    );
  }
  const root = dirname(worktreePath);
  if (!basename(root).startsWith("tychonic-worktree-")) {
    throw ApplicationFailure.nonRetryable(
      `refusing to operate on non-Tychonic worktree path: ${worktreePath}`,
      "WorktreePathRejected"
    );
  }
  const lexicalParent = resolve(worktreeParentDir);
  let realParent: string;
  try {
    realParent = await realpath(worktreeParentDir);
  } catch {
    realParent = lexicalParent;
  }
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    realRoot = resolve(root);
  }
  const inRealParent = realRoot === realParent || realRoot.startsWith(`${realParent}${sep}`);
  const inLexicalParent = realRoot === lexicalParent || realRoot.startsWith(`${lexicalParent}${sep}`);
  if (!inRealParent && !inLexicalParent) {
    throw ApplicationFailure.nonRetryable(
      `refusing to operate on worktree outside ${worktreeParentDir}: ${worktreePath}`,
      "WorktreePathOutsideParent"
    );
  }
  return root;
}

async function copyWorkingTreeSnapshot(repo: string, target: string): Promise<void> {
  const patch = await gitOutput(repo, ["diff", "--binary", "HEAD"]);
  if (patch.trim()) {
    await gitApply(target, patch);
  }

  const untracked = await gitOutput(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const raw of untracked.split("\0")) {
    const rel = raw.replaceAll("\\", "/");
    if (!rel || rel.startsWith(".tychonic/")) {
      continue;
    }
    await copySnapshotPath(join(repo, rel), join(target, rel));
  }
}

async function copyNoHeadWorkingTreeSnapshot(repo: string, target: string): Promise<void> {
  const visible = await gitOutput(repo, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  for (const raw of visible.split("\0")) {
    const rel = raw.replaceAll("\\", "/");
    if (!rel) {
      continue;
    }
    await copySnapshotPath(join(repo, rel), join(target, rel));
  }
}

async function copySnapshotPath(source: string, target: string): Promise<void> {
  const info = await lstat(source);
  if (info.isDirectory()) {
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  if (info.isSymbolicLink()) {
    const linkTarget = await readlink(source);
    await symlink(linkTarget, target);
    return;
  }
  await cp(source, target);
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const git = await resolveGitExecutable();
  const { stdout } = await execFileAsync(git, args, {
    cwd,
    encoding: "utf8",
    env: gitChildEnv(process.env, git),
    maxBuffer: 20 * 1024 * 1024
  });
  return stdout;
}

async function gitApply(cwd: string, patch: string): Promise<void> {
  const git = await resolveGitExecutable();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(git, ["apply", "--binary", "--whitespace=nowarn", "-"], {
      cwd,
      env: gitChildEnv(process.env, git),
      stdio: ["pipe", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `git apply exited with code ${code}`));
    });
    child.stdin.end(patch);
  });
}

async function gitHeadExists(cwd: string): Promise<boolean> {
  try {
    const git = await resolveGitExecutable();
    await execFileAsync(git, ["rev-parse", "--verify", "HEAD"], {
      cwd,
      env: gitChildEnv(process.env, git)
    });
    return true;
  } catch {
    return false;
  }
}
