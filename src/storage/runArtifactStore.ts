import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { stringify } from "yaml";
import type { TychonicConfig } from "../catalog/types.js";
import type { ArtifactRecord, WorkflowRunRecord } from "../domain/types.js";

export class RunArtifactStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  runDir(runId: string): string {
    return join(this.rootDir, "runs", runId);
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
    return this.resolveStoredPath(artifact.path);
  }

  liveOutputPath(run: WorkflowRunRecord, attemptId: string): string {
    const attempt = run.activity_attempts.find((candidate) => candidate.id === attemptId);
    if (!attempt?.live_output_path) {
      throw new Error(`live output not found for attempt: ${attemptId}`);
    }
    return this.resolveStoredPath(attempt.live_output_path);
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
      path: relative(dirname(this.rootDir), path),
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

  private resolveStoredPath(storedPath: string): string {
    const repoRoot = dirname(this.rootDir);
    const resolved = resolve(repoRoot, storedPath);
    const allowedRoot = resolve(this.rootDir);
    if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${sep}`)) {
      throw new Error("stored path escapes Tychonic root");
    }
    return resolved;
  }
}
