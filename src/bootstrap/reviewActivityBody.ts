import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  optionalStateConfig,
  resolveActivityCommand
} from "../catalog/types.js";
import type { TychonicConfig } from "../catalog/types.js";
import type {
  ActivityAttemptRecord,
  AgentSessionRecord,
  ArtifactRecord,
  WorkflowStateRecord
} from "../domain/types.js";
import { parseReviewOutput } from "../review/parse.js";
import type { ReviewActivityOutcome } from "../review/outcome.js";
import type { RunArtifactStore } from "../storage/runArtifactStore.js";
import type { ActivityInput, ActivityResult } from "../temporal/types.js";
import { runCommand, withPeriodicProgress } from "./commandRunner.js";

/**
 * Resolved reviewer invocation inputs. Callers build this from their own
 * configuration or CLI input (see `resolveNamedReviewOptions` for the
 * NAME-driven profile lookup used by checkpoint workflows).
 */
export interface ResolvedReviewOptions {
  command: string;
  agent: string;
}

export interface ReviewActivityResources {
  store: RunArtifactStore;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  nextId: (prefix: string) => string;
  heartbeat?: (details: unknown) => void;
}

export interface RunReviewActivityBodyOptions {
  input: ActivityInput<"review">;
  expectedType: "review";
  resources: ReviewActivityResources;
  reviewOptions: ResolvedReviewOptions;
  timeoutMs: number;
  stateReason: string;
}

/**
 * Single-candidate review body. Produces exactly one `WorkflowStateRecord`
 * and one `ActivityAttemptRecord` (SPEC §One state per body call). Does
 * not mutate `input.run` (SPEC §File I/O vs run mutation) — files are
 * written directly with `node:fs` and the resulting records are returned
 * through the delta and `reviewOutcome` for the caller to append.
 *
 * The caller drives candidate fallback and multi-iteration loops (SPEC
 * §Finding and inbox routing); each iteration calls this body once.
 */
export async function runReviewActivityBody(
  options: RunReviewActivityBodyOptions
): Promise<ActivityResult> {
  const { input, resources, reviewOptions, timeoutMs, stateReason } = options;
  const { store, env, now, nextId, heartbeat } = resources;
  const run = input.run;
  const prompt = input.extras.prompt as string;
  const executionCwd = input.extras.worktreePath ?? input.cwd;
  const command = reviewOptions.command;

  const stateStartedAt = now().toISOString();
  const state: WorkflowStateRecord = {
    id: nextId("state"),
    name: input.stateName,
    status: "running",
    reason: stateReason,
    activity_attempt_ids: [],
    artifact_ids: [],
    finding_ids: [],
    started_at: stateStartedAt
  };

  const attemptStartedAt = now().toISOString();
  const attempt: ActivityAttemptRecord = {
    id: nextId("attempt"),
    state_id: state.id,
    kind: "semantic_review",
    status: "running",
    reason: `execute ${input.stateName}`,
    cwd: executionCwd,
    command,
    timeout_ms: timeoutMs,
    started_at: attemptStartedAt
  };
  state.activity_attempt_ids.push(attempt.id);

  await mkdir(store.liveDir(run.id), { recursive: true });
  const liveOutputPath = join(store.liveDir(run.id), `${attempt.id}.log`);
  attempt.live_output_path = relativeToCwd(input.cwd, liveOutputPath);
  const progress = (): void => heartbeat?.({ runId: run.id, state: state.name, attemptId: attempt.id });

  const result = await withPeriodicProgress(progress, async () =>
    await runCommand({
      command,
      cwd: executionCwd,
      timeoutMs,
      env,
      liveOutputPath,
      stdin: prompt,
      onProgress: progress
    })
  );

  attempt.status = result.status;
  attempt.reason = result.status;
  if (result.exitCode !== undefined) {
    attempt.exit_code = result.exitCode;
  }
  attempt.finished_at = now().toISOString();

  if (result.status !== "succeeded") {
    state.status = result.status;
    state.reason = "reviewer command did not succeed";
    state.finished_at = now().toISOString();
    const outcome: ReviewActivityOutcome = {
      kind: "command_failed",
      status: result.status,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {})
    };
    return {
      delta: { states: [state], activityAttempts: [attempt] },
      reviewOutcome: outcome
    };
  }

  const artifactsDir = store.artifactsDir(run.id);
  await mkdir(artifactsDir, { recursive: true });
  const createdAt = now().toISOString();
  const artifacts: ArtifactRecord[] = [];

  const promptArtifact = await writeReviewArtifact({
    store,
    artifactsDir,
    id: nextId("artifact"),
    kind: `${input.stateName}_prompt`,
    attemptId: attempt.id,
    ext: "txt",
    content: prompt,
    stateId: state.id,
    createdAt
  });
  artifacts.push(promptArtifact);
  state.artifact_ids.push(promptArtifact.id);

  const outputArtifact = await writeReviewArtifact({
    store,
    artifactsDir,
    id: nextId("artifact"),
    kind: `${input.stateName}_output`,
    attemptId: attempt.id,
    ext: "txt",
    content: result.output,
    stateId: state.id,
    createdAt
  });
  artifacts.push(outputArtifact);
  state.artifact_ids.push(outputArtifact.id);

  const session: AgentSessionRecord = {
    id: `${run.id}_${nextId("session")}`,
    agent: reviewOptions.agent,
    role: "reviewer",
    cwd: executionCwd,
    status: "succeeded",
    prompt_artifact_id: promptArtifact.id,
    result_artifact_id: outputArtifact.id,
    started_at: attempt.started_at,
    ...(attempt.finished_at ? { finished_at: attempt.finished_at } : {})
  };

  attempt.agent_session_id = session.id;
  const parsed = parseReviewOutput(result.output);

  if (!parsed) {
    state.status = "blocked";
    state.reason = "reviewer output did not match tychonic.review.v1";
    state.finished_at = now().toISOString();
    const outcome: ReviewActivityOutcome = {
      kind: "unparseable",
      detail: "reviewer output did not match tychonic.review.v1",
      reviewerSessionId: session.id,
      artifacts,
      agentSessions: [session]
    };
    return {
      delta: { states: [state], activityAttempts: [attempt] },
      reviewOutcome: outcome
    };
  }

  const parsedArtifact = await writeReviewArtifact({
    store,
    artifactsDir,
    id: nextId("artifact"),
    kind: `${input.stateName}_parsed`,
    attemptId: attempt.id,
    ext: "json",
    content: `${JSON.stringify(parsed, null, 2)}\n`,
    stateId: state.id,
    createdAt
  });
  artifacts.push(parsedArtifact);
  state.artifact_ids.push(parsedArtifact.id);

  state.status = parsed.status === "fail" ? "failed" : "succeeded";
  state.reason = parsed.summary;
  state.finished_at = now().toISOString();

  const outcome: ReviewActivityOutcome = {
    kind: "parsed",
    result: parsed,
    reviewerSessionId: session.id,
    artifacts,
    agentSessions: [session]
  };
  return {
    delta: { states: [state], activityAttempts: [attempt] },
    reviewOutcome: outcome
  };
}

/**
 * NAME-driven review options lookup. Used by callers that resolve the
 * reviewer command from `profile.states[name]`. Returns `undefined`
 * when the activity block is missing or the command is absent.
 */
export async function resolveNamedReviewOptions(options: {
  profile: TychonicConfig | undefined;
  name: string;
  expectedType: "review";
  env: NodeJS.ProcessEnv;
}): Promise<ResolvedReviewOptions | undefined> {
  const review = optionalStateConfig(options.profile, options.name, options.expectedType);
  if (!review) {
    return undefined;
  }

  const agentCommand = resolveActivityCommand(review);
  const command = review.command ?? agentCommand?.command;
  if (!command) {
    return undefined;
  }

  return {
    command,
    agent: review.agent ?? "review"
  };
}

async function writeReviewArtifact(input: {
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

function relativeToCwd(cwd: string, targetPath: string): string {
  const relativePath = relative(resolve(cwd), resolve(targetPath));
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }
  return targetPath;
}
