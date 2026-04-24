import { execFile, spawn } from "node:child_process";
import { cp, lstat, mkdir, readlink, readdir, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface IsolatedWorktree {
  path: string;
  mode: "git_worktree" | "directory_copy_no_head";
  reason: string;
}

const EXCLUDED_DIRS = new Set([".git", ".tychonic", "node_modules", "dist", "coverage"]);

export async function createIsolatedWorktree(input: {
  cwd: string;
  runId: string;
}): Promise<IsolatedWorktree> {
  const worktreesRoot = join(input.cwd, ".tychonic", "worktrees");
  const target = join(worktreesRoot, input.runId);
  await mkdir(worktreesRoot, { recursive: true });

  const hasHead = await gitHeadExists(input.cwd);
  if (hasHead) {
    await execFileAsync("git", ["worktree", "add", "--detach", target, "HEAD"], { cwd: input.cwd });
    await copyWorkingTreeSnapshot(input.cwd, target);
    await prepareWritableToolAnchors(target);
    return {
      path: target,
      mode: "git_worktree",
      reason: "created detached git worktree from HEAD with working tree snapshot"
    };
  }

  await mkdir(target, { recursive: true });
  const entries = await readdir(input.cwd);
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry)) {
      continue;
    }

    await cp(join(input.cwd, entry), join(target, entry), {
      recursive: true,
      filter: (source) => {
        const rel = relative(input.cwd, source);
        const first = rel.split(/[\\/]/)[0];
        return !EXCLUDED_DIRS.has(first ?? "");
      }
    });
  }
  await execFileAsync("git", ["init"], { cwd: target });
  await execFileAsync("git", ["add", "."], { cwd: target });
  try {
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Tychonic",
        "-c",
        "user.email=tychonic@example.invalid",
        "commit",
        "-m",
        "tychonic isolated baseline"
      ],
      { cwd: target }
    );
  } catch {
    // Empty isolated copies have no baseline to commit.
  }
  await prepareWritableToolAnchors(target);

  return {
    path: target,
    mode: "directory_copy_no_head",
    reason:
      "repository has no HEAD; copied working files into an isolated directory with a local baseline commit"
  };
}

async function prepareWritableToolAnchors(worktreePath: string): Promise<void> {
  await mkdir(join(worktreePath, "node_modules"), { recursive: true });
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
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

async function gitApply(cwd: string, patch: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["apply", "--binary", "--whitespace=nowarn", "-"], {
      cwd,
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
    await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd });
    return true;
  } catch {
    return false;
  }
}
