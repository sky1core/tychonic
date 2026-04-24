import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkflowRunRecord } from "../src/domain/types.js";
import { RunArtifactStore } from "../src/storage/runArtifactStore.js";

describe("RunArtifactStore path resolution", () => {
  it("resolves artifact and live log paths inside the Tychonic root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-store-"));
    const store = new RunArtifactStore(join(cwd, ".tychonic"));
    const run: WorkflowRunRecord = {
      schema_version: "tychonic.run.v1",
      id: "run_store",
      template: "checkpoint",
      status: "succeeded",
      cwd,
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

    expect(store.artifactPath(run, "artifact_1")).toBe(join(cwd, ".tychonic/runs/run_store/artifacts/output.txt"));
    expect(store.liveOutputPath(run, "attempt_1")).toBe(join(cwd, ".tychonic/runs/run_store/live/attempt_1.log"));
  });

  it("rejects stored paths that escape the Tychonic root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tychonic-store-escape-"));
    const store = new RunArtifactStore(join(cwd, ".tychonic"));
    const run: WorkflowRunRecord = {
      schema_version: "tychonic.run.v1",
      id: "run_store",
      template: "checkpoint",
      status: "succeeded",
      cwd,
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
});
