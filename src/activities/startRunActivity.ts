import { join } from "node:path";
import type { TychonicConfig } from "../catalog/types.js";
import type { WorkflowRunRecord } from "../domain/types.js";
import { RunArtifactStore } from "../storage/runArtifactStore.js";

export interface StartRunActivityInput {
  template: string;
  cwd: string;
  profile?: TychonicConfig;
  goal?: string;
  runId?: string;
}

export type StartRunActivityResult = WorkflowRunRecord;

/**
 * Creates the initial `WorkflowRunRecord` for a workflow run. Called once
 * at workflow start by workflow code. Returns a full record rather than a
 * delta because there is no prior run to merge into.
 *
 * `run.id` is generated here if the caller did not supply one through
 * `input.runId`. The id is surfaced across the product (filesystem
 * layout, inbox references, artifact paths) per SPEC §Activity Result
 * And Evidence Invariants — the workflow threads this id through every
 * subsequent activity call.
 */
export async function startRunActivity(input: StartRunActivityInput): Promise<StartRunActivityResult> {
  const createdAt = new Date().toISOString();
  const runId = input.runId ?? defaultRunId(input.template, new Date());
  let run: WorkflowRunRecord = {
    schema_version: "tychonic.run.v1",
    id: runId,
    template: input.template,
    status: "created",
    cwd: input.cwd,
    created_at: createdAt,
    updated_at: createdAt,
    states: [],
    activity_attempts: [],
    agent_sessions: [],
    artifacts: [],
    findings: [],
    inbox: []
  };
  if (input.goal !== undefined) {
    run.goal = input.goal;
  }
  if (input.profile !== undefined) {
    const store = new RunArtifactStore(join(input.cwd, ".tychonic"));
    await store.initializeRunArtifacts(run);
    const { snapshot } = await store.writeProfileArtifacts({
      run,
      profile: input.profile,
      createdAt,
      nextId: nextIdFromRun(run)
    });
    run = {
      ...run,
      artifacts: [...run.artifacts, snapshot],
      profile_snapshot_artifact_id: snapshot.id
    };
  }
  return run;
}

function defaultRunId(template: string, now: Date): string {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  const slug = Math.random().toString(36).slice(2, 8);
  return `${template}_${yyyy}${mm}${dd}_${hh}${mi}${ss}${ms}_${slug}`;
}

function nextIdFromRun(run: WorkflowRunRecord): (prefix: string) => string {
  let counter =
    run.states.length +
    run.activity_attempts.length +
    run.artifacts.length +
    run.findings.length +
    run.inbox.length +
    run.agent_sessions.length;
  return (prefix: string): string => `${prefix}_${++counter}`;
}
