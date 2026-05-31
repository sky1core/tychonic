import { ApplicationFailure } from "@temporalio/common";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { worktreePatch } from "../bootstrap/worktree.js";
import { withPeriodicProgress } from "../bootstrap/commandRunner.js";
import type { ArtifactRecord, WorkflowRunRecord } from "../domain/types.js";
import { runArtifactStoreForRun } from "../storage/runArtifactStore.js";
import type { ActivityResult } from "../temporal/types.js";
import { heartbeatActivity, throwIfCancelled } from "./heartbeat.js";

export interface ExtractWorktreePatchActivityInput {
  run: WorkflowRunRecord;
  cwd: string;
  worktreePath: string;
  worktreeParentDir: string;
  baseHead: string;
}

export interface ExtractWorktreePatchActivityResult extends ActivityResult {
  extracted: true;
  patchArtifact?: ArtifactRecord;
}

/**
 * Captures a `worktree_patch` artifact from a Tychonic-created isolated
 * worktree without removing the worktree directory. Workflows call this on
 * finish to preserve a diff snapshot of the agent's work while leaving the
 * worktree on disk for the operator to inspect, hand-apply, or remove with
 * standard tools.
 *
 * The worktree directory itself is never removed by this activity or by any
 * other Tychonic finish path; cleanup is the operator's responsibility.
 */
export async function extractWorktreePatchActivity(
  input: ExtractWorktreePatchActivityInput
): Promise<ExtractWorktreePatchActivityResult> {
  const progress = (): void => heartbeatActivity({ runId: input.run.id, activity: "extractWorktreePatch" });
  const createdAt = new Date().toISOString();
  const worktreeParentDir = requireString(input.worktreeParentDir, "worktreeParentDir");
  const existing = await existingPatchArtifactRecord({ run: input.run, cwd: input.cwd, createdAt });
  if (existing) {
    return extractResult(existing);
  }
  if (!(await pathExists(input.worktreePath))) {
    return extractResult(undefined);
  }
  const patchArtifact = await withPeriodicProgress(
    progress,
    async () => {
      const patch = await worktreePatch({
        worktreePath: input.worktreePath,
        baseHead: input.baseHead,
        worktreeParentDir
      });
      return await writePatchArtifact({
        run: input.run,
        cwd: input.cwd,
        patch,
        createdAt
      });
    },
    { onAfter: throwIfCancelled }
  );
  return extractResult(patchArtifact);
}

function extractResult(patchArtifact: ArtifactRecord | undefined): ExtractWorktreePatchActivityResult {
  return {
    extracted: true,
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
  const store = runArtifactStoreForRun(input.run);
  const artifactsDir = store.artifactsDir(input.run.id);
  const id = nextArtifactId(input.run);
  const kind = "worktree_patch";
  const filePath = join(artifactsDir, `${kind}-${id}.patch`);
  return {
    artifact: {
      id,
      kind,
      path: store.storedPath(input.run.id, filePath),
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

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw ApplicationFailure.nonRetryable(
      `extractWorktreePatchActivity.${field} is required`,
      "ExtractWorktreePatchInputInvalid"
    );
  }
  return value;
}
