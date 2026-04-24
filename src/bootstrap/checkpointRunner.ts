import { isAbsolute, join, relative, resolve } from "node:path";
import {
  activityTimeoutMs,
  defaultActivityTimeoutMs,
  optionalStateConfig
} from "../catalog/types.js";
import type { TychonicConfig } from "../catalog/types.js";
import { loadProfile } from "../catalog/loadProfile.js";
import type {
  ActivityAttemptRecord,
  WorkflowRunRecord,
  WorkflowStateRecord,
  WorkflowStateStatus
} from "../domain/types.js";
import { changedFilesJSON, collectGitFacts, type RunFacts } from "../facts/gitFacts.js";
import type { ReviewFinding } from "../review/schema.js";
import { RunArtifactStore } from "../storage/runArtifactStore.js";
import {
  appendInboxForActionableSkippedReviews,
  integrationPosition
} from "../workflows/checkpointPure.js";
import { appendReviewFindingsToRun } from "../workflows/resumeLoop.js";
import { runCommand } from "./commandRunner.js";
import {
  resolveNamedReviewOptions,
  runReviewActivityBody
} from "./reviewActivityBody.js";

export interface CheckpointRunnerOptions {
  cwd: string;
  profilePath?: string;
  profile?: TychonicConfig;
  goal?: string;
  targetSessionId?: string;
  autonomy?: "observe" | "check" | "review";
  commandTimeoutMs?: number;
  runId?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  heartbeat?: (details: unknown) => void;
}

export interface CheckpointRunnerResult {
  run: WorkflowRunRecord;
}

interface RunnerContext {
  store: RunArtifactStore;
  run: WorkflowRunRecord;
  cwd: string;
  profile: TychonicConfig;
  commandTimeoutMs?: number;
  env: NodeJS.ProcessEnv;
  autonomy: "observe" | "check" | "review";
  now: () => Date;
  nextId: (prefix: string) => string;
  heartbeat?: (details: unknown) => void;
}

export async function runCheckpoint(options: CheckpointRunnerOptions): Promise<CheckpointRunnerResult> {
  const now = options.now ?? (() => new Date());
  const runId = options.runId ?? createRunId(now());
  const profile = options.profile ?? (options.profilePath ? await loadProfile(options.profilePath) : undefined);
  if (!profile) {
    throw new Error("checkpoint profile is required");
  }
  const createdAt = now().toISOString();
  const store = new RunArtifactStore(join(options.cwd, ".tychonic"));
  let idCounter = 0;
  const nextId = (prefix: string): string => `${prefix}_${++idCounter}`;

  const run: WorkflowRunRecord = {
    schema_version: "tychonic.run.v1",
    id: runId,
    template: "checkpoint",
    status: "created",
    ...(options.goal ? { goal: options.goal } : {}),
    ...(options.targetSessionId ? { target_session_id: options.targetSessionId } : {}),
    cwd: options.cwd,
    created_at: createdAt,
    updated_at: createdAt,
    states: [],
    activity_attempts: [],
    agent_sessions: [],
    artifacts: [],
    findings: [],
    inbox: []
  };

  await store.initializeRunArtifacts(run);

  const context: RunnerContext = {
    store,
    run,
    cwd: options.cwd,
    profile,
    ...(options.commandTimeoutMs !== undefined ? { commandTimeoutMs: options.commandTimeoutMs } : {}),
    env: options.env ?? process.env,
    autonomy: options.autonomy ?? "check",
    now,
    nextId,
    ...(options.heartbeat ? { heartbeat: options.heartbeat } : {})
  };

  await writeProfileSnapshot(context);

  run.status = "running";
  run.updated_at = now().toISOString();

  await classifyDiff(context);
  await runConfiguredCommand(context, "lint", optionalStateConfig(profile, "lint", "lint")?.command);
  await runConfiguredCommand(context, "unit_test", optionalStateConfig(profile, "unit_test", "unit_test")?.command);
  const integrationAt = integrationPosition(profile);
  if (integrationAt === "before_ai_review") {
    await handleIntegration(context);
  }
  await runSemanticReview(context);
  if (integrationAt === "after_ai_review") {
    await handleIntegration(context);
  }
  await runTestReview(context);
  if (integrationAt === "final_gate") {
    await handleIntegration(context);
  }
  await writeInboxState(context);

  if (run.states.some((state) => state.status === "failed" || state.status === "timed_out")) {
    run.status = "failed";
  } else if (run.inbox.length > 0) {
    run.status = "waiting_user";
  } else {
    run.status = "succeeded";
  }

  run.updated_at = now().toISOString();
  run.summary = summarizeRun(run);
  return { run };
}

async function writeProfileSnapshot(context: RunnerContext): Promise<void> {
  const state = startState(context, "profile_snapshot", "record selected profile snapshot");
  const artifacts = await context.store.writeProfileArtifacts({
    run: context.run,
    profile: context.profile,
    createdAt: context.now().toISOString(),
    nextId: context.nextId,
    stateId: state.id
  });
  state.artifact_ids.push(artifacts.snapshot.id);
  finishState(context, state, "succeeded", "profile snapshot recorded");
}

async function classifyDiff(context: RunnerContext): Promise<void> {
  const state = startState(context, "classify_diff", "collect deterministic git facts");
  try {
    const result = await collectGitFacts(context.cwd);
    context.run.facts = result.facts;
    const changedFilesArtifact = await context.store.writeArtifact({
      run: context.run,
      id: context.nextId("artifact"),
      kind: "changed_files",
      filename: "changed-files.json",
      content: changedFilesJSON(result.facts.changed_files),
      createdAt: context.now().toISOString(),
      stateId: state.id
    });
    const diffArtifact = await context.store.writeArtifact({
      run: context.run,
      id: context.nextId("artifact"),
      kind: "diff_summary",
      filename: "diff-summary.txt",
      content: result.diff_stat,
      createdAt: context.now().toISOString(),
      stateId: state.id
    });
    state.artifact_ids.push(changedFilesArtifact.id, diffArtifact.id);
    const reason =
      result.facts.changed_files.length === 0
        ? "no working tree changes detected"
        : `${result.facts.changed_files.length} changed file(s)`;
    finishState(context, state, "succeeded", reason);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const artifact = await context.store.writeArtifact({
      run: context.run,
      id: context.nextId("artifact"),
      kind: "diff_summary",
      filename: "diff-summary.txt",
      content: message,
      createdAt: context.now().toISOString(),
      stateId: state.id
    });
    state.artifact_ids.push(artifact.id);
    finishState(context, state, "failed", message);
  }
}

async function runConfiguredCommand(
  context: RunnerContext,
  stateName: "lint" | "unit_test",
  command: string | undefined
): Promise<void> {
  const state = startState(context, stateName, command ? `run ${stateName}` : `${stateName} command not configured`);
  if (context.autonomy === "observe") {
    finishState(context, state, "skipped", `autonomy ${context.autonomy} does not run deterministic commands`);
    return;
  }
  const facts = factsForRun(context.run);
  if (stateName === "unit_test" && facts.only_docs) {
    finishState(context, state, "skipped", "diff only changes docs");
    return;
  }
  if (!command) {
    finishState(context, state, "skipped", `${stateName} command is not configured`);
    return;
  }

  const timeoutMs = activityTimeoutMs(
    context.profile,
    stateName,
    context.commandTimeoutMs ?? defaultActivityTimeoutMs(stateName)
  );
  const attempt = startAttempt(context, state, "deterministic_command", `execute ${stateName}`, { command, timeoutMs });
  const liveOutputPath = join(context.store.liveDir(context.run.id), `${attempt.id}.log`);
  attempt.live_output_path = relativeToCwd(context.cwd, liveOutputPath);

  const result = await runCommand({
    command,
    cwd: context.cwd,
    timeoutMs,
    env: context.env,
    liveOutputPath,
    onProgress: () => context.heartbeat?.({ runId: context.run.id, state: state.name, attemptId: attempt.id })
  });
  finishAttempt(context, attempt, result.status, result.status, result.exitCode);

  const artifact = await context.store.writeArtifact({
    run: context.run,
    id: context.nextId("artifact"),
    kind: `${stateName}_output`,
    filename: `${stateName}-output.txt`,
    content: result.output,
    createdAt: context.now().toISOString(),
    stateId: state.id,
    activityAttemptId: attempt.id
  });
  state.artifact_ids.push(artifact.id);
  finishState(context, state, result.status, result.status);
}

async function handleIntegration(context: RunnerContext): Promise<void> {
  const state = startState(context, "integration", "evaluate integration test policy");
  if (context.autonomy === "observe") {
    finishState(context, state, "skipped", "autonomy observe does not run integration tests");
    return;
  }
  const activity = optionalStateConfig(context.profile, "integration", "integration");
  const command = activity?.command;
  const integration = context.profile.policies?.integration;

  if (!command) {
    finishState(context, state, "skipped", "integration command is not configured");
    return;
  }

  if (!integration || integration.mode === "disabled") {
    finishState(context, state, "skipped", "integration tests are disabled by policy");
    return;
  }

  if (integration.mode === "manual") {
    context.run.inbox.push({
      id: context.nextId("inbox"),
      status: "open",
      title: "Manual integration approval required",
      detail: `Integration command is configured for ${integration.position}: ${command}`,
      action: { kind: "manual_approval", reason: "integration mode is manual" },
      created_at: context.now().toISOString()
    });
    finishState(context, state, "blocked", "integration mode is manual");
    return;
  }

  const timeoutMs = activityTimeoutMs(
    context.profile,
    "integration",
    context.commandTimeoutMs ?? defaultActivityTimeoutMs("integration")
  );
  const attempt = startAttempt(context, state, "deterministic_command", "execute integration command", { command, timeoutMs });
  const liveOutputPath = join(context.store.liveDir(context.run.id), `${attempt.id}.log`);
  attempt.live_output_path = relativeToCwd(context.cwd, liveOutputPath);

  const result = await runCommand({
    command,
    cwd: context.cwd,
    timeoutMs,
    env: context.env,
    liveOutputPath,
    onProgress: () => context.heartbeat?.({ runId: context.run.id, state: state.name, attemptId: attempt.id })
  });
  finishAttempt(context, attempt, result.status, result.status, result.exitCode);

  const artifact = await context.store.writeArtifact({
    run: context.run,
    id: context.nextId("artifact"),
    kind: "integration_output",
    filename: "integration-output.txt",
    content: result.output,
    createdAt: context.now().toISOString(),
    stateId: state.id,
    activityAttemptId: attempt.id
  });
  state.artifact_ids.push(artifact.id);
  finishState(context, state, result.status, result.status);
}

async function runSemanticReview(context: RunnerContext): Promise<void> {
  if (context.autonomy === "observe") {
    recordSkippedReviewState(context, "semantic_review", "run configured structured reviewer", "autonomy observe does not run semantic review");
    return;
  }

  if (!optionalStateConfig(context.profile, "semantic_review", "review")) {
    recordSkippedReviewState(context, "semantic_review", "run configured structured reviewer", "activity 'semantic_review' is not configured");
    return;
  }

  if (failedEarlier(context.run)) {
    recordSkippedReviewState(context, "semantic_review", "run configured structured reviewer", "previous required state failed");
    return;
  }

  const facts = factsForRun(context.run);
  if (facts.only_docs || !facts.has_source) {
    recordSkippedReviewState(context, "semantic_review", "run configured structured reviewer", "no source changes requiring review");
    return;
  }

  const reviewOptions = await resolveNamedReviewOptions({
    profile: context.profile,
    name: "semantic_review",
    expectedType: "review",
    env: context.env
  });
  if (!reviewOptions) {
    recordSkippedReviewState(context, "semantic_review", "run configured structured reviewer", "review command is not configured");
    return;
  }

  const timeoutMs = activityTimeoutMs(
    context.profile,
    "semantic_review",
    context.commandTimeoutMs ?? defaultActivityTimeoutMs("review")
  );

  const result = await runReviewActivityBody({
    input: {
      stateName: "semantic_review",
      run: context.run,
      profile: context.profile,
      cwd: context.cwd,
      extras: { prompt: reviewPrompt(context.run) }
    },
    expectedType: "review",
    resources: {
      store: context.store,
      env: context.env,
      now: context.now,
      nextId: context.nextId,
      ...(context.heartbeat ? { heartbeat: context.heartbeat } : {})
    },
    reviewOptions,
    timeoutMs,
    stateReason: "run configured structured reviewer"
  });

  await applyReviewActivityResult(context, result, {
    triageTitle: "Structured review output requires triage"
  });
}

async function runTestReview(context: RunnerContext): Promise<void> {
  if (context.autonomy !== "review") {
    recordSkippedReviewState(context, "test_review", "run test-review when test files changed", `autonomy ${context.autonomy} does not run test-review`);
    return;
  }
  if (failedEarlier(context.run)) {
    recordSkippedReviewState(context, "test_review", "run test-review when test files changed", "previous required state failed");
    return;
  }

  const facts = factsForRun(context.run);
  if (!facts.tests_changed) {
    recordSkippedReviewState(context, "test_review", "run test-review when test files changed", "no test files changed");
    return;
  }

  const reviewOptions = await resolveNamedReviewOptions({
    profile: context.profile,
    name: "test_review",
    expectedType: "review",
    env: context.env
  });
  if (!reviewOptions) {
    recordSkippedReviewState(context, "test_review", "run test-review when test files changed", "activity 'test_review' is not configured");
    return;
  }

  const timeoutMs = activityTimeoutMs(
    context.profile,
    "test_review",
    context.commandTimeoutMs ?? defaultActivityTimeoutMs("review")
  );

  const result = await runReviewActivityBody({
    input: {
      stateName: "test_review",
      run: context.run,
      profile: context.profile,
      cwd: context.cwd,
      extras: {
        prompt: "Review the changed tests for behavior coverage, false confidence, and maintainability.\n"
      }
    },
    expectedType: "review",
    resources: {
      store: context.store,
      env: context.env,
      now: context.now,
      nextId: context.nextId,
      ...(context.heartbeat ? { heartbeat: context.heartbeat } : {})
    },
    reviewOptions,
    timeoutMs,
    stateReason: "run test-review when test files changed"
  });

  await applyReviewActivityResult(context, result, {
    triageTitle: "Test-review output requires triage"
  });
}

function recordSkippedReviewState(
  context: RunnerContext,
  name: string,
  initialReason: string,
  skipReason: string
): void {
  const state = startState(context, name, initialReason);
  finishState(context, state, "skipped", skipReason);
}

async function applyReviewActivityResult(
  context: RunnerContext,
  result: import("../temporal/types.js").ActivityResult,
  options: { triageTitle: string }
): Promise<void> {
  const stateFromBody = result.delta.states?.[0];
  const attemptFromBody = result.delta.activityAttempts?.[0];
  if (!stateFromBody || !attemptFromBody) {
    return;
  }
  context.run.states.push(stateFromBody);
  context.run.activity_attempts.push(attemptFromBody);
  context.run.updated_at = context.now().toISOString();

  const outcome = result.reviewOutcome;
  if (!outcome || outcome.kind === "command_failed" || outcome.kind === "skipped") {
    return;
  }

  for (const session of outcome.agentSessions) {
    context.run.agent_sessions.push(session);
  }
  for (const artifact of outcome.artifacts) {
    context.run.artifacts.push(artifact);
    if (!stateFromBody.artifact_ids.includes(artifact.id)) {
      stateFromBody.artifact_ids.push(artifact.id);
    }
  }

  if (outcome.kind === "unparseable") {
    context.run.inbox.push({
      id: context.nextId("inbox"),
      status: "open",
      title: options.triageTitle,
      detail: outcome.detail,
      action: { kind: "triage", reason: outcome.detail },
      created_at: context.now().toISOString()
    });
    return;
  }

  if (outcome.result.status !== "fail") {
    return;
  }

  const stateId = stateFromBody.id;
  await appendReviewFindingsToRun({
    run: context.run,
    sourceStateId: stateId,
    sourceReviewSessionId: outcome.reviewerSessionId,
    findings: targetFindings(outcome.result.findings, context.run.target_session_id),
    verificationCommands: configuredVerificationCommands(context.profile),
    now: context.now().toISOString(),
    nextId: context.nextId,
    writePromptArtifact: async (content) => {
      const artifact = await context.store.writeArtifact({
        run: context.run,
        id: context.nextId("artifact"),
        kind: "resume_prompt",
        filename: `${context.nextId("resume")}-prompt.txt`,
        content,
        createdAt: context.now().toISOString(),
        stateId
      });
      stateFromBody.artifact_ids.push(artifact.id);
      return artifact.id;
    }
  });
  for (const finding of context.run.findings.filter((item) => item.source_state_id === stateId)) {
    if (!stateFromBody.finding_ids.includes(finding.id)) {
      stateFromBody.finding_ids.push(finding.id);
    }
  }
}

async function writeInboxState(context: RunnerContext): Promise<void> {
  const state = startState(context, "write_inbox", "record actionable skipped steps");
  const nextRun = appendInboxForActionableSkippedReviews(context.run, context.now().toISOString());
  context.run.inbox = nextRun.inbox;
  finishState(context, state, "succeeded", `${context.run.inbox.length} inbox item(s)`);
}

function startState(context: RunnerContext, name: string, reason: string): WorkflowStateRecord {
  const now = context.now().toISOString();
  const state: WorkflowStateRecord = {
    id: context.nextId("state"),
    name,
    status: "running",
    reason,
    activity_attempt_ids: [],
    artifact_ids: [],
    finding_ids: [],
    started_at: now
  };
  context.run.states.push(state);
  return state;
}

function finishState(
  context: RunnerContext,
  state: WorkflowStateRecord,
  status: WorkflowStateStatus,
  reason: string
): void {
  state.status = status;
  state.reason = reason;
  state.finished_at = context.now().toISOString();
  context.run.updated_at = state.finished_at;
}

function startAttempt(
  context: RunnerContext,
  state: WorkflowStateRecord,
  kind: ActivityAttemptRecord["kind"],
  reason: string,
  optional: { command?: string; timeoutMs?: number; agentSessionId?: string } = {}
): ActivityAttemptRecord {
  const attempt: ActivityAttemptRecord = {
    id: context.nextId("attempt"),
    state_id: state.id,
    kind,
    status: "running",
    reason,
    cwd: context.cwd,
    started_at: context.now().toISOString(),
    ...(optional.command ? { command: optional.command } : {}),
    ...(optional.timeoutMs ? { timeout_ms: optional.timeoutMs } : {}),
    ...(optional.agentSessionId ? { agent_session_id: optional.agentSessionId } : {})
  };
  context.run.activity_attempts.push(attempt);
  state.activity_attempt_ids.push(attempt.id);
  return attempt;
}

function finishAttempt(
  context: RunnerContext,
  attempt: ActivityAttemptRecord,
  status: WorkflowStateStatus,
  reason: string,
  exitCode: number | undefined
): void {
  attempt.status = status;
  attempt.reason = reason;
  if (exitCode !== undefined) {
    attempt.exit_code = exitCode;
  }
  attempt.finished_at = context.now().toISOString();
}

function configuredVerificationCommands(profile: TychonicConfig): string[] {
  return [profile.states?.lint?.command, profile.states?.unit_test?.command].filter(
    (command): command is string => Boolean(command)
  );
}

function factsForRun(run: WorkflowRunRecord): RunFacts {
  return (run.facts as RunFacts | undefined) ?? {
    changed_files: [],
    has_changes: false,
    has_source: false,
    only_docs: false,
    tests_changed: false,
    frontend_changed: false,
    docs_changed: false
  };
}

function failedEarlier(run: WorkflowRunRecord): boolean {
  return run.states.some((state) => state.status === "failed" || state.status === "timed_out");
}

function summarizeRun(run: WorkflowRunRecord): string {
  const failed = run.states.filter((state) => state.status === "failed").length;
  const skipped = run.states.filter((state) => state.status === "skipped").length;
  return `${run.template} finished with ${failed} failed state(s), ${skipped} skipped state(s), ${run.inbox.length} inbox item(s)`;
}

function targetFindings(findings: ReviewFinding[], targetSessionId: string | undefined): ReviewFinding[] {
  if (!targetSessionId) {
    return findings;
  }
  return findings.map((finding) => ({
    ...finding,
    target_session_id: finding.target_session_id ?? targetSessionId
  }));
}

function reviewPrompt(run: WorkflowRunRecord): string {
  const facts = factsForRun(run);
  const changedFiles = facts.changed_files.length > 0
    ? facts.changed_files
        .map((file) => `- ${file.path}${file.categories.length > 0 ? ` [${file.categories.join(",")}]` : ""}`)
        .join("\n")
    : "- no changed files detected";

  return [
    "Review the current working tree changes for correctness, regressions, missing tests, and risky assumptions.",
    "",
    "Return only one JSON object matching this contract. Do not wrap it in markdown.",
    "{",
    '  "schema_version": "tychonic.review.v1",',
    '  "status": "pass|fail",',
    '  "summary": "short result summary",',
    '  "findings": [',
    '    {"severity": "critical|high|medium|low", "title": "finding title", "detail": "actionable explanation", "target": "file, state, or session", "target_session_id": "worker session id when the finding should resume prior work"}',
    "  ]",
    "}",
    "Use status pass only when findings is empty. Use status fail when any actionable finding exists.",
    "",
    "Changed files:",
    changedFiles,
    run.target_session_id ? `\nTarget worker session for continuation: ${run.target_session_id}` : "",
    ""
  ].join("\n");
}

function createRunId(now: Date): string {
  const timestamp = now.toISOString().replace(/[-:.]/g, "").replace("T", "_").replace("Z", "");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `run_${timestamp}_${suffix}`;
}

function relativeToCwd(cwd: string, targetPath: string): string {
  const relativePath = relative(resolve(cwd), resolve(targetPath));
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }
  return targetPath;
}
