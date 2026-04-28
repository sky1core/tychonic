export type WorkflowRunStatus =
  | "created"
  | "running"
  | "waiting_user"
  | "blocked"
  | "failed"
  | "succeeded"
  | "cancelled";

export type WorkflowStateStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "blocked"
  | "timed_out";

export type FindingStatus =
  | "new"
  | "confirmed"
  | "auto_fix_candidate"
  | "needs_decision"
  | "deferred"
  | "accepted"
  | "rejected"
  | "fixed";

export type AttemptKind =
  | "classify_diff"
  | "deterministic_command"
  | "semantic_review"
  | "work"
  | "resume_work";

export interface ArtifactRecord {
  id: string;
  kind: string;
  path: string;
  created_at: string;
  state_id?: string;
  activity_attempt_id?: string;
}

export interface WorkflowStateRecord {
  id: string;
  name: string;
  status: WorkflowStateStatus;
  reason: string;
  policy_source?: string;
  activity_attempt_ids: string[];
  artifact_ids: string[];
  finding_ids: string[];
  started_at?: string;
  finished_at?: string;
}

export interface ActivityAttemptRecord {
  id: string;
  state_id: string;
  kind: AttemptKind;
  status: WorkflowStateStatus;
  reason: string;
  command?: string;
  cwd: string;
  live_output_path?: string;
  exit_code?: number;
  error?: string;
  timeout_ms?: number;
  agent_session_id?: string;
  started_at: string;
  finished_at?: string;
}

export interface AgentSessionRecord {
  id: string;
  agent: string;
  role: "worker" | "reviewer" | "verifier";
  resumable?: boolean;
  cwd: string;
  status: "running" | "succeeded" | "failed" | "timed_out" | "unknown";
  prompt_artifact_id?: string;
  transcript_artifact_id?: string;
  result_artifact_id?: string;
  diff_artifact_id?: string;
  started_at: string;
  finished_at?: string;
}

export interface FindingRecord {
  id: string;
  status: FindingStatus;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  detail: string;
  target?: string;
  source_state_id: string;
  source_review_session_id?: string;
  target_work_session_id?: string;
  created_at: string;
}

export interface DecisionInboxItemRecord {
  id: string;
  status: "open" | "resolved" | "dismissed";
  title: string;
  detail: string;
  finding_id?: string;
  target_session_id?: string;
  action:
    | { kind: "resume_work"; prompt_artifact_id: string }
    | { kind: "run_command"; command: string }
    | { kind: "triage"; reason: string }
    | { kind: "manual_approval"; reason: string };
  created_at: string;
}

export interface WorkflowRunRecord {
  schema_version: "tychonic.run.v1";
  id: string;
  template: string;
  status: WorkflowRunStatus;
  goal?: string;
  cwd: string;
  summary?: string;
  facts?: unknown;
  profile_snapshot_artifact_id?: string;
  created_at: string;
  updated_at: string;
  states: WorkflowStateRecord[];
  activity_attempts: ActivityAttemptRecord[];
  agent_sessions: AgentSessionRecord[];
  artifacts: ArtifactRecord[];
  findings: FindingRecord[];
  inbox: DecisionInboxItemRecord[];
}
