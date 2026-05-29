import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  optionalStateConfig
} from "../catalog/types.js";
import type { TychonicConfig } from "../catalog/types.js";
import { getAgentAdapter } from "../adapters/index.js";
import { reportedModelMismatchMessage } from "../adapters/modelSelection.js";
import type { AdapterDispatch } from "../adapters/resolveAdapter.js";
import type { BuiltInAgentName } from "../adapters/types.js";
import type {
  ActivityAttemptRecord,
  AgentSessionRecord,
  ArtifactRecord,
  WorkflowStateRecord
} from "../domain/types.js";
import { FINDING_SEVERITIES } from "../domain/types.js";
import { resolveCommand } from "../adapters/resolveAdapter.js";
import {
  parseBuiltInReviewOutput,
  parseReviewOutput
} from "../review/parse.js";
import type { ReviewActivityOutcome } from "../review/outcome.js";
import type { RunArtifactStore } from "../storage/runArtifactStore.js";
import type { ActivityInput, ActivityResult } from "../temporal/types.js";
import { runCommand, sanitizeChildEnv, type CommandRunResult, withPeriodicProgress } from "./commandRunner.js";
import { throwIfCancelled } from "../activities/heartbeat.js";
import { gitChildEnv, resolveGitExecutable } from "./executables.js";

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
  executablePaths?: Readonly<Record<string, string>>;
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

const NORMALIZER_MODEL_BY_AGENT: Record<Extract<BuiltInAgentName, "claude" | "codex">, string> = {
  claude: "haiku",
  codex: "gpt-5.3-codex-spark"
};

const FINDING_SEVERITY_LIST = FINDING_SEVERITIES.join(", ");
const FINDING_SEVERITY_SHAPE = FINDING_SEVERITIES.join("|");

const execFileAsync = promisify(execFile);

const DIRECT_BUILT_IN_REVIEW_CONTRACT = [
  "",
  "Tychonic structured review output contract:",
  "- Return exactly one JSON object only. Do not write prose, markdown, headings, or explanatory text.",
  "- Top-level keys are exactly: status, summary, findings.",
  "- Do not add schema_version; the host owns that field.",
  "- findings are actionable problems only, not evidence, confirmations, or passing notes.",
  "- Use status pass only when findings is exactly [].",
  "- Use status fail when any actionable problem exists, and list those problems in findings.",
  "- Each finding requires severity, title, detail, target, and target_session_id in the structured output.",
  "- Use null for target or target_session_id when unknown; the host normalizes those nulls out."
].join("\n");

/**
 * Single review body. Produces exactly one `WorkflowStateRecord`
 * and one `ActivityAttemptRecord` (src/bootstrap/SPEC.md §Activity Bodies).
 * Does not mutate `input.run` — files are written directly
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
  const prompt = reviewPromptForExecution(input.prompt as string, reviewOptions);
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
  attempt.live_output_path = store.storedPath(run.id, liveOutputPath);

  const artifactsDir = store.artifactsDir(run.id);
  await mkdir(artifactsDir, { recursive: true });
  const artifacts: ArtifactRecord[] = [];
  const promptArtifact = await writeReviewArtifact({
    store,
    runId: run.id,
    artifactsDir,
    id: nextId("artifact"),
    kind: `${input.stateName}_prompt`,
    attemptId: attempt.id,
    ext: "txt",
    content: prompt,
    stateId: state.id,
    createdAt: now().toISOString()
  });
  artifacts.push(promptArtifact);
  state.artifact_ids.push(promptArtifact.id);

  const progress = (): void => heartbeat?.({ runId: run.id, state: state.name, attemptId: attempt.id });

  const reviewMutationBefore = await snapshotReviewMutationBoundary(executionCwd, env, "before");
  let result: CommandRunResult;
  if (!reviewMutationBefore.supported && reviewMutationBefore.reason) {
    result = {
      status: "failed" as const,
      exitCode: 1,
      output: `${reviewMutationBefore.reason}\n`,
      timedOut: false
    };
  } else {
    result = await withPeriodicProgress(
      progress,
      async () =>
        await runCommand({
          command,
          cwd: executionCwd,
          timeoutMs,
          env,
          liveOutputPath,
          outputCapture: "tail",
          stdin: prompt,
          onProgress: progress
        }),
      { onAfter: throwIfCancelled }
    );
    const reviewMutationViolation = await detectReviewMutation(reviewMutationBefore, executionCwd, env);
    if (reviewMutationViolation) {
      result = {
        ...result,
        status: "failed",
        exitCode: result.exitCode ?? 1,
        output: `${result.output}\n${reviewMutationViolation}\n`
      };
    }
  }

  attempt.status = result.status;
  attempt.reason = result.status;
  if (result.exitCode !== undefined) {
    attempt.exit_code = result.exitCode;
  }
  attempt.finished_at = now().toISOString();

  const outputArtifact = await writeReviewArtifact({
    store,
    runId: run.id,
    artifactsDir,
    id: nextId("artifact"),
    kind: `${input.stateName}_output`,
    attemptId: attempt.id,
    ext: "txt",
    content: result.output,
    stateId: state.id,
    createdAt: now().toISOString()
  });
  artifacts.push(outputArtifact);
  state.artifact_ids.push(outputArtifact.id);

  const syntheticSessionId = `${run.id}_${nextId("session")}`;
  const parsedAdapterResult = reviewOptions.adapterDispatch?.adapter.parseResult(
    result.output,
    "",
    result.exitCode ?? 0
  );
  const parsedSessionId = parsedAdapterResult?.sessionId;
  const session: AgentSessionRecord = {
    id: parsedSessionId ?? syntheticSessionId,
    agent: reviewOptions.agent,
    role: "reviewer",
    cwd: executionCwd,
    status:
      result.status === "succeeded"
        ? "succeeded"
        : result.status === "timed_out"
          ? "timed_out"
          : "failed",
    prompt_artifact_id: promptArtifact.id,
    result_artifact_id: outputArtifact.id,
    started_at: attempt.started_at,
    ...(attempt.finished_at ? { finished_at: attempt.finished_at } : {})
  };
  attempt.agent_session_id = session.id;
  const agentSessions: AgentSessionRecord[] = [session];

  const modelMismatch = reportedModelMismatchMessage({
    agentName: reviewOptions.adapterDispatch?.agentName ?? reviewOptions.agent,
    requestedModel: reviewOptions.adapterDispatch?.requestedModel,
    reportedModel: parsedAdapterResult?.reportedModel
  });
  if (result.status === "succeeded" && modelMismatch !== undefined) {
    attempt.status = "failed";
    attempt.reason = modelMismatch;
    attempt.error = modelMismatch;
    state.status = "failed";
    state.reason = modelMismatch;
    state.finished_at = now().toISOString();
    session.status = "failed";
    const outcome: ReviewActivityOutcome = {
      kind: "command_failed",
      status: "failed",
      reviewerSessionId: session.id,
      artifacts,
      agentSessions
    };
    return {
      delta: { states: [state], activityAttempts: [attempt] },
      reviewOutcome: outcome
    };
  }

  if (result.status !== "succeeded") {
    state.status = result.status;
    state.reason = reviewCommandFailureReason(result);
    state.finished_at = now().toISOString();
    const outcome: ReviewActivityOutcome = {
      kind: "command_failed",
      status: result.status,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      reason: state.reason,
      reviewerSessionId: session.id,
      artifacts,
      agentSessions
    };
    return {
      delta: { states: [state], activityAttempts: [attempt] },
      reviewOutcome: outcome
    };
  }

  let outputToParse = result.output;
  let useBuiltInReviewParser = isBuiltInStructuredReviewer(reviewOptions.adapterDispatch?.agentName);
  const createdAt = now().toISOString();

  if (reviewOptions.normalizerAgent !== undefined) {
    const normalized = await runReviewNormalizer({
      normalizerAgent: reviewOptions.normalizerAgent,
      primaryAgent: reviewOptions.agent,
      primaryOutput: result.output,
      executionCwd,
      timeoutMs,
      env,
      ...(reviewOptions.executablePaths ? { executablePaths: reviewOptions.executablePaths } : {}),
      heartbeat: progress,
      store,
      runId: run.id,
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
    useBuiltInReviewParser = true;
  }

  const parsed = useBuiltInReviewParser
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
    runId: run.id,
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

function isBuiltInStructuredReviewer(agentName: string | undefined): boolean {
  return agentName === "claude" || agentName === "codex";
}

function reviewPromptForExecution(prompt: string, reviewOptions: ResolvedReviewOptions): string {
  if (reviewOptions.adapterDispatch === undefined || reviewOptions.normalizerAgent !== undefined) {
    return prompt;
  }
  return `${prompt.trimEnd()}\n${DIRECT_BUILT_IN_REVIEW_CONTRACT}\n`;
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
  executablePaths?: Readonly<Record<string, string>>;
}): Promise<ResolvedReviewOptions | undefined> {
  const review = optionalStateConfig(options.profile, options.name, options.expectedType);
  if (!review) {
    return undefined;
  }

  const resolved = resolveCommand({
    block: review,
    worktreeCwd: options.worktreeCwd,
    prompt: options.prompt,
    role: "review",
    ...(options.executablePaths ? { executablePaths: options.executablePaths } : {})
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
    ...(options.executablePaths ? { executablePaths: options.executablePaths } : {}),
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
  executablePaths?: Readonly<Record<string, string>>;
  heartbeat: () => void;
  store: RunArtifactStore;
  runId: string;
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
      role: "review",
      model: NORMALIZER_MODEL_BY_AGENT[input.normalizerAgent],
      ...(input.executablePaths ? { executablePaths: input.executablePaths } : {})
    }).command;

    const artifacts: ArtifactRecord[] = [];
    const promptArtifact = await writeReviewArtifact({
      store: input.store,
      runId: input.runId,
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

    let result = await withPeriodicProgress(
      input.heartbeat,
      async () =>
        await runCommand({
          command,
          cwd: normalizerCwd,
          timeoutMs: input.timeoutMs,
          env: input.env,
          outputCapture: "tail",
          stdin: normalizerPrompt,
          onProgress: input.heartbeat
        }),
      { onAfter: throwIfCancelled }
    );
    const parsedAdapterResult = adapter.parseResult(result.output, "", result.exitCode ?? 0);
    const modelMismatch = reportedModelMismatchMessage({
      agentName: input.normalizerAgent,
      requestedModel: NORMALIZER_MODEL_BY_AGENT[input.normalizerAgent],
      reportedModel: parsedAdapterResult.reportedModel
    });
    if (result.status === "succeeded" && modelMismatch !== undefined) {
      result = {
        ...result,
        status: "failed",
        output: `${result.output}\n${modelMismatch}\n`
      };
    }

    const outputArtifact = await writeReviewArtifact({
      store: input.store,
      runId: input.runId,
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

    const parsedSessionId = parsedAdapterResult.sessionId;
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
    "Return one JSON object only. Do not use markdown or prose outside JSON.",
    "Top-level keys are exactly: status, summary, findings.",
    "Do not add schema_version; the host owns that field.",
    "Each finding object requires exactly these required keys: severity, title, detail, target, target_session_id.",
    `Finding severity must be one of: ${FINDING_SEVERITY_LIST}.`,
    "Use the exact key detail for the finding explanation. Do not use details.",
    "Use null for target or target_session_id unless the primary output provides a concrete value.",
    "Do not invent findings that are not present in the primary review output.",
    "If the primary output says the work passes, return status pass and findings [].",
    "If the primary output identifies concrete problems, return status fail and those findings.",
    "Shape:",
    `{"status":"pass|fail","summary":"...","findings":[{"severity":"${FINDING_SEVERITY_SHAPE}","title":"...","detail":"...","target":null,"target_session_id":null}]}`,
    "",
    `Primary reviewer: ${input.primaryAgent}`,
    "",
    "Primary review output:",
    input.primaryOutput
  ].join("\n");
}

async function writeReviewArtifact(input: {
  store: RunArtifactStore;
  runId: string;
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
    path: input.store.storedPath(input.runId, filePath),
    created_at: input.createdAt,
    state_id: input.stateId,
    activity_attempt_id: input.attemptId
  };
}

type ReviewMutationSnapshot =
  | { supported: false; reason?: string }
  | {
      supported: true;
      fingerprint: string;
    };

async function snapshotReviewMutationBoundary(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  phase: "before" | "after"
): Promise<ReviewMutationSnapshot> {
  try {
    if (!(await hasGitMetadata(cwd))) {
      return {
        supported: false,
        reason: `review mutation guard failed ${phase} reviewer command: git metadata was not found under review cwd`
      };
    }
    await assertInsideGitWorkTree(cwd, env);
    const head = await execGit(cwd, env, ["rev-parse", "HEAD"]);
    const status = await snapshotGitStatus(cwd, env);
    const staged = await snapshotStagedDiff(cwd, env);
    const tracked = await snapshotTrackedChangedFiles(cwd, env);
    const untracked = await snapshotUntrackedFiles(cwd, env);
    return { supported: true, fingerprint: JSON.stringify({ head, status, staged, tracked, untracked }) };
  } catch (error) {
    return {
      supported: false,
      reason: `review mutation guard failed ${phase} reviewer command: ${errorMessage(error)}`
    };
  }
}

async function detectReviewMutation(
  before: ReviewMutationSnapshot,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined
): Promise<string | undefined> {
  if (!before.supported) return before.reason;
  const after = await snapshotReviewMutationBoundary(cwd, env, "after");
  if (!after.supported) {
    return after.reason ?? "review mutation guard failed: git worktree became unavailable during review";
  }
  if (after.fingerprint === before.fingerprint) return undefined;
  return [
    "review mutation guard failed: review changed the git worktree.",
    "Review states may inspect files and run checks, but must not modify source files.",
    "Before:",
    before.fingerprint,
    "After:",
    after.fingerprint
  ].join("\n");
}

async function assertInsideGitWorkTree(cwd: string, env: NodeJS.ProcessEnv | undefined): Promise<void> {
  const output = await execGit(cwd, env, ["rev-parse", "--is-inside-work-tree"]);
  if (output.trim() !== "true") {
    throw new Error(`git executable did not confirm review cwd is inside a worktree: ${output.trim()}`);
  }
}

async function snapshotGitStatus(cwd: string, env: NodeJS.ProcessEnv | undefined): Promise<string> {
  return await execGit(cwd, env, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).tychonic/**"
  ]);
}

async function snapshotStagedDiff(cwd: string, env: NodeJS.ProcessEnv | undefined): Promise<string> {
  return await execGit(cwd, env, [
    "diff",
    "--cached",
    "--raw",
    "-z",
    "HEAD",
    "--",
    ".",
    ":(exclude).tychonic/**"
  ]);
}

async function snapshotTrackedChangedFiles(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined
): Promise<Array<{ path: string; kind: string; hash: string }>> {
  const output = await execGit(cwd, env, [
    "diff",
    "--name-only",
    "-z",
    "HEAD",
    "--",
    ".",
    ":(exclude).tychonic/**"
  ]);
  const paths = output.split("\0").filter((path) => path.length > 0).sort();
  return await snapshotPaths(cwd, paths);
}

async function snapshotUntrackedFiles(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined
): Promise<Array<{ path: string; kind: string; hash: string }>> {
  const output = await execGit(cwd, env, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ".",
    ":(exclude).tychonic/**"
  ]);
  const paths = output.split("\0").filter((path) => path.length > 0).sort();
  return await snapshotPaths(cwd, paths);
}

async function snapshotPaths(
  cwd: string,
  paths: string[]
): Promise<Array<{ path: string; kind: string; hash: string }>> {
  const entries: Array<{ path: string; kind: string; hash: string }> = [];
  for (const path of paths) {
    const fullPath = join(cwd, path);
    let stat;
    try {
      stat = await lstat(fullPath);
    } catch (error) {
      if (isMissingPathError(error)) {
        entries.push({ path, kind: "missing", hash: "" });
        continue;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      entries.push({
        path,
        kind: "symlink",
        hash: `${stat.mode}:${hashBuffer(Buffer.from(await readlink(fullPath)))}`
      });
      continue;
    }
    if (stat.isFile()) {
      entries.push({ path, kind: "file", hash: `${stat.mode}:${await hashFile(fullPath)}` });
      continue;
    }
    entries.push({ path, kind: "other", hash: String(stat.mode) });
  }
  return entries;
}

function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function execGit(
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  args: string[]
): Promise<string> {
  const gitPath = await resolveGitExecutable(env ?? process.env);
  const { stdout } = await execFileAsync(gitPath, ["-C", cwd, ...args], {
    env: gitChildEnv(sanitizeChildEnv(env), gitPath),
    maxBuffer: 20 * 1024 * 1024
  });
  return stdout.trimEnd();
}

function reviewCommandFailureReason(result: CommandRunResult): string {
  const guardReason = result.output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("review mutation guard failed"));
  return guardReason ?? "reviewer command did not succeed";
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR")
  );
}

async function hasGitMetadata(cwd: string): Promise<boolean> {
  let current = cwd;
  for (;;) {
    try {
      await lstat(join(current, ".git"));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
