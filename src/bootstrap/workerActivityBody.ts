import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  ActivityAttemptRecord,
  AttemptKind,
  AgentSessionRecord,
  ArtifactRecord,
  WorkflowStateRecord
} from "../domain/types.js";
import type { RunArtifactStore } from "../storage/runArtifactStore.js";
import type { ActivityInput, ActivityResult } from "../temporal/types.js";
import type { WorkerActivityOutcome } from "../worker/outcome.js";
import { runCommand, withPeriodicProgress } from "./commandRunner.js";

export type WorkerBodyType = "work";

export interface WorkerActivityResources {
  store: RunArtifactStore;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  nextId: (prefix: string) => string;
  heartbeat?: (details: unknown) => void;
  signal?: AbortSignal;
}

export interface RunWorkerActivityBodyOptions<T extends WorkerBodyType> {
  input: ActivityInput<T>;
  expectedType: T;
  resources: WorkerActivityResources;
  command: string;
  timeoutMs: number;
  executionCwd: string;
  prompt: string;
  agent: string;
  stateReason: string;
  /**
   * Set to an existing `AgentSessionRecord.id` when the body is running a
   * resume path. The body copies that id onto the attempt, returns it as
   * `workerOutcome.resumedSessionId`, and does NOT register a fresh
   * session. For fresh work leave this undefined; the body builds a new
   * `AgentSessionRecord` and returns it in `agentSessions`.
   */
  resumeSessionId?: string;
  attemptKind?: AttemptKind;
}

/**
 * Single worker-session body. Produces exactly one
 * `WorkflowStateRecord` and one `ActivityAttemptRecord` (SPEC §Activity
 * Result And Evidence Invariants). Does not mutate `input.run` — files are
 * written directly with `node:fs` and records are returned through the
 * delta / `workerOutcome` for the caller to append.
 *
 * Multi-iteration loops, mixed-inbox orchestration, and finding/inbox routing
 * are the caller's concern. This body runs one command, captures its output as
 * an artifact, and reports.
 *
 * Session continuity metadata is out of scope for this body. The caller
 * passes any finalized `agent` and `resumeSessionId` explicitly.
 */
export async function runWorkerActivityBody<T extends WorkerBodyType>(
  options: RunWorkerActivityBodyOptions<T>
): Promise<ActivityResult> {
  const {
    input,
    resources,
    command,
    timeoutMs,
    executionCwd,
    prompt,
    agent,
    stateReason,
    resumeSessionId,
    attemptKind
  } = options;
  const { store, env, now, nextId, heartbeat, signal } = resources;
  const { run, stateName } = input;

  const stateStartedAt = now().toISOString();
  const state: WorkflowStateRecord = {
    id: nextId("state"),
    name: stateName,
    status: "running",
    reason: stateReason,
    activity_attempt_ids: [],
    artifact_ids: [],
    finding_ids: [],
    started_at: stateStartedAt
  };

  const attempt: ActivityAttemptRecord = {
    id: nextId("attempt"),
    state_id: state.id,
    kind: attemptKind ?? "work",
    status: "running",
    reason: `execute ${stateName}`,
    cwd: executionCwd,
    command,
    timeout_ms: timeoutMs,
    started_at: now().toISOString()
  };
  if (resumeSessionId) {
    attempt.agent_session_id = resumeSessionId;
  }
  state.activity_attempt_ids.push(attempt.id);

  await mkdir(store.liveDir(run.id), { recursive: true });
  const liveOutputPath = join(store.liveDir(run.id), `${attempt.id}.log`);
  attempt.live_output_path = relativeToExecutionCwd(executionCwd, liveOutputPath);

  const artifactsDir = store.artifactsDir(run.id);
  await mkdir(artifactsDir, { recursive: true });

  const artifacts: ArtifactRecord[] = [];
  if (prompt.length > 0) {
    const promptArtifact = await writeWorkerArtifact({
      store,
      artifactsDir,
      id: nextId("artifact"),
      kind: `${stateName}_prompt`,
      attemptId: attempt.id,
      ext: "txt",
      content: prompt,
      stateId: state.id,
      createdAt: now().toISOString()
    });
    artifacts.push(promptArtifact);
    state.artifact_ids.push(promptArtifact.id);
  }

  const progress = (): void => heartbeat?.({ runId: run.id, state: state.name, attemptId: attempt.id });
  const result = await withPeriodicProgress(progress, async () =>
    await runCommand({
      command,
      cwd: executionCwd,
      timeoutMs,
      env,
      liveOutputPath,
      stdin: prompt,
      onProgress: progress,
      ...(signal ? { signal } : {})
    })
  );
  if (result.exitCode !== undefined) {
    attempt.exit_code = result.exitCode;
  }
  attempt.status = result.status;
  attempt.reason = result.status;
  attempt.finished_at = now().toISOString();

  const outputArtifact = await writeWorkerArtifact({
    store,
    artifactsDir,
    id: nextId("artifact"),
    kind: `${stateName}_output`,
    attemptId: attempt.id,
    ext: "txt",
    content: result.output,
    stateId: state.id,
    createdAt: now().toISOString()
  });
  artifacts.push(outputArtifact);
  state.artifact_ids.push(outputArtifact.id);

  const agentSessions: AgentSessionRecord[] = [];
  if (!resumeSessionId) {
    const session: AgentSessionRecord = {
      id: `${run.id}_${nextId("session")}`,
      agent,
      role: "worker",
      cwd: executionCwd,
      status:
        result.status === "succeeded"
          ? "succeeded"
          : result.status === "timed_out"
            ? "timed_out"
            : "failed",
      result_artifact_id: outputArtifact.id,
      started_at: attempt.started_at
    };
    if (prompt.length > 0 && artifacts[0]) {
      session.prompt_artifact_id = artifacts[0].id;
    }
    if (attempt.finished_at) {
      session.finished_at = attempt.finished_at;
    }
    attempt.agent_session_id = session.id;
    agentSessions.push(session);
  }

  state.status = result.status;
  state.reason = result.status;
  state.finished_at = now().toISOString();

  const workerOutcome: WorkerActivityOutcome = {
    kind: "executed",
    status: result.status,
    artifacts,
    agentSessions,
    rawStdout: result.output,
    ...(resumeSessionId ? { resumedSessionId: resumeSessionId } : {})
  };

  return {
    delta: { states: [state], activityAttempts: [attempt] },
    workerOutcome
  };
}

async function writeWorkerArtifact(input: {
  store: RunArtifactStore;
  artifactsDir: string;
  id: string;
  kind: string;
  attemptId: string;
  ext: string;
  content: string;
  stateId: string;
  createdAt: string;
}): Promise<ArtifactRecord> {
  const filename = `${input.kind}-${input.attemptId}.${input.ext}`;
  const filePath = join(input.artifactsDir, filename);
  await writeFile(filePath, input.content, "utf8");
  return {
    id: input.id,
    kind: input.kind,
    path: relative(dirname(input.store.rootDir), filePath),
    created_at: input.createdAt,
    state_id: input.stateId,
    activity_attempt_id: input.attemptId
  };
}

function relativeToExecutionCwd(cwd: string, targetPath: string): string {
  const relativePath = relative(resolve(cwd), resolve(targetPath));
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }
  return targetPath;
}
