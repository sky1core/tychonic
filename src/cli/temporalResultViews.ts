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
  state_name?: string;
  kind: string;
  status: string;
  reason: string;
  exit_code?: number;
  started_at: string;
  finished_at?: string;
  duration_ms?: number;
  read_command: string;
}

export interface WorkflowTimingByKindView {
  kind: string;
  count: number;
  duration_ms: number;
}

export interface WorkflowAttemptTimingView {
  id: string;
  state_id: string;
  state_name?: string;
  kind: ActivityAttemptRecord["kind"];
  status: ActivityAttemptRecord["status"];
  duration_ms: number;
}

export interface WorkflowTimingView {
  run_ms?: number;
  activity_ms: number;
  non_activity_ms?: number;
  activity_count: number;
  by_kind: WorkflowTimingByKindView[];
  slowest_attempts: WorkflowAttemptTimingView[];
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
  timing: WorkflowTimingView;
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
  const stateNameById = stateNameMap(result.run);
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
    logs: logs.map((attempt) => liveOutputAttemptView(attempt, stateNameById, workflowId, runId)),
    sessions: result.run.agent_sessions,
    findings: result.run.findings,
    timing: workflowTimingView(result)
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

export function listLiveOutputAttemptViews(
  result: TychonicWorkflowResult,
  workflowId: string,
  runId?: string
): WorkflowLogEvidenceView[] {
  const stateNameById = stateNameMap(result.run);
  return listLiveOutputAttempts(result).map((attempt) =>
    liveOutputAttemptView(attempt, stateNameById, workflowId, runId)
  );
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

export function workflowTimingView(result: TychonicWorkflowResult): WorkflowTimingView {
  const stateNameById = stateNameMap(result.run);
  const attemptTimings = result.run.activity_attempts
    .map((attempt) => {
      const durationMs = elapsedMs(attempt.started_at, attempt.finished_at);
      if (durationMs === undefined) return undefined;
      const stateName = stateNameById.get(attempt.state_id);
      return {
        id: attempt.id,
        state_id: attempt.state_id,
        ...(stateName ? { state_name: stateName } : {}),
        kind: attempt.kind,
        status: attempt.status,
        duration_ms: durationMs
      } satisfies WorkflowAttemptTimingView;
    })
    .filter((attempt): attempt is WorkflowAttemptTimingView => attempt !== undefined);

  const activityMs = attemptTimings.reduce((sum, attempt) => sum + attempt.duration_ms, 0);
  const runMs = workflowObservedElapsedMs(result.run);
  const byKind = Array.from(
    attemptTimings.reduce((map, attempt) => {
      const current = map.get(attempt.kind) ?? { kind: attempt.kind, count: 0, duration_ms: 0 };
      current.count += 1;
      current.duration_ms += attempt.duration_ms;
      map.set(attempt.kind, current);
      return map;
    }, new Map<string, WorkflowTimingByKindView>()).values()
  ).sort((a, b) => b.duration_ms - a.duration_ms);

  return {
    ...(runMs !== undefined ? { run_ms: runMs } : {}),
    activity_ms: activityMs,
    ...(runMs !== undefined ? { non_activity_ms: Math.max(0, runMs - activityMs) } : {}),
    activity_count: attemptTimings.length,
    by_kind: byKind,
    slowest_attempts: [...attemptTimings].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 5)
  };
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

function liveOutputAttemptView(
  attempt: ActivityAttemptRecord,
  stateNameById: Map<string, string>,
  workflowId: string,
  runId?: string
): WorkflowLogEvidenceView {
  const durationMs = elapsedMs(attempt.started_at, attempt.finished_at);
  const stateName = stateNameById.get(attempt.state_id);
  return {
    id: attempt.id,
    state_id: attempt.state_id,
    ...(stateName ? { state_name: stateName } : {}),
    kind: attempt.kind,
    status: attempt.status,
    reason: attempt.reason,
    ...(attempt.exit_code !== undefined ? { exit_code: attempt.exit_code } : {}),
    started_at: attempt.started_at,
    ...(attempt.finished_at ? { finished_at: attempt.finished_at } : {}),
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    read_command: `${evidenceCommand("logs", workflowId, runId)} --attempt ${shellArg(attempt.id)}`
  };
}

function stateNameMap(run: WorkflowRunRecord): Map<string, string> {
  return new Map(run.states.map((state) => [state.id, state.name]));
}

function elapsedMs(start: string | undefined, finish: string | undefined): number | undefined {
  if (!start || !finish) return undefined;
  const startMs = Date.parse(start);
  const finishMs = Date.parse(finish);
  if (!Number.isFinite(startMs) || !Number.isFinite(finishMs) || finishMs < startMs) {
    return undefined;
  }
  return finishMs - startMs;
}

function workflowObservedElapsedMs(run: WorkflowRunRecord): number | undefined {
  const startMs = Date.parse(run.created_at);
  if (!Number.isFinite(startMs)) return undefined;

  const candidates = [
    run.updated_at,
    ...run.states.flatMap((state) => [state.started_at, state.finished_at]),
    ...run.activity_attempts.flatMap((attempt) => [attempt.started_at, attempt.finished_at])
  ]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  const latestMs = Math.max(startMs, ...candidates);
  if (latestMs < startMs) return undefined;
  return latestMs - startMs;
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
