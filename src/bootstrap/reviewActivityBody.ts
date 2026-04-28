import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  optionalStateConfig
} from "../catalog/types.js";
import type { TychonicConfig } from "../catalog/types.js";
import { getAgentAdapter } from "../adapters/index.js";
import type { AdapterDispatch } from "../adapters/resolveAdapter.js";
import type { BuiltInAgentName } from "../adapters/types.js";
import type {
  ActivityAttemptRecord,
  AgentSessionRecord,
  ArtifactRecord,
  WorkflowStateRecord
} from "../domain/types.js";
import { resolveCommand } from "../adapters/resolveAdapter.js";
import { parseBuiltInReviewOutput, parseReviewOutput } from "../review/parse.js";
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
  adapterDispatch?: AdapterDispatch;
  normalizerAgent?: Extract<BuiltInAgentName, "claude" | "codex">;
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
 * Single review body. Produces exactly one `WorkflowStateRecord`
 * and one `ActivityAttemptRecord` (SPEC §Activity Result And Evidence
 * Invariants). Does not mutate `input.run` — files are written directly
 * with `node:fs` and the resulting records are returned through the delta
 * and `reviewOutcome` for the caller to append.
 *
 * The caller drives multi-iteration loops; each iteration calls this body once.
 */
export async function runReviewActivityBody(
  options: RunReviewActivityBodyOptions
): Promise<ActivityResult> {
  const { input, resources, reviewOptions, timeoutMs, stateReason } = options;
  const { store, env, now, nextId, heartbeat } = resources;
  const run = input.run;
  const prompt = input.prompt as string;
  const executionCwd = input.worktreePath ?? input.cwd;
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

  const syntheticSessionId = `${run.id}_${nextId("session")}`;
  const parsedSessionId = reviewOptions.adapterDispatch?.adapter.parseResult(
    result.output,
    "",
    result.exitCode ?? 0
  ).sessionId;
  const session: AgentSessionRecord = {
    id: parsedSessionId ?? syntheticSessionId,
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
  let outputToParse = result.output;
  let parseBuiltInEnvelope = reviewOptions.adapterDispatch !== undefined;
  const agentSessions: AgentSessionRecord[] = [session];

  if (reviewOptions.normalizerAgent !== undefined) {
    const normalized = await runReviewNormalizer({
      normalizerAgent: reviewOptions.normalizerAgent,
      primaryAgent: reviewOptions.agent,
      primaryOutput: result.output,
      executionCwd,
      timeoutMs,
      env,
      heartbeat: progress,
      store,
      artifactsDir,
      attemptId: attempt.id,
      stateId: state.id,
      stateName: input.stateName,
      createdAt,
      now,
      nextId
    });
    artifacts.push(...normalized.artifacts);
    state.artifact_ids.push(...normalized.artifacts.map((artifact) => artifact.id));
    if (normalized.session) {
      agentSessions.push(normalized.session);
    }
    if (normalized.result.status !== "succeeded") {
      attempt.status = normalized.result.status;
      attempt.reason = "review normalizer command did not succeed";
      if (normalized.result.exitCode !== undefined) {
        attempt.exit_code = normalized.result.exitCode;
      }
      state.status = "blocked";
      state.reason = "review normalizer command did not succeed";
      state.finished_at = now().toISOString();
      const outcome: ReviewActivityOutcome = {
        kind: "unparseable",
        detail: "review normalizer command did not succeed",
        reviewerSessionId: session.id,
        artifacts,
        agentSessions
      };
      return {
        delta: { states: [state], activityAttempts: [attempt] },
        reviewOutcome: outcome
      };
    }
    outputToParse = normalized.result.output;
    parseBuiltInEnvelope = true;
  }

  const parsed = parseBuiltInEnvelope
    ? parseBuiltInReviewOutput(outputToParse)
    : parseReviewOutput(outputToParse);

  if (!parsed) {
    state.status = "blocked";
    state.reason = "reviewer output did not match tychonic.review.v1";
    state.finished_at = now().toISOString();
    const outcome: ReviewActivityOutcome = {
      kind: "unparseable",
      detail: "reviewer output did not match tychonic.review.v1",
      reviewerSessionId: session.id,
      artifacts,
      agentSessions
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
    agentSessions
  };
  return {
    delta: { states: [state], activityAttempts: [attempt] },
    reviewOutcome: outcome
  };
}

/**
 * NAME-driven review options lookup. Used by callers that resolve reviewer
 * execution from `profile.states[name]`. The validated state block declares
 * exactly one execution selector: `command` for verbatim command, or `agent`
 * for built-in adapter dispatch.
 *
 * The reviewer never resumes a previous session, so `runResume` does
 * not enter the picture here.
 */
export async function resolveNamedReviewOptions(options: {
  profile: TychonicConfig | undefined;
  name: string;
  expectedType: "review";
  env: NodeJS.ProcessEnv;
  worktreeCwd: string;
  prompt: string;
}): Promise<ResolvedReviewOptions | undefined> {
  const review = optionalStateConfig(options.profile, options.name, options.expectedType);
  if (!review) {
    return undefined;
  }

  const resolved = resolveCommand({
    block: review,
    worktreeCwd: options.worktreeCwd,
    prompt: options.prompt,
    role: "review"
  });
  if (!resolved) {
    return undefined;
  }

  const agentLabel =
    resolved.kind === "adapter"
      ? resolved.agentName
      : review.agent ?? resolved.agentLabel ?? "review";
  return {
    command: resolved.command,
    agent: agentLabel,
    ...(review.normalizer ? { normalizerAgent: review.normalizer } : {}),
    ...(resolved.kind === "adapter" ? { adapterDispatch: resolved } : {})
  };
}

async function runReviewNormalizer(input: {
  normalizerAgent: Extract<BuiltInAgentName, "claude" | "codex">;
  primaryAgent: string;
  primaryOutput: string;
  executionCwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  heartbeat: () => void;
  store: RunArtifactStore;
  artifactsDir: string;
  attemptId: string;
  stateId: string;
  stateName: string;
  createdAt: string;
  now: () => Date;
  nextId: (prefix: string) => string;
}): Promise<{
  result: Awaited<ReturnType<typeof runCommand>>;
  artifacts: ArtifactRecord[];
  session?: AgentSessionRecord;
}> {
  const normalizerPrompt = buildReviewNormalizerPrompt({
    primaryAgent: input.primaryAgent,
    primaryOutput: input.primaryOutput
  });
  const adapter = getAgentAdapter(input.normalizerAgent);
  const normalizerCwd = await mkdtemp(join(tmpdir(), "tychonic-review-normalizer-"));
  try {
    const command = adapter.runNew({
      prompt: normalizerPrompt,
      worktreeCwd: normalizerCwd,
      role: "review"
    }).command;

    const artifacts: ArtifactRecord[] = [];
    const promptArtifact = await writeReviewArtifact({
      store: input.store,
      artifactsDir: input.artifactsDir,
      id: input.nextId("artifact"),
      kind: `${input.stateName}_normalizer_prompt`,
      attemptId: input.attemptId,
      ext: "txt",
      content: normalizerPrompt,
      stateId: input.stateId,
      createdAt: input.createdAt
    });
    artifacts.push(promptArtifact);

    const result = await withPeriodicProgress(input.heartbeat, async () =>
      await runCommand({
        command,
        cwd: normalizerCwd,
        timeoutMs: input.timeoutMs,
        env: input.env,
        stdin: normalizerPrompt,
        onProgress: input.heartbeat
      })
    );

    const outputArtifact = await writeReviewArtifact({
      store: input.store,
      artifactsDir: input.artifactsDir,
      id: input.nextId("artifact"),
      kind: `${input.stateName}_normalizer_output`,
      attemptId: input.attemptId,
      ext: "txt",
      content: result.output,
      stateId: input.stateId,
      createdAt: input.createdAt
    });
    artifacts.push(outputArtifact);

    const parsedSessionId = adapter.parseResult(result.output, "", result.exitCode ?? 0).sessionId;
    const session = parsedSessionId
      ? {
          id: parsedSessionId,
          agent: input.normalizerAgent,
          role: "reviewer" as const,
          cwd: normalizerCwd,
          status: result.status,
          prompt_artifact_id: promptArtifact.id,
          result_artifact_id: outputArtifact.id,
          started_at: input.createdAt,
          finished_at: input.now().toISOString()
        }
      : undefined;

    return { result, artifacts, ...(session ? { session } : {}) };
  } finally {
    await rm(normalizerCwd, { recursive: true, force: true });
  }
}

function buildReviewNormalizerPrompt(input: {
  primaryAgent: string;
  primaryOutput: string;
}): string {
  return [
    "You are a Tychonic review normalizer.",
    "Convert the primary review output into the semantic review payload only.",
    "Return JSON with exactly: status, summary, findings.",
    "Do not add schema_version; the host owns that field.",
    "Do not invent findings that are not present in the primary review output.",
    "If the primary output says the work passes, return status pass and findings [].",
    "If the primary output identifies concrete problems, return status fail and those findings.",
    "",
    `Primary reviewer: ${input.primaryAgent}`,
    "",
    "Primary review output:",
    input.primaryOutput
  ].join("\n");
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
