import { execFile } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { startRunActivity } from "../src/activities/startRunActivity.js";
import { collectGitFactsActivity } from "../src/activities/collectGitFactsActivity.js";
import { createWorktreeActivity } from "../src/activities/createWorktreeActivity.js";
import { finalizeRunActivity } from "../src/activities/finalizeRunActivity.js";
import type { WorkflowRunRecord } from "../src/domain/types.js";

const execFileAsync = promisify(execFile);

describe("bootstrap activities", () => {
  describe("startRunActivity", () => {
    it("creates a fresh WorkflowRunRecord with generated id when none supplied", async () => {
      const run = await startRunActivity({ template: "checkpoint", cwd: "/ignored" });
      expect(run.schema_version).toBe("tychonic.run.v1");
      expect(run.template).toBe("checkpoint");
      expect(run.status).toBe("created");
      expect(run.id).toMatch(/^checkpoint_\d{8}_\d{9}_[a-z0-9]+$/);
      expect(run.states).toEqual([]);
      expect(run.activity_attempts).toEqual([]);
      expect(run.artifacts).toEqual([]);
      expect(run.findings).toEqual([]);
      expect(run.inbox).toEqual([]);
      expect(run.agent_sessions).toEqual([]);
    });

    it("uses the caller-supplied runId and records optional metadata", async () => {
      const run = await startRunActivity({
        template: "simple_workflow",
        cwd: "/repo",
        runId: "simple_workflow_custom_id",
        goal: "fix the bug",
        targetSessionId: "prev_session_7"
      });
      expect(run.id).toBe("simple_workflow_custom_id");
      expect(run.goal).toBe("fix the bug");
      expect(run.target_session_id).toBe("prev_session_7");
    });
  });

  describe("collectGitFactsActivity", () => {
    it("returns a delta with populated RunFacts for a repo with changes", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "tychonic-git-facts-"));
      await execFileAsync("git", ["init"], { cwd });
      await writeFile(join(cwd, "base.ts"), "export const x = 1;\n", "utf8");
      await execFileAsync("git", ["add", "base.ts"], { cwd });
      await execFileAsync(
        "git",
        ["-c", "user.name=Tychonic Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
        { cwd }
      );
      await writeFile(join(cwd, "base.ts"), "export const x = 2;\n", "utf8");

      const result = await collectGitFactsActivity({ run: baseRun("run_facts"), cwd });
      expect(result.delta.facts?.has_changes).toBe(true);
      expect(result.delta.facts?.has_source).toBe(true);
      expect(result.delta.facts?.changed_files).toHaveLength(1);
      expect(result.delta.facts?.changed_files?.[0]?.path).toBe("base.ts");
      expect(result.delta.states).toBeUndefined();
    });
  });

  describe("createWorktreeActivity", () => {
    it("creates an isolated worktree path and reports the creation mode", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "tychonic-worktree-"));
      await execFileAsync("git", ["init"], { cwd });
      await writeFile(join(cwd, "seed.txt"), "seed\n", "utf8");
      await execFileAsync("git", ["add", "seed.txt"], { cwd });
      await execFileAsync(
        "git",
        ["-c", "user.name=Tychonic Test", "-c", "user.email=test@example.com", "commit", "-m", "seed"],
        { cwd }
      );

      const run = baseRun("run_wt_1");
      const result = await createWorktreeActivity({ run, cwd });
      expect(result.worktreePath).toBe(join(cwd, ".tychonic", "worktrees", run.id));
      expect(result.mode).toBe("git_worktree");
      const entries = await readdir(result.worktreePath);
      expect(entries).toContain("seed.txt");
    });
  });

  describe("finalizeRunActivity", () => {
    it("returns status 'failed' when any state is failed", async () => {
      const run = baseRun("run_fin_failed");
      run.states = [
        {
          id: "state_1",
          name: "lint",
          status: "failed",
          reason: "lint had errors",
          activity_attempt_ids: [],
          artifact_ids: [],
          finding_ids: [],
          started_at: "2026-01-01T00:00:00Z",
          finished_at: "2026-01-01T00:00:05Z"
        }
      ];
      const result = await finalizeRunActivity({ run });
      expect(result.delta.status).toBe("failed");
    });

    it("returns 'waiting_user' when an inbox item is open and no state failed", async () => {
      const run = baseRun("run_fin_waiting");
      run.inbox = [
        {
          id: "inbox_1",
          status: "open",
          title: "needs triage",
          detail: "something",
          action: { kind: "triage", reason: "needs attention" },
          created_at: "2026-01-01T00:00:00Z"
        }
      ];
      const result = await finalizeRunActivity({ run });
      expect(result.delta.status).toBe("waiting_user");
    });

    it("returns 'succeeded' when no state failed and no inbox item is open", async () => {
      const result = await finalizeRunActivity({ run: baseRun("run_fin_ok"), summary: "all good" });
      expect(result.delta.status).toBe("succeeded");
      expect(result.delta.summary).toBe("all good");
    });

    it("uses the latest state by NAME so a recovered retry can finalize as succeeded", async () => {
      const run = baseRun("run_fin_recovered");
      run.states = [
        {
          id: "state_1",
          name: "verify",
          status: "failed",
          reason: "first verify failed",
          activity_attempt_ids: [],
          artifact_ids: [],
          finding_ids: [],
          started_at: "2026-01-01T00:00:00Z",
          finished_at: "2026-01-01T00:00:05Z"
        },
        {
          id: "state_2",
          name: "verify",
          status: "succeeded",
          reason: "retry verify passed",
          activity_attempt_ids: [],
          artifact_ids: [],
          finding_ids: [],
          started_at: "2026-01-01T00:01:00Z",
          finished_at: "2026-01-01T00:01:05Z"
        }
      ];
      const result = await finalizeRunActivity({ run });
      expect(result.delta.status).toBe("succeeded");
    });
  });
});

function baseRun(id: string): WorkflowRunRecord {
  return {
    schema_version: "tychonic.run.v1",
    id,
    template: "checkpoint",
    status: "running",
    cwd: "/ignored",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    states: [],
    activity_attempts: [],
    agent_sessions: [],
    artifacts: [],
    findings: [],
    inbox: []
  };
}
