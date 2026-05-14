import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stringify } from "yaml";
import type { TychonicConfig } from "../catalog/types.js";
import type { ArtifactRecord, WorkflowRunRecord } from "../domain/types.js";
import { tychonicRunsParentDir } from "../runtime/runDirs.js";

export class RunArtifactStore {
  readonly rootDir: string;
  private readonly runRoots: ReadonlyMap<string, string>;

  constructor(runsParentDir: string, runRoots: ReadonlyMap<string, string> = new Map()) {
    this.rootDir = resolve(runsParentDir);
    const normalizedRunRoots = new Map<string, string>();
    for (const [runId, runRoot] of runRoots) {
      assertRunIdPathSegment(runId);
      if (!isAbsolute(runRoot)) {
        throw new Error(`run artifact root must be an absolute path: ${runRoot}`);
      }
      const resolvedRunRoot = resolve(runRoot);
      if (!isInside(resolvedRunRoot, this.rootDir)) {
        throw new Error("run artifact root escapes Tychonic runs root");
      }
      normalizedRunRoots.set(runId, resolvedRunRoot);
    }
    this.runRoots = normalizedRunRoots;
  }

  runDir(runId: string): string {
    assertRunIdPathSegment(runId);
    const explicitRunRoot = this.runRoots.get(runId);
    if (explicitRunRoot) return explicitRunRoot;
    return join(this.rootDir, runId);
  }

  artifactsDir(runId: string): string {
    return join(this.runDir(runId), "artifacts");
  }

  liveDir(runId: string): string {
    return join(this.runDir(runId), "live");
  }

  async initializeRunArtifacts(run: WorkflowRunRecord): Promise<void> {
    await mkdir(this.artifactsDir(run.id), { recursive: true });
    await mkdir(this.liveDir(run.id), { recursive: true });
  }

  artifactPath(run: WorkflowRunRecord, artifactId: string): string {
    const artifact = run.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) {
      throw new Error(`artifact not found: ${artifactId}`);
    }
    return this.resolveStoredPath(run, artifact.path);
  }

  liveOutputPath(run: WorkflowRunRecord, attemptId: string): string {
    const attempt = run.activity_attempts.find((candidate) => candidate.id === attemptId);
    if (!attempt?.live_output_path) {
      throw new Error(`live output not found for attempt: ${attemptId}`);
    }
    return this.resolveStoredPath(run, attempt.live_output_path);
  }

  storedPath(runId: string, path: string): string {
    const resolved = resolve(path);
    const allowedRoot = resolve(this.runDir(runId));
    if (!isInside(resolved, allowedRoot)) {
      throw new Error("stored path escapes Tychonic run root");
    }
    return relative(allowedRoot, resolved);
  }

  async writeArtifact(input: {
    run: WorkflowRunRecord;
    id: string;
    kind: string;
    filename: string;
    content: string;
    createdAt: string;
    stateId?: string;
    activityAttemptId?: string;
  }): Promise<ArtifactRecord> {
    const path = join(this.artifactsDir(input.run.id), input.filename);
    await mkdir(this.artifactsDir(input.run.id), { recursive: true });
    await writeFile(path, input.content, "utf8");

    const artifact: ArtifactRecord = {
      id: input.id,
      kind: input.kind,
      path: this.storedPath(input.run.id, path),
      created_at: input.createdAt,
      ...(input.stateId ? { state_id: input.stateId } : {}),
      ...(input.activityAttemptId ? { activity_attempt_id: input.activityAttemptId } : {})
    };
    return artifact;
  }

  async writeProfileArtifacts(input: {
    run: WorkflowRunRecord;
    profile: TychonicConfig;
    createdAt: string;
    nextId: (prefix: string) => string;
    stateId?: string;
  }): Promise<{ snapshot: ArtifactRecord }> {
    const snapshot = await this.writeArtifact({
      run: input.run,
      id: input.nextId("artifact"),
      kind: "profile_snapshot",
      filename: "profile_snapshot.yaml",
      content: [
        "# Derived Tychonic workflow profile snapshot.",
        "# This file records the immutable effective settings for this run; edit the bundle's defaultProfile or pass --config <file> instead.",
        stringify(input.profile)
      ].join("\n"),
      createdAt: input.createdAt,
      ...(input.stateId ? { stateId: input.stateId } : {})
    });
    return { snapshot };
  }

  private resolveStoredPath(run: WorkflowRunRecord, storedPath: string): string {
    if (!isAbsolute(storedPath) && (storedPath === ".tychonic" || storedPath.startsWith(".tychonic/"))) {
      throw new Error("stored path uses removed project .tychonic evidence path");
    }
    const resolved = isAbsolute(storedPath)
      ? resolve(storedPath)
      : resolve(this.runDir(run.id), storedPath);
    const allowedRoot = resolve(this.runDir(run.id));
    if (isInside(resolved, allowedRoot)) {
      return resolved;
    }
    throw new Error("stored path escapes Tychonic run root");
  }
}

export function newRunArtifactStore(): RunArtifactStore {
  return new RunArtifactStore(tychonicRunsParentDir());
}

export function runArtifactStoreForRun(run: WorkflowRunRecord): RunArtifactStore {
  if (!run.artifact_root) {
    throw new Error("run.artifact_root is required for artifact storage");
  }
  if (!isAbsolute(run.artifact_root)) {
    throw new Error(`run.artifact_root must be an absolute path: ${run.artifact_root}`);
  }
  const artifactRoot = resolve(run.artifact_root);
  return new RunArtifactStore(dirname(artifactRoot), new Map([[run.id, artifactRoot]]));
}

function assertRunIdPathSegment(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(runId)) {
    throw new Error(`run id must be a single path segment: ${runId}`);
  }
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}
