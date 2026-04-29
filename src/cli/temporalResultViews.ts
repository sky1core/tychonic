import type {
  ActivityAttemptRecord,
  AgentSessionRecord,
  ArtifactRecord,
  DecisionInboxItemRecord,
  FindingRecord,
  WorkflowRunRecord,
  WorkflowStateRecord,
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

export interface WorkflowEvidenceCommandView {
  status: string;
  inbox: string;
  artifacts: string;
  logs: string;
  sessions: string;
}

export interface WorkflowArtifactEvidenceView extends ArtifactRecord {
  read_command: string;
}

export interface WorkflowLogEvidenceView {
  id: string;
  state_id: string;
  kind: string;
  status: string;
  reason: string;
  exit_code?: number;
  started_at: string;
  finished_at?: string;
  read_command: string;
}

export interface WorkflowEvidenceView {
  run_id: string;
  template: string;
  status: string;
  summary?: string;
  latest_state?: WorkflowStateRecord;
  counts: {
    states: number;
    attempts: number;
    artifacts: number;
    logs: number;
    inbox: number;
    sessions: number;
    findings: number;
  };
  commands: WorkflowEvidenceCommandView;
  inbox: DecisionInboxItemRecord[];
  artifacts: WorkflowArtifactEvidenceView[];
  logs: WorkflowLogEvidenceView[];
  sessions: AgentSessionRecord[];
  findings: FindingRecord[];
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

export function workflowEvidenceView(
  result: TychonicWorkflowResult,
  workflowId: string,
  runId?: string
): WorkflowEvidenceView {
  const logs = listLiveOutputAttempts(result);
  const states = result.run.states;
  const latestState = states.length > 0 ? states[states.length - 1] : undefined;
  return {
    run_id: result.run.id,
    template: result.run.template,
    status: result.run.status,
    ...(result.run.summary ? { summary: result.run.summary } : {}),
    ...(latestState ? { latest_state: latestState } : {}),
    counts: {
      states: result.run.states.length,
      attempts: result.run.activity_attempts.length,
      artifacts: result.run.artifacts.length,
      logs: logs.length,
      inbox: result.run.inbox.length,
      sessions: result.run.agent_sessions.length,
      findings: result.run.findings.length
    },
    commands: evidenceCommands(workflowId, runId),
    inbox: result.run.inbox,
    artifacts: result.run.artifacts.map((artifact) => ({
      ...artifact,
      read_command: `${evidenceCommand("artifacts", workflowId, runId)} --artifact ${shellArg(artifact.id)}`
    })),
    logs: logs.map((attempt) => ({
      id: attempt.id,
      state_id: attempt.state_id,
      kind: attempt.kind,
      status: attempt.status,
      reason: attempt.reason,
      ...(attempt.exit_code !== undefined ? { exit_code: attempt.exit_code } : {}),
      started_at: attempt.started_at,
      ...(attempt.finished_at ? { finished_at: attempt.finished_at } : {}),
      read_command: `${evidenceCommand("logs", workflowId, runId)} --attempt ${shellArg(attempt.id)}`
    })),
    sessions: result.run.agent_sessions,
    findings: result.run.findings
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

function evidenceCommands(workflowId: string, runId?: string): WorkflowEvidenceCommandView {
  return {
    status: `tychonic status ${workflowSelector(workflowId, runId)}`,
    inbox: evidenceCommand("inbox", workflowId, runId),
    artifacts: evidenceCommand("artifacts", workflowId, runId),
    logs: evidenceCommand("logs", workflowId, runId),
    sessions: evidenceCommand("sessions", workflowId, runId)
  };
}

function evidenceCommand(command: "inbox" | "artifacts" | "logs" | "sessions", workflowId: string, runId?: string): string {
  return `tychonic ${command} ${workflowSelector(workflowId, runId)}`;
}

function workflowSelector(workflowId: string, runId?: string): string {
  const base = `--workflow-id ${shellArg(workflowId)}`;
  return runId ? `${base} --run-id ${shellArg(runId)}` : base;
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
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
