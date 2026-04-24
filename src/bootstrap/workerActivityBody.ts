import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

export type WorkerBodyType = "work" | "auto_continue";

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
  resumeCommand?: string;
  attemptKind?: AttemptKind;
}

/**
 * Single-candidate / single-session worker body. Produces exactly one
 * `WorkflowStateRecord` and one `ActivityAttemptRecord`
 * (SPEC §One state per body call). Does not mutate `input.run`
 * (SPEC §File I/O vs run mutation) — files are written directly with
 * `node:fs` and records are returned through the delta / `workerOutcome`
 * for the caller to append.
 *
 * Candidate fallback, multi-iteration loops, mixed-inbox orchestration,
 * and finding/inbox routing are the caller's concern. This body runs one
 * command, captures its output as an artifact, and reports.
 *
 * Session continuity metadata is out of scope for this body. The caller
 * passes any finalized `agent`, `resumeSessionId`, and `resumeCommand`
 * explicitly.
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
    resumeCommand,
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

  // Redirect well-known toolchain caches to a per-run dir outside the
  // worktree. Many worker commands run in constrained environments
  // where the toolchain's default cache path (Go's
  // `~/Library/Caches/go-build`, Cargo's `~/.cargo`, etc.) is either
  // unavailable or undesirable; without redirection the toolchain can
  // fall back to writing inside the workspace, polluting the generated
  // worker_patch with binary cache blobs. These values only apply to
  // commands the worker activity spawns; user-invoked CLI commands are
  // unaffected.
  const workerEnv = withToolchainCacheEnv(env, run.id);
  const progress = (): void => heartbeat?.({ runId: run.id, state: state.name, attemptId: attempt.id });
  const result = await withPeriodicProgress(progress, async () =>
    await runCommand({
      command,
      cwd: executionCwd,
      timeoutMs,
      env: workerEnv,
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
    if (resumeCommand) {
      session.resume_command = resumeCommand;
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

/**
 * Build a child env that points well-known toolchain caches at a
 * per-run directory under `TMPDIR` so the toolchain does not silently
 * fall back to writing inside the isolated worktree (which would then
 * leak into the worker_patch artifact). Only variables the caller did
 * not already set are overridden — principle 4 (pass-through wins
 * over implicit magic) stays intact.
 */
function withToolchainCacheEnv(env: NodeJS.ProcessEnv, runId: string): NodeJS.ProcessEnv {
  const cacheRoot = join(tmpdir(), "tychonic-toolchain-caches", runId);
  const defaults: NodeJS.ProcessEnv = {
    // Go
    GOCACHE: join(cacheRoot, "go-build"),
    GOMODCACHE: join(cacheRoot, "go-mod"),
    // Rust / Cargo
    CARGO_HOME: join(cacheRoot, "cargo"),
    CARGO_TARGET_DIR: join(cacheRoot, "cargo-target"),
    // Python
    PYTHONDONTWRITEBYTECODE: "1",
    PIP_CACHE_DIR: join(cacheRoot, "pip"),
    // Node / JS package managers (npm/pnpm/yarn)
    NPM_CONFIG_CACHE: join(cacheRoot, "npm"),
    YARN_CACHE_FOLDER: join(cacheRoot, "yarn")
  };
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [key, value] of Object.entries(defaults)) {
    if (out[key] === undefined) {
      out[key] = value;
    }
  }
  return out;
}

function relativeToExecutionCwd(cwd: string, targetPath: string): string {
  const relativePath = relative(resolve(cwd), resolve(targetPath));
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }
  return targetPath;
}
