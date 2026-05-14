import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkflowRunRecord } from "../src/domain/types.js";
import { RunArtifactStore, runArtifactStoreForRun } from "../src/storage/runArtifactStore.js";

describe("RunArtifactStore path resolution", () => {
  it("resolves artifact and live log paths inside the Tychonic root", async () => {
    const runsParent = await mkdtemp(join(tmpdir(), "tychonic-store-runs-"));
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-store-cwd-"));
    const store = new RunArtifactStore(runsParent);
    const run: WorkflowRunRecord = {
      schema_version: "tychonic.run.v1",
      id: "run_store",
      template: "checkpoint",
      status: "succeeded",
      cwd,
      artifact_root: join(runsParent, "run_store"),
      created_at: "2026-04-19T00:00:00.000Z",
      updated_at: "2026-04-19T00:00:00.000Z",
      states: [],
      activity_attempts: [
        {
          id: "attempt_1",
          state_id: "state_1",
          kind: "deterministic_command",
          status: "succeeded",
          reason: "ok",
          cwd,
          live_output_path: "live/attempt_1.log",
          started_at: "2026-04-19T00:00:00.000Z"
        }
      ],
      agent_sessions: [],
      artifacts: [
        {
          id: "artifact_1",
          kind: "output",
          path: "artifacts/output.txt",
          created_at: "2026-04-19T00:00:00.000Z"
        }
      ],
      findings: [],
      inbox: []
    };

    expect(store.artifactPath(run, "artifact_1")).toBe(join(runsParent, "run_store/artifacts/output.txt"));
    expect(store.liveOutputPath(run, "attempt_1")).toBe(join(runsParent, "run_store/live/attempt_1.log"));
  });

  it("rejects project .tychonic evidence paths outside the run root", async () => {
    const runsParent = await mkdtemp(join(tmpdir(), "tychonic-store-runs-"));
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-store-cwd-"));
    const store = new RunArtifactStore(runsParent);
    const artifactRoot = join(runsParent, "run_store");
    const run: WorkflowRunRecord = {
      schema_version: "tychonic.run.v1",
      id: "run_store",
      template: "checkpoint",
      status: "succeeded",
      cwd,
      artifact_root: artifactRoot,
      created_at: "2026-04-19T00:00:00.000Z",
      updated_at: "2026-04-19T00:00:00.000Z",
      states: [],
      activity_attempts: [
        {
          id: "attempt_1",
          state_id: "state_1",
          kind: "deterministic_command",
          status: "succeeded",
          reason: "ok",
          cwd,
          live_output_path: ".tychonic/runs/run_store/live/attempt_1.log",
          started_at: "2026-04-19T00:00:00.000Z"
        }
      ],
      agent_sessions: [],
      artifacts: [
        {
          id: "artifact_1",
          kind: "output",
          path: ".tychonic/runs/run_store/artifacts/output.txt",
          created_at: "2026-04-19T00:00:00.000Z"
        }
      ],
      findings: [],
      inbox: []
    };

    expect(() => store.artifactPath(run, "artifact_1")).toThrow(/removed project \.tychonic/);
    expect(() => store.liveOutputPath(run, "attempt_1")).toThrow(/removed project \.tychonic/);
  });

  it("requires artifact_root for run-specific artifact storage", () => {
    const run = {
      schema_version: "tychonic.run.v1",
      id: "run_missing_root",
      template: "checkpoint",
      status: "succeeded",
      cwd: "/repo",
      created_at: "2026-04-19T00:00:00.000Z",
      updated_at: "2026-04-19T00:00:00.000Z",
      states: [],
      activity_attempts: [],
      agent_sessions: [],
      artifacts: [],
      findings: [],
      inbox: []
    } as unknown as WorkflowRunRecord;

    expect(() => runArtifactStoreForRun(run)).toThrow(/artifact_root is required/);
  });

  it("rejects stored paths that escape the Tychonic root", async () => {
    const runsParent = await mkdtemp(join(tmpdir(), "tychonic-store-runs-escape-"));
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-store-cwd-escape-"));
    const store = new RunArtifactStore(runsParent);
    const run: WorkflowRunRecord = {
      schema_version: "tychonic.run.v1",
      id: "run_store",
      template: "checkpoint",
      status: "succeeded",
      cwd,
      artifact_root: join(runsParent, "run_store"),
      created_at: "2026-04-19T00:00:00.000Z",
      updated_at: "2026-04-19T00:00:00.000Z",
      states: [],
      activity_attempts: [],
      agent_sessions: [],
      artifacts: [
        {
          id: "artifact_bad",
          kind: "output",
          path: "../outside.txt",
          created_at: "2026-04-19T00:00:00.000Z"
        }
      ],
      findings: [],
      inbox: []
    };

    expect(() => store.artifactPath(run, "artifact_bad")).toThrow(/escapes/);
  });

  it("honors artifact_root as the run root even when its basename differs from the run id", async () => {
    const runsParent = await mkdtemp(join(tmpdir(), "tychonic-store-explicit-root-"));
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-store-explicit-cwd-"));
    const run: WorkflowRunRecord = {
      schema_version: "tychonic.run.v1",
      id: "run_explicit",
      template: "checkpoint",
      status: "succeeded",
      cwd,
      artifact_root: join(runsParent, "custom-root"),
      created_at: "2026-04-19T00:00:00.000Z",
      updated_at: "2026-04-19T00:00:00.000Z",
      states: [],
      activity_attempts: [
        {
          id: "attempt_1",
          state_id: "state_1",
          kind: "deterministic_command",
          status: "succeeded",
          reason: "ok",
          cwd,
          live_output_path: "live/attempt_1.log",
          started_at: "2026-04-19T00:00:00.000Z"
        }
      ],
      agent_sessions: [],
      artifacts: [
        {
          id: "artifact_1",
          kind: "output",
          path: "artifacts/output.txt",
          created_at: "2026-04-19T00:00:00.000Z"
        }
      ],
      findings: [],
      inbox: []
    };

    const store = runArtifactStoreForRun(run);

    expect(store.runDir(run.id)).toBe(join(runsParent, "custom-root"));
    expect(store.artifactPath(run, "artifact_1")).toBe(join(runsParent, "custom-root/artifacts/output.txt"));
    expect(store.liveOutputPath(run, "attempt_1")).toBe(join(runsParent, "custom-root/live/attempt_1.log"));
  });

  it("rejects run ids that are not single path segments", async () => {
    const runsParent = await mkdtemp(join(tmpdir(), "tychonic-store-invalid-run-"));
    const store = new RunArtifactStore(runsParent);

    expect(() => store.runDir("../escape")).toThrow(/run id must be a single path segment/);
    expect(() => store.runDir("nested/run")).toThrow(/run id must be a single path segment/);
    expect(
      () => new RunArtifactStore(runsParent, new Map([["../escape", join(runsParent, "escape")]]))
    ).toThrow(/run id must be a single path segment/);
  });

  it("writes artifacts without mutating the run record", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-store-write-cwd-"));
    const runsParent = await mkdtemp(join(tmpdir(), "tychonic-store-write-runs-"));
    const store = new RunArtifactStore(runsParent);
    const run: WorkflowRunRecord = {
      schema_version: "tychonic.run.v1",
      id: "run_store_write",
      template: "checkpoint",
      status: "running",
      cwd,
      artifact_root: join(runsParent, "run_store_write"),
      created_at: "2026-04-19T00:00:00.000Z",
      updated_at: "2026-04-19T00:00:00.000Z",
      states: [],
      activity_attempts: [],
      agent_sessions: [],
      artifacts: [],
      findings: [],
      inbox: []
    };

    const artifact = await store.writeArtifact({
      run,
      id: "artifact_1",
      kind: "output",
      filename: "output.txt",
      content: "hello\n",
      createdAt: "2026-04-19T00:00:00.000Z"
    });

    expect(run.artifacts).toEqual([]);
    expect(artifact.path).toBe("artifacts/output.txt");
    await expect(readFile(join(runsParent, "run_store_write", artifact.path), "utf8")).resolves.toBe("hello\n");
  });
});
