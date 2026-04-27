import type {
  ActivityAttemptRecord,
  AgentSessionRecord,
  ArtifactRecord,
  DecisionInboxItemRecord,
  WorkflowRunRecord,
  WorkflowRunStatus
} from "../domain/types.js";
import { RunArtifactStore } from "../storage/runArtifactStore.js";

export interface TychonicWorkflowResult {
  runId: string;
  status: WorkflowRunStatus;
  run: WorkflowRunRecord;
  artifactRoot?: string;
  summary?: string;
  worktreePath?: string;
}

export interface WorkflowResultView {
  run_id: string;
  template: string;
  status: string;
  goal?: string;
}

export function assertTychonicWorkflowResult(result: unknown): asserts result is TychonicWorkflowResult {
  if (isTychonicWorkflowResult(result)) {
    return;
  }
  throw new Error("Temporal workflow result does not expose Tychonic run metadata");
}

export function workflowResultView(result: TychonicWorkflowResult): WorkflowResultView {
  return {
    run_id: result.run.id,
    template: result.run.template,
    status: result.run.status,
    ...(result.run.goal ? { goal: result.run.goal } : {})
  };
}

export function listArtifacts(result: TychonicWorkflowResult): ArtifactRecord[] {
  return result.run.artifacts;
}

export function findArtifact(result: TychonicWorkflowResult, artifactId: string): ArtifactRecord {
  const artifact = result.run.artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) {
    throw new Error(`artifact not found: ${artifactId}`);
  }
  return artifact;
}

export function artifactContentPath(result: TychonicWorkflowResult, artifactId: string): string {
  findArtifact(result, artifactId);
  return artifactStore(result.run).artifactPath(result.run, artifactId);
}

export function listLiveOutputAttempts(result: TychonicWorkflowResult): ActivityAttemptRecord[] {
  return result.run.activity_attempts.filter((attempt) => attempt.live_output_path);
}

export function liveOutputContentPath(result: TychonicWorkflowResult, attemptId: string): string {
  return artifactStore(result.run).liveOutputPath(result.run, attemptId);
}

export function listInboxItems(result: TychonicWorkflowResult): DecisionInboxItemRecord[] {
  return result.run.inbox;
}

export function listAgentSessions(result: TychonicWorkflowResult, limit: number): AgentSessionRecord[] {
  return result.run.agent_sessions.slice(0, limit);
}

function artifactStore(run: WorkflowRunRecord): RunArtifactStore {
  return new RunArtifactStore(`${run.cwd}/.tychonic`);
}

function isTychonicWorkflowResult(value: unknown): value is TychonicWorkflowResult {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.runId === "string" &&
    typeof value.status === "string" &&
    isWorkflowRunRecord(value.run)
  );
}

function isWorkflowRunRecord(value: unknown): value is WorkflowRunRecord {
  if (!isObject(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.template === "string" &&
    typeof value.status === "string" &&
    typeof value.cwd === "string" &&
    Array.isArray(value.artifacts) &&
    Array.isArray(value.activity_attempts) &&
    Array.isArray(value.agent_sessions) &&
    Array.isArray(value.states) &&
    Array.isArray(value.inbox)
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
