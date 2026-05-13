import { execFile, spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WORKTREE_TEMP_PARENT = "/tmp";

export interface IsolatedWorktree {
  path: string;
  mode: "git_worktree" | "directory_copy_no_head";
  reason: string;
  baseHead: string;
}

export async function createIsolatedWorktree(input: {
  cwd: string;
  runId: string;
}): Promise<IsolatedWorktree> {
  const { root, target } = await temporaryWorktreeTarget(input.runId);
  let gitWorktreeAddStarted = false;

  try {
    const hasHead = await gitHeadExists(input.cwd);
    if (hasHead) {
      const baseHead = (await gitOutput(input.cwd, ["rev-parse", "--verify", "HEAD"])).trim();
      gitWorktreeAddStarted = true;
      await execFileAsync("git", ["worktree", "add", "--detach", target, "HEAD"], { cwd: input.cwd });
      await copyWorkingTreeSnapshot(input.cwd, target);
      return {
        path: target,
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

export async function removeIsolatedWorktree(input: {
  cwd: string;
  worktreePath: string;
}): Promise<void> {
  const root = await validateOwnedWorktreePath(input.worktreePath);
  let gitRemoveFailed = false;
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", input.worktreePath], { cwd: input.cwd });
  } catch {
    gitRemoveFailed = true;
  }
  await rm(root, { recursive: true, force: true });
  if (gitRemoveFailed) {
    await execFileAsync("git", ["worktree", "prune"], { cwd: input.cwd }).catch(() => undefined);
  }
}

export async function worktreePatch(input: {
  worktreePath: string;
  baseHead: string;
}): Promise<string> {
  await validateOwnedWorktreePath(input.worktreePath);
  await execFileAsync("git", ["add", "--all"], { cwd: input.worktreePath });
  return await gitOutput(input.worktreePath, ["diff", "--binary", "--cached", input.baseHead, "--", "."]);
}

async function temporaryWorktreeTarget(runId: string): Promise<{ root: string; target: string }> {
  const safeRunId = runId.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  const root = await mkdtemp(join(WORKTREE_TEMP_PARENT, `tychonic-worktree-${safeRunId}-`));
  return { root, target: join(root, "worktree") };
}

async function initializeIsolatedBaseline(target: string): Promise<void> {
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
        "--allow-empty",
        "-m",
        "tychonic isolated baseline"
      ],
      { cwd: target }
    );
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
      await execFileAsync("git", ["worktree", "remove", "--force", input.target], { cwd: input.cwd });
    } catch {
      gitRemoveFailed = true;
    }
  }
  await rm(input.root, { recursive: true, force: true });
  if (input.gitWorktreeAddStarted && gitRemoveFailed) {
    await execFileAsync("git", ["worktree", "prune"], { cwd: input.cwd }).catch(() => undefined);
  }
}

async function validateOwnedWorktreePath(worktreePath: string): Promise<string> {
  if (basename(worktreePath) !== "worktree") {
    throw new Error(`refusing to remove non-Tychonic worktree path: ${worktreePath}`);
  }
  const root = dirname(worktreePath);
  if (!basename(root).startsWith("tychonic-worktree-")) {
    throw new Error(`refusing to remove non-Tychonic worktree path: ${worktreePath}`);
  }
  const realTmp = await realpath(WORKTREE_TEMP_PARENT);
  const lexicalTmp = resolve(WORKTREE_TEMP_PARENT);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    realRoot = resolve(root);
  }
  const inRealTmp = realRoot === realTmp || realRoot.startsWith(`${realTmp}${sep}`);
  const inLexicalTmp = realRoot === lexicalTmp || realRoot.startsWith(`${lexicalTmp}${sep}`);
  if (!inRealTmp && !inLexicalTmp) {
    throw new Error(`refusing to remove worktree outside ${WORKTREE_TEMP_PARENT}: ${worktreePath}`);
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
