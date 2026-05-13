import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { removeIsolatedWorktree } from "../bootstrap/worktree.js";
import { worktreePatch } from "../bootstrap/worktree.js";
import { withPeriodicProgress } from "../bootstrap/commandRunner.js";
import type { ArtifactRecord, WorkflowRunRecord } from "../domain/types.js";
import { RunArtifactStore } from "../storage/runArtifactStore.js";
import type { ActivityResult } from "../temporal/types.js";
import { heartbeatActivity } from "./heartbeat.js";

export interface CleanupWorktreeActivityInput {
  run: WorkflowRunRecord;
  cwd: string;
  worktreePath: string;
  baseHead: string;
}

export interface CleanupWorktreeActivityResult extends ActivityResult {
  cleaned: true;
  patchArtifact?: ArtifactRecord;
}

/**
 * Removes a Tychonic-created isolated worktree. Workflows call this only after
 * they no longer need to continue work in the mutable checkout.
 */
export async function cleanupWorktreeActivity(
  input: CleanupWorktreeActivityInput
): Promise<CleanupWorktreeActivityResult> {
  const progress = (): void => heartbeatActivity({ runId: input.run.id, activity: "cleanupWorktree" });
  const createdAt = new Date().toISOString();
  const existingPatchArtifact = async (): Promise<ArtifactRecord | undefined> =>
    await existingPatchArtifactRecord({ run: input.run, cwd: input.cwd, createdAt });
  if (!(await pathExists(input.worktreePath))) {
    const patchArtifact = await existingPatchArtifact();
    await withPeriodicProgress(progress, async () => await removeIsolatedWorktree(input));
    return cleanupResult(patchArtifact);
  }
  const patchArtifact = await withPeriodicProgress(progress, async () => {
    const existing = await existingPatchArtifact();
    if (existing) {
      return existing;
    }
    const patch = await worktreePatch({ worktreePath: input.worktreePath, baseHead: input.baseHead });
    return patch.trim()
      ? await writePatchArtifact({
          run: input.run,
          cwd: input.cwd,
          patch,
          createdAt
        })
      : undefined;
  });
  await withPeriodicProgress(progress, async () => await removeIsolatedWorktree(input));
  return cleanupResult(patchArtifact);
}

function cleanupResult(patchArtifact: ArtifactRecord | undefined): CleanupWorktreeActivityResult {
  return {
    cleaned: true,
    delta: {},
    cleanupOutcome: { artifacts: patchArtifact ? [patchArtifact] : [] },
    ...(patchArtifact ? { patchArtifact } : {})
  };
}

async function writePatchArtifact(input: {
  run: WorkflowRunRecord;
  cwd: string;
  patch: string;
  createdAt: string;
}): Promise<ArtifactRecord> {
  const { artifact, artifactsDir, filePath } = patchArtifactRecord({
    run: input.run,
    cwd: input.cwd,
    createdAt: input.createdAt
  });
  await mkdir(artifactsDir, { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, input.patch, "utf8");
  await rename(tempPath, filePath);
  return artifact;
}

async function existingPatchArtifactRecord(input: {
  run: WorkflowRunRecord;
  cwd: string;
  createdAt: string;
}): Promise<ArtifactRecord | undefined> {
  const { artifact, filePath } = patchArtifactRecord(input);
  return (await pathExists(filePath)) ? artifact : undefined;
}

function patchArtifactRecord(input: {
  run: WorkflowRunRecord;
  cwd: string;
  createdAt: string;
}): { artifact: ArtifactRecord; artifactsDir: string; filePath: string } {
  const store = new RunArtifactStore(join(input.cwd, ".tychonic"));
  const artifactsDir = store.artifactsDir(input.run.id);
  const id = nextArtifactId(input.run);
  const kind = "worktree_patch";
  const filePath = join(artifactsDir, `${kind}-${id}.patch`);
  return {
    artifact: {
      id,
      kind,
      path: relative(dirname(store.rootDir), filePath),
      created_at: input.createdAt
    },
    artifactsDir,
    filePath
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function nextArtifactId(run: WorkflowRunRecord): string {
  let counter = 0;
  for (const artifact of run.artifacts) {
    const match = /^artifact_(\d+)$/.exec(artifact.id);
    if (match) {
      counter = Math.max(counter, Number(match[1]));
    }
  }
  return `artifact_${counter + 1}`;
}
