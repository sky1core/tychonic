import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  defaultActivityTimeoutMs,
  type ActivityTimeoutName,
  type ActivityTimeoutOverrides,
  type ActivityType,
  type TychonicConfig
} from "../catalog/types.js";
import type {
  ActivityAttemptRecord,
  AgentSessionRecord,
  DecisionInboxItemRecord,
  WorkflowRunRecord,
  WorkflowStateRecord,
  WorkflowStateStatus
} from "../domain/types.js";
import { recomputeWorkflowRunStatus } from "../domain/inbox.js";
import type { ReviewFinding } from "../review/schema.js";
import { assertNoInlineSecrets } from "../security/inlineSecrets.js";
import { RunArtifactStore } from "../storage/runArtifactStore.js";
import { appendReviewFindingsToRun, buildFreshWorkPrompt } from "../workflows/resumeLoop.js";
import type { AgentCandidateInput } from "../temporal/types.js";
import { runCommand } from "./commandRunner.js";
import {
  runReviewActivityBody,
  type ResolvedReviewOptions
} from "./reviewActivityBody.js";
import { createIsolatedWorktree } from "./worktree.js";

const DEFAULT_AUTO_CONTINUE_MAX_ITERATIONS = 5;

export interface SimpleWorkflowRunnerOptions {
  cwd: string;
  command?: string;
  verifyCommand: string;
  goal?: string;
  agent?: string;
  resumeCommand?: string;
  workerCandidates?: AgentCandidateInput[];
  reviewCommand?: string;
  reviewAgent?: string;
  reviewCandidates?: AgentCandidateInput[];
  autoContinue?: boolean;
  maxIterations?: number;
  commandTimeoutMs?: number;
  activityTimeouts?: ActivityTimeoutOverrides;
  profile?: TychonicConfig;
  runId?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  heartbeat?: (details: unknown) => void;
}

export interface SimpleWorkflowRunnerResult {
  run: WorkflowRunRecord;
  worktreePath: string;
}

export interface SimpleWorkflowContinuationOptions {
  cwd: string;
  run: WorkflowRunRecord;
  worktreePath: string;
  inboxItemId: string;
  command?: string;
  agent?: string;
  resumeCommand?: string;
  workerCandidates?: AgentCandidateInput[];
  goal?: string;
  verifyCommand: string;
  reviewCommand?: string;
  reviewAgent?: string;
  reviewCandidates?: AgentCandidateInput[];
  commandTimeoutMs?: number;
  activityTimeouts?: ActivityTimeoutOverrides;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  heartbeat?: (details: unknown) => void;
}

export interface SimpleWorkflowExtendIterationsOptions {
  cwd: string;
  run: WorkflowRunRecord;
  worktreePath: string;
  verifyCommand: string;
  maxIterations: number;
  command?: string;
  agent?: string;
  resumeCommand?: string;
  workerCandidates?: AgentCandidateInput[];
  goal?: string;
  reviewCommand?: string;
  reviewAgent?: string;
  reviewCandidates?: AgentCandidateInput[];
  commandTimeoutMs?: number;
  activityTimeouts?: ActivityTimeoutOverrides;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  heartbeat?: (details: unknown) => void;
}

export interface SimpleWorkflowSessionResumeOptions {
  cwd: string;
  run: WorkflowRunRecord;
  worktreePath: string;
  sessionId: string;
  prompt: string;
  verifyCommand: string;
  reviewCommand?: string;
  reviewAgent?: string;
  reviewCandidates?: AgentCandidateInput[];
  commandTimeoutMs?: number;
  activityTimeouts?: ActivityTimeoutOverrides;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  heartbeat?: (details: unknown) => void;
}

interface SimpleWorkflowContext {
  store: RunArtifactStore;
  run: WorkflowRunRecord;
  cwd: string;
  activityTimeouts: ActivityTimeoutOverrides;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  nextId: (prefix: string) => string;
  heartbeat?: (details: unknown) => void;
  profile?: TychonicConfig;
}

interface StructuredReviewStepResult {
  state: WorkflowStateRecord;
  continuationInboxItems: DecisionInboxItemRecord[];
}

interface ResolvedWorkerCandidate {
  command: string;
  agent: string;
  resumeCommand?: string;
}

interface AutoContinueResult {
  status: WorkflowStateStatus;
  workerSession?: AgentSessionRecord;
}

function normalizeActivityTimeouts(
  timeouts: ActivityTimeoutOverrides | undefined,
  defaultTimeoutMs: number | undefined
): ActivityTimeoutOverrides {
  return {
    ...(defaultTimeoutMs ? { default: defaultTimeoutMs } : {}),
    ...timeouts
  };
}

function activityTimeout(
  context: SimpleWorkflowContext,
  name: ActivityTimeoutName,
  type: ActivityType,
  configuredName: ActivityTimeoutName = name,
  fallback?: { name: ActivityTimeoutName; type: ActivityType }
): number {
  const configuredTimeout =
    context.activityTimeouts[name] ??
    context.activityTimeouts[configuredName] ??
    (fallback ? context.activityTimeouts[fallback.name] : undefined);
  if (configuredTimeout !== undefined) {
    return configuredTimeout;
  }

  if (context.activityTimeouts.default !== undefined) {
    return context.activityTimeouts.default;
  }

  if (fallback) {
    return defaultActivityTimeoutMs(fallback.type);
  }

  return (
    defaultActivityTimeoutMs(type)
  );
}

export async function runSimpleWorkflow(options: SimpleWorkflowRunnerOptions): Promise<SimpleWorkflowRunnerResult> {
  validateSimpleWorkflowOptions(options);

  const now = options.now ?? (() => new Date());
  const runId = options.runId ?? createRunId(now());
  const createdAt = now().toISOString();
  const store = new RunArtifactStore(join(options.cwd, ".tychonic"));
  let idCounter = 0;
  const nextId = (prefix: string): string => `${prefix}_${++idCounter}`;

  const run: WorkflowRunRecord = {
    schema_version: "tychonic.run.v1",
    id: runId,
    template: "simple_workflow",
    status: "created",
    ...(options.goal ? { goal: options.goal } : {}),
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

  const context: SimpleWorkflowContext = {
    store,
    run,
    cwd: options.cwd,
    activityTimeouts: normalizeActivityTimeouts(options.activityTimeouts, options.commandTimeoutMs),
    env: options.env ?? process.env,
    now,
    nextId,
    ...(options.heartbeat ? { heartbeat: options.heartbeat } : {}),
    ...(options.profile ? { profile: options.profile } : {})
  };
  const maxIterations = options.autoContinue ? normalizeMaxIterations(options.maxIterations) : 0;
  const reviewCandidates = await resolveReviewCandidates(context, options);
  const workerCandidates = await resolveWorkerCandidates(context, {
    ...(options.command ? { command: options.command } : {}),
    ...(options.workerCandidates ? { workerCandidates: options.workerCandidates } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.resumeCommand ? { resumeCommand: options.resumeCommand } : {}),
    ...(options.goal ? { goal: options.goal } : {})
  });

  await store.initializeRunArtifacts(run);
  if (options.profile) {
    await writeProfileSnapshot(context, options.profile);
  }

  run.status = "running";

  const isolated = await createWorktreeStep(context);
  const workerInput = {
    candidates: workerCandidates,
    worktreePath: isolated.path,
    ...(options.goal ? { goal: options.goal } : {})
  };
  const workResult = await runWorkerStep(context, workerInput);
  const verifyStep = await runVerifyStep(context, {
    command: options.verifyCommand,
    worktreePath: isolated.path,
    skip: workResult.state.status !== "succeeded"
  });
  if (reviewCandidates.length > 0) {
    let reviewStep = await runStructuredReviewStep(context, {
      candidates: reviewCandidates,
      worktreePath: isolated.path,
      workerSession: workResult.session,
      verificationCommands: [options.verifyCommand],
      skip: verifyStep.status !== "succeeded"
    });
    if (options.autoContinue) {
      let continuationWorkerSession = workResult.session;
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        const continuationItems = reviewStep.continuationInboxItems.filter((item) => item.status === "open");
        if (continuationItems.length === 0) {
          break;
        }

        const autoContinueStep = await runAutoContinueStep(context, {
          inboxItems: continuationItems,
          worktreePath: isolated.path,
          workerSession: continuationWorkerSession,
          workerCandidates,
          verificationCommands: [options.verifyCommand]
        });
        if (autoContinueStep.status !== "succeeded") {
          break;
        }
        continuationWorkerSession = autoContinueStep.workerSession ?? continuationWorkerSession;

        const nextVerifyStep = await runVerifyStep(context, {
          command: options.verifyCommand,
          worktreePath: isolated.path,
          skip: false
        });
        reviewStep = await runStructuredReviewStep(context, {
          candidates: reviewCandidates,
          worktreePath: isolated.path,
          workerSession: continuationWorkerSession,
          verificationCommands: [options.verifyCommand],
          skip: nextVerifyStep.status !== "succeeded"
        });
        if (nextVerifyStep.status === "succeeded" && reviewStep.state.status === "succeeded") {
          resolveInboxItems(run, continuationItems);
        }
      }
    }
  }

  recomputeRunStatus(run);
  run.updated_at = now().toISOString();

  return { run, worktreePath: isolated.path };
}

async function writeProfileSnapshot(
  context: SimpleWorkflowContext,
  profile: TychonicConfig
): Promise<void> {
  const state = startState(context, "profile_snapshot", "record effective profile snapshot");
  const artifacts = await context.store.writeProfileArtifacts({
    run: context.run,
    profile,
    createdAt: context.now().toISOString(),
    nextId: context.nextId,
    stateId: state.id
  });
  state.artifact_ids.push(artifacts.snapshot.id);
  finishState(context, state, "succeeded", "profile snapshot recorded");
}

export async function runSimpleWorkflowContinuation(options: SimpleWorkflowContinuationOptions): Promise<SimpleWorkflowRunnerResult> {
  validateContinuationOptions(options);

  const now = options.now ?? (() => new Date());
  const run = structuredClone(options.run);
  const store = new RunArtifactStore(join(options.cwd, ".tychonic"));
  const context: SimpleWorkflowContext = {
    store,
    run,
    cwd: options.cwd,
    activityTimeouts: normalizeActivityTimeouts(options.activityTimeouts, options.commandTimeoutMs),
    env: options.env ?? process.env,
    now,
    nextId: nextIdFromRun(run),
    ...(options.heartbeat ? { heartbeat: options.heartbeat } : {})
  };
  const reviewCandidates = await resolveReviewCandidates(context, options);
  const item = run.inbox.find((candidate) => candidate.id === options.inboxItemId);
  if (!item) {
    throw new Error(`inbox item not found: ${options.inboxItemId}`);
  }
  if (item.action.kind !== "resume_work" && item.action.kind !== "triage") {
    throw new Error(`inbox item is not executable continuation work: ${options.inboxItemId}`);
  }

  const workerSession = item.target_session_id
    ? run.agent_sessions.find((session) => session.id === item.target_session_id)
    : undefined;
  if (item.action.kind === "resume_work" && !workerSession) {
    throw new Error(`target worker session not found: ${item.target_session_id ?? "unknown"}`);
  }
  const workerCandidates =
    item.action.kind === "triage"
      ? await resolveWorkerCandidates(context, {
          ...(options.command ? { command: options.command } : {}),
          ...(options.workerCandidates ? { workerCandidates: options.workerCandidates } : {}),
          ...(options.agent ? { agent: options.agent } : {}),
          ...(options.resumeCommand ? { resumeCommand: options.resumeCommand } : {}),
          ...(options.goal ? { goal: options.goal } : {})
        })
      : undefined;

  await store.initializeRunArtifacts(run);
  run.status = "running";
  run.updated_at = now().toISOString();

  const continueStep = await runAutoContinueStep(context, {
    inboxItems: [item],
    worktreePath: options.worktreePath,
    ...(workerSession ? { workerSession } : {}),
    ...(workerCandidates ? { workerCandidates } : {}),
    verificationCommands: [options.verifyCommand],
    allowTargetedFreshWork: item.action.kind === "triage"
  });
  if (continueStep.status === "succeeded") {
    const reviewWorkerSession = continueStep.workerSession ?? workerSession;
    const verifyStep = await runVerifyStep(context, {
      command: options.verifyCommand,
      worktreePath: options.worktreePath,
      skip: false
    });
    if (verifyStep.status === "succeeded" && reviewCandidates.length === 0) {
      resolveInboxItems(run, [item]);
    }
    if (reviewCandidates.length > 0 && reviewWorkerSession) {
      const reviewStep = await runStructuredReviewStep(context, {
        candidates: reviewCandidates,
        worktreePath: options.worktreePath,
        workerSession: reviewWorkerSession,
        verificationCommands: [options.verifyCommand],
        skip: verifyStep.status !== "succeeded"
      });
      if (verifyStep.status === "succeeded" && reviewStep.state.status === "succeeded") {
        resolveInboxItems(run, [item]);
      }
    }
  }

  recomputeRunStatus(run);
  run.updated_at = now().toISOString();
  return { run, worktreePath: options.worktreePath };
}

export async function runSimpleWorkflowExtendIterations(
  options: SimpleWorkflowExtendIterationsOptions
): Promise<SimpleWorkflowRunnerResult> {
  validateContinuationOptions(options);
  if (!Number.isInteger(options.maxIterations) || options.maxIterations < 1) {
    throw new Error("runSimpleWorkflowExtendIterations maxIterations must be a positive integer");
  }

  let currentRun = options.run;
  for (let iteration = 0; iteration < options.maxIterations; iteration++) {
    const openItem = currentRun.inbox.find(
      (item) =>
        item.status === "open" &&
        (item.action.kind === "resume_work" || item.action.kind === "triage")
    );
    if (!openItem) {
      break;
    }

    const result = await runSimpleWorkflowContinuation({
      cwd: options.cwd,
      run: currentRun,
      worktreePath: options.worktreePath,
      inboxItemId: openItem.id,
      verifyCommand: options.verifyCommand,
      ...(options.command ? { command: options.command } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
      ...(options.resumeCommand ? { resumeCommand: options.resumeCommand } : {}),
      ...(options.workerCandidates ? { workerCandidates: options.workerCandidates } : {}),
      ...(options.goal ? { goal: options.goal } : {}),
      ...(options.reviewCommand ? { reviewCommand: options.reviewCommand } : {}),
      ...(options.reviewAgent ? { reviewAgent: options.reviewAgent } : {}),
      ...(options.reviewCandidates ? { reviewCandidates: options.reviewCandidates } : {}),
      ...(options.commandTimeoutMs ? { commandTimeoutMs: options.commandTimeoutMs } : {}),
      ...(options.activityTimeouts ? { activityTimeouts: options.activityTimeouts } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.heartbeat ? { heartbeat: options.heartbeat } : {})
    });
    currentRun = result.run;

    if (currentRun.status !== "waiting_user") {
      break;
    }
  }

  return { run: currentRun, worktreePath: options.worktreePath };
}

export async function runSimpleWorkflowSessionResume(options: SimpleWorkflowSessionResumeOptions): Promise<SimpleWorkflowRunnerResult> {
  validateContinuationOptions(options);

  const now = options.now ?? (() => new Date());
  const run = structuredClone(options.run);
  const store = new RunArtifactStore(join(options.cwd, ".tychonic"));
  const context: SimpleWorkflowContext = {
    store,
    run,
    cwd: options.cwd,
    activityTimeouts: normalizeActivityTimeouts(options.activityTimeouts, options.commandTimeoutMs),
    env: options.env ?? process.env,
    now,
    nextId: nextIdFromRun(run),
    ...(options.heartbeat ? { heartbeat: options.heartbeat } : {})
  };
  const reviewCandidates = await resolveReviewCandidates(context, options);
  const workerSession = run.agent_sessions.find((session) => session.id === options.sessionId);
  if (!workerSession) {
    throw new Error(`agent session not found: ${options.sessionId}`);
  }
  if (!workerSession.resume_command) {
    throw new Error(`agent session is not resumable: ${options.sessionId}`);
  }

  await store.initializeRunArtifacts(run);
  run.status = "running";
  run.updated_at = now().toISOString();

  const workStep = await runSessionResumeStep(context, {
    workerSession,
    prompt: options.prompt,
    worktreePath: options.worktreePath
  });
  if (workStep.status === "succeeded") {
    const verifyStep = await runVerifyStep(context, {
      command: options.verifyCommand,
      worktreePath: options.worktreePath,
      skip: false
    });
  if (reviewCandidates.length > 0) {
      const reviewStep = await runStructuredReviewStep(context, {
        candidates: reviewCandidates,
        worktreePath: options.worktreePath,
        workerSession,
        verificationCommands: [options.verifyCommand],
        skip: verifyStep.status !== "succeeded"
      });
      if (reviewStep.state.status === "succeeded") {
        resolveOpenInboxItemsForSession(run, workerSession.id);
      }
    }
  }

  recomputeRunStatus(run);
  run.updated_at = now().toISOString();
  return { run, worktreePath: options.worktreePath };
}

export function validateSimpleWorkflowOptions(options: Pick<
  SimpleWorkflowRunnerOptions,
  | "command"
  | "verifyCommand"
  | "goal"
  | "agent"
  | "resumeCommand"
  | "workerCandidates"
  | "reviewCommand"
  | "reviewAgent"
  | "reviewCandidates"
  | "autoContinue"
  | "maxIterations"
>): void {
  assertOptionalCommandHasNoInlineSecrets(options.command, "simple_workflow worker command");
  assertOptionalCommandHasNoInlineSecrets(options.verifyCommand, "simple_workflow verify command");
  assertOptionalCommandHasNoInlineSecrets(options.resumeCommand, "simple_workflow resume command");
  assertOptionalCommandHasNoInlineSecrets(options.reviewCommand, "simple_workflow review command");
  for (const candidate of options.workerCandidates ?? []) {
    assertOptionalCommandHasNoInlineSecrets(candidate.command, `simple_workflow worker candidate ${candidate.agent} command`);
    assertOptionalCommandHasNoInlineSecrets(
      candidate.resumeCommand,
      `simple_workflow worker candidate ${candidate.agent} resume command`
    );
  }
  for (const candidate of options.reviewCandidates ?? []) {
    assertOptionalCommandHasNoInlineSecrets(candidate.command, `simple_workflow review candidate ${candidate.agent} command`);
    if (candidate.resumeCommand) {
      throw new Error(`simple_workflow review candidate ${candidate.agent} must not set resumeCommand`);
    }
  }

  const hasWorkerCandidates = Boolean(options.workerCandidates?.length);
  const hasReviewCandidates = Boolean(options.reviewCandidates?.length);
  if (hasWorkerCandidates && options.command) {
    throw new Error("simple_workflow accepts worker candidates or --command; combine only one worker selection mode");
  }
  if (hasWorkerCandidates && (options.agent || options.resumeCommand)) {
    throw new Error("simple_workflow worker candidates own their agent labels and resume commands");
  }
  if (!hasWorkerCandidates && !options.command) {
    throw new Error("simple_workflow requires a worker command");
  }
  for (const candidate of options.workerCandidates ?? []) {
    if (!candidate.command) {
      throw new Error(`simple_workflow worker candidate ${candidate.agent} requires command`);
    }
  }
  if (hasReviewCandidates && (options.reviewCommand || options.reviewAgent)) {
    throw new Error("simple_workflow review candidates own their agent labels and commands");
  }
  for (const candidate of options.reviewCandidates ?? []) {
    if (!candidate.command) {
      throw new Error(`simple_workflow review candidate ${candidate.agent} requires command`);
    }
  }
  if (options.reviewAgent && !options.reviewCommand) {
    throw new Error("simple_workflow --review-agent requires --review-command");
  }
  if (options.autoContinue && !options.reviewCommand && !hasReviewCandidates) {
    throw new Error("simple_workflow --auto-continue requires --review-command");
  }
  if (options.maxIterations !== undefined && !options.autoContinue) {
    throw new Error("simple_workflow --max-iterations requires --auto-continue");
  }
  if (options.autoContinue) {
    normalizeMaxIterations(options.maxIterations);
  }
}

function assertOptionalCommandHasNoInlineSecrets(command: string | undefined, label: string): void {
  if (command) {
    assertNoInlineSecrets(command, label);
  }
}

function validateContinuationOptions(
  options: Pick<
    SimpleWorkflowContinuationOptions,
    | "command"
    | "verifyCommand"
    | "goal"
    | "agent"
    | "resumeCommand"
    | "workerCandidates"
    | "reviewCommand"
    | "reviewAgent"
    | "reviewCandidates"
  >
): void {
  assertOptionalCommandHasNoInlineSecrets(options.command, "simple_workflow continuation worker command");
  assertOptionalCommandHasNoInlineSecrets(options.verifyCommand, "simple_workflow continuation verify command");
  assertOptionalCommandHasNoInlineSecrets(options.resumeCommand, "simple_workflow continuation resume command");
  assertOptionalCommandHasNoInlineSecrets(options.reviewCommand, "simple_workflow continuation review command");
  for (const candidate of options.workerCandidates ?? []) {
    assertOptionalCommandHasNoInlineSecrets(
      candidate.command,
      `simple_workflow continuation worker candidate ${candidate.agent} command`
    );
    assertOptionalCommandHasNoInlineSecrets(
      candidate.resumeCommand,
      `simple_workflow continuation worker candidate ${candidate.agent} resume command`
    );
  }
  for (const candidate of options.reviewCandidates ?? []) {
    assertOptionalCommandHasNoInlineSecrets(
      candidate.command,
      `simple_workflow continuation review candidate ${candidate.agent} command`
    );
    if (candidate.resumeCommand) {
      throw new Error(`simple_workflow continuation review candidate ${candidate.agent} must not set resumeCommand`);
    }
  }

  const hasWorkerCandidates = Boolean(options.workerCandidates?.length);
  const hasReviewCandidates = Boolean(options.reviewCandidates?.length);
  if (hasWorkerCandidates && options.command) {
    throw new Error("simple_workflow continuation accepts worker candidates or command; combine only one worker selection mode");
  }
  if (hasWorkerCandidates && (options.agent || options.resumeCommand)) {
    throw new Error("simple_workflow continuation worker candidates own their agent labels and resume commands");
  }
  for (const candidate of options.workerCandidates ?? []) {
    if (!candidate.command) {
      throw new Error(`simple_workflow continuation worker candidate ${candidate.agent} requires command`);
    }
  }
  if (hasReviewCandidates && (options.reviewCommand || options.reviewAgent)) {
    throw new Error("simple_workflow continuation review candidates own their agent labels and commands");
  }
  for (const candidate of options.reviewCandidates ?? []) {
    if (!candidate.command) {
      throw new Error(`simple_workflow continuation review candidate ${candidate.agent} requires command`);
    }
  }
  if (options.reviewAgent && !options.reviewCommand) {
    throw new Error("simple_workflow continuation --review-agent requires --review-command");
  }
}

async function resolveReviewCandidates(
  context: SimpleWorkflowContext,
  options: Pick<
    SimpleWorkflowRunnerOptions,
    "reviewCommand" | "reviewAgent" | "reviewCandidates"
  >
): Promise<ResolvedReviewOptions[]> {
  if (options.reviewCandidates?.length) {
    const resolved: ResolvedReviewOptions[] = [];
    for (const [index, candidate] of options.reviewCandidates.entries()) {
      resolved.push(await resolveReviewCandidate(context, candidate, index));
    }
    return resolved;
  }

  if (!options.reviewCommand) {
    return [];
  }
  const agent = options.reviewAgent ?? "review";
  return [
    {
      command: options.reviewCommand,
      agent
    }
  ];
}

async function resolveReviewCandidate(
  context: SimpleWorkflowContext,
  candidate: AgentCandidateInput,
  _index: number
): Promise<ResolvedReviewOptions> {
  if (!candidate.command) {
    throw new Error(`simple_workflow review candidate ${candidate.agent} requires command`);
  }
  return {
    command: candidate.command,
    agent: candidate.agent
  };
}

async function resolveWorkerCandidates(
  context: SimpleWorkflowContext,
  options: Pick<
    SimpleWorkflowRunnerOptions,
    "command" | "goal" | "agent" | "resumeCommand" | "workerCandidates"
  >
): Promise<ResolvedWorkerCandidate[]> {
  if (options.workerCandidates?.length) {
    const resolved: ResolvedWorkerCandidate[] = [];
    for (const candidate of options.workerCandidates) {
      if (!candidate.command) {
        throw new Error(`simple_workflow worker candidate ${candidate.agent} requires command`);
      }
      resolved.push({
        command: candidate.command,
        agent: candidate.agent,
        ...(candidate.resumeCommand ? { resumeCommand: candidate.resumeCommand } : {})
      });
    }
    return resolved;
  }

  const command = await resolveWorkerCommand(context, {
    ...(options.command ? { command: options.command } : {}),
    ...(options.goal ? { goal: options.goal } : {})
  });
  const agent = options.agent ?? "command";
  return [
    {
      command,
      agent,
      ...(options.resumeCommand ? { resumeCommand: options.resumeCommand } : {})
    }
  ];
}

async function resolveWorkerCommand(
  context: SimpleWorkflowContext,
  input: { command?: string; goal?: string }
): Promise<string> {
  if (!input.command) {
    throw new Error("simple_workflow requires a worker command");
  }
  return input.command;
}

async function createWorktreeStep(context: SimpleWorkflowContext): Promise<{ path: string }> {
  const state = startState(context, "create_isolated_worktree", "create isolated workspace for simple_workflow work");
  const isolated = await createIsolatedWorktree({ cwd: context.cwd, runId: context.run.id });
  const baseline = await createIsolatedWorktreeBaseline(context, state, isolated.path);
  if (baseline.status !== "succeeded") {
    finishState(context, state, baseline.status, "failed to record isolated workspace baseline");
    throw new Error("failed to record isolated workspace baseline");
  }
  const artifact = await context.store.writeArtifact({
    run: context.run,
    id: context.nextId("artifact"),
    kind: "worktree_metadata",
    filename: "worktree.json",
    content: `${JSON.stringify(isolated, null, 2)}\n`,
    createdAt: context.now().toISOString(),
    stateId: state.id
  });
  state.artifact_ids.push(artifact.id);
  finishState(context, state, "succeeded", isolated.reason);
  return { path: isolated.path };
}

async function createIsolatedWorktreeBaseline(
  context: SimpleWorkflowContext,
  state: WorkflowStateRecord,
  worktreePath: string
): Promise<{ status: WorkflowStateStatus }> {
  const command = [
    "set -e",
    "if [ -n \"$(git status --porcelain --untracked-files=all)\" ]; then",
    "  git add -A -- .",
    "  git -c user.name=Tychonic -c user.email=tychonic@example.invalid commit -m 'tychonic isolated baseline'",
    "else",
    "  printf 'isolated workspace already clean\\n'",
    "fi"
  ].join("\n");
  const timeoutMs = activityTimeout(context, "create_isolated_worktree", "work");
  const attempt = startAttempt(context, state, "deterministic_command", "record isolated workspace baseline", {
    command,
    cwd: worktreePath,
    timeoutMs
  });
  const liveOutputPath = join(context.store.liveDir(context.run.id), `${attempt.id}.log`);
  attempt.live_output_path = relativeToCwd(context.cwd, liveOutputPath);
  const result = await runCommand({
    command,
    cwd: worktreePath,
    timeoutMs,
    env: context.env,
    liveOutputPath,
    onProgress: () => context.heartbeat?.({ runId: context.run.id, state: state.name, attemptId: attempt.id })
  });
  finishAttempt(context, attempt, result.status, result.status, result.exitCode);
  const outputArtifact = await context.store.writeArtifact({
    run: context.run,
    id: context.nextId("artifact"),
    kind: "worktree_baseline_output",
    filename: `${attempt.id}-worktree-baseline-output.txt`,
    content: result.output,
    createdAt: context.now().toISOString(),
    stateId: state.id,
    activityAttemptId: attempt.id
  });
  state.artifact_ids.push(outputArtifact.id);
  return { status: result.status };
}

async function runWorkerStep(
  context: SimpleWorkflowContext,
  input: {
    candidates: ResolvedWorkerCandidate[];
    worktreePath: string;
    goal?: string;
    prompt?: string;
    promptKind?: string;
    promptFilename?: string;
    timeoutMs?: number;
  }
): Promise<{ state: WorkflowStateRecord; session: AgentSessionRecord }> {
  const state = startState(context, "work", "run simple_workflow worker command in isolated workspace");
  if (input.candidates.length === 0) {
    throw new Error("simple_workflow requires at least one worker candidate");
  }

  const candidateSummary = input.candidates
    .map((candidate, index) => `${index + 1}. ${candidate.agent}: ${candidate.command}`)
    .join("\n");
  const workerPrompt = [
    input.goal ?? "Tychonic simple_workflow work",
    "",
    "Worker candidates:",
    candidateSummary,
    ""
  ].join("\n");
  const basePromptContent = input.prompt ?? workerPrompt;
  const promptContent = basePromptContent;
  const promptArtifact = await context.store.writeArtifact({
    run: context.run,
    id: context.nextId("artifact"),
    kind: input.promptKind ?? "worker_prompt",
    filename: input.promptFilename ?? "worker-prompt.txt",
    content: promptContent,
    createdAt: context.now().toISOString(),
    stateId: state.id
  });
  state.artifact_ids.push(promptArtifact.id);
  const preStepPatch = await captureWorktreePatchContent(context, input.worktreePath);

  let lastSession: AgentSessionRecord | undefined;
  let lastStatus: WorkflowStateStatus = "failed";
  let lastReason = "no worker candidate completed successfully";

  for (const [index, candidate] of input.candidates.entries()) {
    const command = candidate.command;
    const session: AgentSessionRecord = {
      id: `${context.run.id}_${context.nextId("session")}`,
      agent: candidate.agent,
      role: "worker",
      cwd: input.worktreePath,
      status: "running",
      prompt_artifact_id: promptArtifact.id,
      started_at: context.now().toISOString(),
      ...(candidate.resumeCommand ? { resume_command: candidate.resumeCommand } : {})
    };
    context.run.agent_sessions.push(session);
    lastSession = session;

    const timeoutMs = input.timeoutMs ?? activityTimeout(context, "work", "work");
    const attempt = startAttempt(context, state, "work", `execute worker candidate ${index + 1}: ${candidate.agent}`, {
      command,
      cwd: input.worktreePath,
      agentSessionId: session.id,
      timeoutMs
    });
    const liveOutputPath = join(context.store.liveDir(context.run.id), `${attempt.id}.log`);
    attempt.live_output_path = relativeToCwd(context.cwd, liveOutputPath);

    const result = await runCommand({
      command,
      cwd: input.worktreePath,
      timeoutMs,
      env: context.env,
      liveOutputPath,
      stdin: promptContent,
      onProgress: () => context.heartbeat?.({ runId: context.run.id, state: state.name, attemptId: attempt.id })
    });
    finishAttempt(context, attempt, result.status, result.status, result.exitCode);

    const outputArtifact = await context.store.writeArtifact({
      run: context.run,
      id: context.nextId("artifact"),
      kind: "worker_output",
      filename: `${attempt.id}-worker-output.txt`,
      content: result.output,
      createdAt: context.now().toISOString(),
      stateId: state.id,
      activityAttemptId: attempt.id
    });
    state.artifact_ids.push(outputArtifact.id);
    session.result_artifact_id = outputArtifact.id;
    session.status = result.status;
    session.finished_at = context.now().toISOString();

    if (result.status === "succeeded") {
      const changeArtifacts = await captureWorkerChangeArtifacts(context, state, attempt.id, input.worktreePath);
      session.diff_artifact_id = changeArtifacts.patchArtifactId;
      const reason = changeArtifacts.filesChanged
        ? `worker candidate ${index + 1} (${candidate.agent}) succeeded`
        : `worker candidate ${index + 1} (${candidate.agent}) succeeded (no file changes detected)`;
      finishState(context, state, "succeeded", reason);
      return { state, session };
    }

    const changeArtifacts = await captureWorkerChangeArtifacts(context, state, attempt.id, input.worktreePath);
    session.diff_artifact_id = changeArtifacts.patchArtifactId;
    lastStatus = result.status;
    lastReason = `worker candidate ${index + 1} (${candidate.agent}) ${result.status}`;
    if (index < input.candidates.length - 1) {
      const reset = await resetWorktreeForNextWorkerCandidate(context, state, input.worktreePath, preStepPatch);
      if (reset.status !== "succeeded") {
        lastStatus = reset.status;
        lastReason = "failed to reset isolated workspace before the next worker candidate";
        break;
      }
    }
  }

  if (!lastSession) {
    throw new Error("simple_workflow requires at least one worker candidate");
  }
  finishState(context, state, lastStatus, lastReason);
  return { state, session: lastSession };
}

async function resetWorktreeForNextWorkerCandidate(
  context: SimpleWorkflowContext,
  state: WorkflowStateRecord,
  worktreePath: string,
  restorePatch: string
): Promise<{ status: WorkflowStateStatus }> {
  const command = [
    "set -e",
    'restore_patch=$(mktemp "${TMPDIR:-/tmp}/tychonic-worker-restore.XXXXXX")',
    'trap \'rm -f "$restore_patch"\' EXIT',
    'cat > "$restore_patch"',
    "if git rev-parse --verify HEAD >/dev/null 2>&1; then",
    "  git reset --hard HEAD",
    "fi",
    "git clean -fdx",
    'if [ -s "$restore_patch" ]; then',
    '  git apply --binary "$restore_patch"',
    "fi"
  ].join("\n");
  const timeoutMs = activityTimeout(context, "work", "work");
  const attempt = startAttempt(context, state, "deterministic_command", "reset isolated workspace for next worker candidate", {
    command,
    cwd: worktreePath,
    timeoutMs
  });
  const liveOutputPath = join(context.store.liveDir(context.run.id), `${attempt.id}.log`);
  attempt.live_output_path = relativeToCwd(context.cwd, liveOutputPath);
  const result = await runCommand({
    command,
    cwd: worktreePath,
    timeoutMs,
    env: context.env,
    liveOutputPath,
    stdin: restorePatch,
    onProgress: () => context.heartbeat?.({ runId: context.run.id, state: state.name, attemptId: attempt.id })
  });
  finishAttempt(context, attempt, result.status, result.status, result.exitCode);
  const outputArtifact = await context.store.writeArtifact({
    run: context.run,
    id: context.nextId("artifact"),
    kind: "worker_candidate_reset_output",
    filename: `${attempt.id}-worker-candidate-reset-output.txt`,
    content: result.output,
    createdAt: context.now().toISOString(),
    stateId: state.id,
    activityAttemptId: attempt.id
  });
  state.artifact_ids.push(outputArtifact.id);
  return { status: result.status };
}

async function runVerifyStep(
  context: SimpleWorkflowContext,
  input: { command: string; worktreePath: string; skip: boolean }
): Promise<WorkflowStateRecord> {
  const state = startState(context, "verify", "run deterministic verification in isolated workspace");
  if (input.skip) {
    finishState(context, state, "skipped", "worker state did not succeed");
    return state;
  }

  const timeoutMs = activityTimeout(context, "verify", "verify");
  const attempt = startAttempt(context, state, "deterministic_command", "execute verification command", {
    command: input.command,
    cwd: input.worktreePath,
    timeoutMs
  });
  const liveOutputPath = join(context.store.liveDir(context.run.id), `${attempt.id}.log`);
  attempt.live_output_path = relativeToCwd(context.cwd, liveOutputPath);

  const result = await runCommand({
    command: input.command,
    cwd: input.worktreePath,
    timeoutMs,
    env: context.env,
    liveOutputPath,
    onProgress: () => context.heartbeat?.({ runId: context.run.id, state: state.name, attemptId: attempt.id })
  });
  finishAttempt(context, attempt, result.status, result.status, result.exitCode);

  const artifact = await context.store.writeArtifact({
    run: context.run,
    id: context.nextId("artifact"),
    kind: "verify_output",
    filename: `${attempt.id}-verify-output.txt`,
    content: result.output,
    createdAt: context.now().toISOString(),
    stateId: state.id,
    activityAttemptId: attempt.id
  });
  state.artifact_ids.push(artifact.id);
  finishState(context, state, result.status, result.status);
  return state;
}

async function runStructuredReviewStep(
  context: SimpleWorkflowContext,
  input: {
    candidates: ResolvedReviewOptions[];
    worktreePath: string;
    workerSession: AgentSessionRecord;
    verificationCommands: string[];
    skip: boolean;
  }
): Promise<StructuredReviewStepResult> {
  if (input.skip) {
    const state = startState(context, "review", "run structured reviewer in isolated workspace");
    finishState(context, state, "skipped", "deterministic verification did not succeed");
    return { state, continuationInboxItems: [] };
  }
  if (input.candidates.length === 0) {
    throw new Error("structured review requires at least one reviewer candidate");
  }

  const prompt = reviewPrompt(context.run, input.workerSession.id, input.verificationCommands);
  const timeoutMs = activityTimeout(context, "structured_review", "review", "review");
  const stubProfile: TychonicConfig = context.profile ?? { version: "tychonic.config.v1" };

  let lastStep: WorkflowStateRecord | undefined;

  for (const [index, candidate] of input.candidates.entries()) {
    const isLast = index === input.candidates.length - 1;
    const bodyResult = await runReviewActivityBody({
      input: {
        stateName: "review",
        run: context.run,
        profile: stubProfile,
        cwd: input.worktreePath,
        extras: {
          prompt,
          ...(input.verificationCommands.length > 0
            ? { verificationCommands: input.verificationCommands }
            : {})
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
      reviewOptions: candidate,
      timeoutMs,
      stateReason: `execute reviewer candidate ${index + 1}: ${candidate.agent}`
    });

    const bodyStep = bodyResult.delta.states?.[0];
    const bodyAttempt = bodyResult.delta.activityAttempts?.[0];
    if (!bodyStep || !bodyAttempt) {
      throw new Error("review body did not return a state/attempt pair");
    }
    context.run.states.push(bodyStep);
    context.run.activity_attempts.push(bodyAttempt);
    context.run.updated_at = context.now().toISOString();
    lastStep = bodyStep;

    const outcome = bodyResult.reviewOutcome;
    if (!outcome || outcome.kind === "skipped") {
      continue;
    }

    if (outcome.kind === "command_failed") {
      if (isLast) {
        return { state: bodyStep, continuationInboxItems: [] };
      }
      continue;
    }

    for (const session of outcome.agentSessions) {
      context.run.agent_sessions.push(session);
    }
    for (const artifact of outcome.artifacts) {
      context.run.artifacts.push(artifact);
      if (!bodyStep.artifact_ids.includes(artifact.id)) {
        bodyStep.artifact_ids.push(artifact.id);
      }
    }

    if (outcome.kind === "unparseable") {
      if (!isLast) {
        continue;
      }
      context.run.inbox.push({
        id: context.nextId("inbox"),
        status: "open",
        title: "Structured review output requires triage",
        detail: outcome.detail,
        action: { kind: "triage", reason: outcome.detail },
        created_at: context.now().toISOString()
      });
      return { state: bodyStep, continuationInboxItems: [] };
    }

    if (outcome.result.status === "fail") {
      const parsed = outcome.result;
      const inboxStart = context.run.inbox.length;
      await appendReviewFindingsToRun({
        run: context.run,
        sourceStateId: bodyStep.id,
        sourceReviewSessionId: outcome.reviewerSessionId,
        findings: targetFindings(parsed.findings, input.workerSession.id),
        verificationCommands: input.verificationCommands,
        now: context.now().toISOString(),
        nextId: context.nextId,
        writePromptArtifact: async (content) => {
          const artifact = await context.store.writeArtifact({
            run: context.run,
            id: context.nextId("artifact"),
            kind: "resume_prompt",
            filename: `${context.nextId("resume")}-review-prompt.txt`,
            content,
            createdAt: context.now().toISOString(),
            stateId: bodyStep.id
          });
          bodyStep.artifact_ids.push(artifact.id);
          return artifact.id;
        }
      });
      for (const finding of context.run.findings.filter((item) => item.source_state_id === bodyStep.id)) {
        if (!bodyStep.finding_ids.includes(finding.id)) {
          bodyStep.finding_ids.push(finding.id);
        }
      }
      const continuationInboxItems = context.run.inbox
        .slice(inboxStart)
        .filter((item) => item.action.kind === "resume_work" || (item.action.kind === "triage" && item.finding_id));
      return { state: bodyStep, continuationInboxItems };
    }

    return { state: bodyStep, continuationInboxItems: [] };
  }

  return { state: lastStep!, continuationInboxItems: [] };
}

async function runAutoContinueStep(
  context: SimpleWorkflowContext,
  input: {
    inboxItems: DecisionInboxItemRecord[];
    worktreePath: string;
    workerSession?: AgentSessionRecord;
    workerCandidates?: ResolvedWorkerCandidate[];
    verificationCommands?: string[];
    allowTargetedFreshWork?: boolean;
  }
): Promise<AutoContinueResult> {
  const allowTargetedFreshWork =
    Boolean(input.allowTargetedFreshWork) ||
    (Boolean(input.workerCandidates?.length) && (!input.workerSession || !input.workerSession.resume_command));
  const resumeItems = input.inboxItems.filter((item) => item.action.kind === "resume_work");
  const freshWorkItems = input.inboxItems.filter(
    (item) =>
      item.action.kind === "triage" &&
      item.finding_id &&
      item.status === "open" &&
      (!item.target_session_id || allowTargetedFreshWork)
  );
  let resumeStep: WorkflowStateRecord | undefined;

  if (resumeItems.length > 0) {
    if (!input.workerSession) {
      throw new Error("resume_work continuation requires a target worker session");
    }
    resumeStep = await runResumeAutoContinueStep(context, {
      inboxItems: resumeItems,
      worktreePath: input.worktreePath,
      workerSession: input.workerSession
    });
    if (resumeStep.status !== "succeeded") {
      return { status: resumeStep.status };
    }
  }

  if (freshWorkItems.length > 0 && input.workerCandidates?.length) {
    const workResult = await runFreshAutoContinueWorkStep(context, {
      inboxItems: freshWorkItems,
      candidates: input.workerCandidates,
      worktreePath: input.worktreePath,
      verificationCommands: input.verificationCommands ?? []
    });
    return { status: workResult.state.status, workerSession: workResult.session };
  }

  const nonResumableTargetItems = input.inboxItems.filter(
    (item) =>
      !allowTargetedFreshWork &&
      item.action.kind === "triage" &&
      item.finding_id &&
      item.status === "open" &&
      item.target_session_id
  );
  if (nonResumableTargetItems.length > 0) {
    const state = startState(context, "auto_continue", "blocked by non-resumable target worker session");
    finishState(
      context,
      state,
      "blocked",
      `target worker session is not resumable for ${nonResumableTargetItems.length} continuation item(s)`
    );
    return { status: state.status };
  }

  if (resumeStep) {
    return { status: resumeStep.status };
  }

  const state = startState(context, "auto_continue", "execute structured review continuation items");
  if (input.inboxItems.length === 0) {
    finishState(context, state, "skipped", "no continuation inbox items to execute");
  } else {
    finishState(context, state, "skipped", "no auto-continuable inbox items to execute");
  }
  return { status: state.status };
}

async function runResumeAutoContinueStep(
  context: SimpleWorkflowContext,
  input: {
    inboxItems: DecisionInboxItemRecord[];
    worktreePath: string;
    workerSession: AgentSessionRecord;
  }
): Promise<WorkflowStateRecord> {
  const state = startState(context, "auto_continue", "execute structured review resume_work items");

  const resumeItems = input.inboxItems.filter(
    (item): item is DecisionInboxItemRecord & { action: Extract<DecisionInboxItemRecord["action"], { kind: "resume_work" }> } =>
      item.action.kind === "resume_work"
  );
  if (resumeItems.length === 0) {
    finishState(context, state, "succeeded", "no resume_work inbox items to execute");
    return state;
  }

  const firstCommand = resumeItems[0]!.action.command;
  const mixedCommands = resumeItems.some((item) => item.action.command !== firstCommand);
  if (mixedCommands) {
    finishState(
      context,
      state,
      "failed",
      `resume_work inbox items have mixed resume commands; expected a single worker session`
    );
    return state;
  }

  const prompts: string[] = [];
  for (const [index, item] of resumeItems.entries()) {
    const body = await readFile(
      context.store.artifactPath(context.run, item.action.prompt_artifact_id),
      "utf8"
    );
    prompts.push(`## Finding ${index + 1} of ${resumeItems.length} (inbox ${item.id})\n\n${body.trimEnd()}\n`);
  }
  const combinedPrompt = prompts.join("\n---\n\n");
  const resumePrompt = combinedPrompt;

  const timeoutMs = activityTimeout(context, "resume_work", "work", "work", {
    name: "auto_continue",
    type: "auto_continue"
  });
  const attempt = startAttempt(
    context,
    state,
    "resume_work",
    `execute ${resumeItems.length} resume_work inbox item(s) in one worker session`,
    {
      command: firstCommand,
      cwd: input.worktreePath,
      agentSessionId: input.workerSession.id,
      timeoutMs
    }
  );
  const liveOutputPath = join(context.store.liveDir(context.run.id), `${attempt.id}.log`);
  attempt.live_output_path = relativeToCwd(context.cwd, liveOutputPath);

  const result = await runCommand({
    command: firstCommand,
    cwd: input.worktreePath,
    timeoutMs,
    env: context.env,
    liveOutputPath,
    stdin: resumePrompt,
    onProgress: () => context.heartbeat?.({ runId: context.run.id, state: state.name, attemptId: attempt.id })
  });
  finishAttempt(context, attempt, result.status, result.status, result.exitCode);

  const artifact = await context.store.writeArtifact({
    run: context.run,
    id: context.nextId("artifact"),
    kind: "resume_output",
    filename: `resume_output-${attempt.id}.txt`,
    content: result.output,
    createdAt: context.now().toISOString(),
    stateId: state.id,
    activityAttemptId: attempt.id
  });
  state.artifact_ids.push(artifact.id);

  if (result.status !== "succeeded") {
    finishState(
      context,
      state,
      result.status,
      `batched resume_work failed with status ${result.status} (${resumeItems.length} inbox items unresolved)`
    );
    return state;
  }

  const changeArtifacts = await captureWorkerChangeArtifacts(context, state, attempt.id, input.worktreePath);
  input.workerSession.diff_artifact_id = changeArtifacts.patchArtifactId;

  const reason = changeArtifacts.filesChanged
    ? `executed ${resumeItems.length} resume_work inbox item(s) in one worker session`
    : `executed ${resumeItems.length} resume_work inbox item(s) in one worker session (no file changes detected)`;
  finishState(context, state, "succeeded", reason);
  return state;
}

async function runFreshAutoContinueWorkStep(
  context: SimpleWorkflowContext,
  input: {
    inboxItems: DecisionInboxItemRecord[];
    candidates: ResolvedWorkerCandidate[];
    worktreePath: string;
    verificationCommands: string[];
  }
): Promise<{ state: WorkflowStateRecord; session: AgentSessionRecord }> {
  const findings = input.inboxItems
    .map((item) => findingForInboxItem(context.run, item))
    .filter((finding): finding is ReviewFinding => Boolean(finding));
  const prompt = buildFreshWorkPrompt({
    findings,
    verificationCommands: input.verificationCommands
  });
  const result = await runWorkerStep(context, {
    candidates: input.candidates,
    worktreePath: input.worktreePath,
    prompt,
    promptKind: "fresh_work_prompt",
    promptFilename: `${context.nextId("fresh-work")}-prompt.txt`,
    timeoutMs: activityTimeout(context, "work", "work", "work", {
      name: "auto_continue",
      type: "auto_continue"
    })
  });

  return result;
}

async function runSessionResumeStep(
  context: SimpleWorkflowContext,
  input: {
    workerSession: AgentSessionRecord;
    prompt: string;
    worktreePath: string;
  }
): Promise<WorkflowStateRecord> {
  if (!input.workerSession.resume_command) {
    throw new Error(`agent session is not resumable: ${input.workerSession.id}`);
  }

  const state = startState(context, "work", `resume worker session ${input.workerSession.id}`);
  const resumePrompt = input.prompt;
  const promptArtifact = await context.store.writeArtifact({
    run: context.run,
    id: context.nextId("artifact"),
    kind: "resume_prompt",
    filename: `${context.nextId("resume")}-session-resume-prompt.txt`,
    content: resumePrompt,
    createdAt: context.now().toISOString(),
    stateId: state.id
  });
  state.artifact_ids.push(promptArtifact.id);

  const attempt = startAttempt(context, state, "resume_work", "resume worker session", {
    command: input.workerSession.resume_command,
    cwd: input.worktreePath,
    agentSessionId: input.workerSession.id,
    timeoutMs: activityTimeout(context, "resume_work", "work", "work")
  });
  const liveOutputPath = join(context.store.liveDir(context.run.id), `${attempt.id}.log`);
  attempt.live_output_path = relativeToCwd(context.cwd, liveOutputPath);

  const result = await runCommand({
    command: input.workerSession.resume_command,
    cwd: input.worktreePath,
    timeoutMs: activityTimeout(context, "resume_work", "work", "work"),
    env: context.env,
    liveOutputPath,
    stdin: resumePrompt,
    onProgress: () => context.heartbeat?.({ runId: context.run.id, state: state.name, attemptId: attempt.id })
  });
  finishAttempt(context, attempt, result.status, result.status, result.exitCode);

  const outputArtifact = await context.store.writeArtifact({
    run: context.run,
    id: context.nextId("artifact"),
    kind: "resume_output",
    filename: `${attempt.id}-resume-output.txt`,
    content: result.output,
    createdAt: context.now().toISOString(),
    stateId: state.id,
    activityAttemptId: attempt.id
  });
  state.artifact_ids.push(outputArtifact.id);
  let finishReason: string = result.status;
  if (result.status === "succeeded") {
    const changeArtifacts = await captureWorkerChangeArtifacts(context, state, attempt.id, input.worktreePath);
    input.workerSession.diff_artifact_id = changeArtifacts.patchArtifactId;
    if (!changeArtifacts.filesChanged) {
      finishReason = "succeeded (no file changes detected)";
    }
  }
  finishState(context, state, result.status, finishReason);
  return state;
}

async function captureWorkerChangeArtifacts(
  context: SimpleWorkflowContext,
  state: WorkflowStateRecord,
  attemptId: string,
  worktreePath: string
): Promise<{ diffArtifactId: string; patchArtifactId: string; filesChanged: boolean }> {
  const diffResult = await runCommand({
    command: "git status --short && git diff --stat",
    cwd: worktreePath,
    timeoutMs: activityTimeout(context, "worker_diff", "work"),
    env: context.env,
    onProgress: () => context.heartbeat?.({ runId: context.run.id, state: state.name, attemptId })
  });
  const diffContent =
    diffResult.status === "succeeded"
      ? diffResult.output
      : `Diff unavailable for this isolated workspace.\nstatus=${diffResult.status}\n${diffResult.output}`;
  const diffArtifact = await context.store.writeArtifact({
    run: context.run,
    id: context.nextId("artifact"),
    kind: "worker_diff",
    filename: `${attemptId}-worker-diff.txt`,
    content: diffContent,
    createdAt: context.now().toISOString(),
    stateId: state.id,
    activityAttemptId: attemptId
  });
  state.artifact_ids.push(diffArtifact.id);

  // Exclude well-known toolchain cache/scratch directories from the
  // worker_patch. These are never committed source and appear inside the
  // worktree only as side effects of executing tests/builds under a
  // sandbox that blocks the toolchain's default cache path. Without this
  // exclusion the patch balloons with binary cache blobs and git-apply
  // fails on the downstream repo.
  //
  // The list is deliberately narrow: only paths that no real project
  // commits by intent. Broader build dirs (`node_modules/`, `target/`,
  // `dist/`, `build/`) are left in so plugins that legitimately modify
  // them continue to work — operators who do not want those should rely
  // on their repo's `.gitignore`.
  const workerPatchExcludes = [
    ":(exclude).tychonic",
    ":(exclude).gocache",
    ":(exclude)__pycache__",
    ":(exclude).pytest_cache",
    ":(exclude).mypy_cache",
    ":(exclude).ruff_cache",
    ":(exclude).tox",
    ":(exclude).gradle",
    ":(exclude).m2",
    ":(exclude).DS_Store"
  ];
  const patchResult = await runCommand({
    command: [
      "set -e",
      'tmp_index=$(mktemp "${TMPDIR:-/tmp}/tychonic-worker-patch.XXXXXX")',
      'rm -f "$tmp_index"',
      'trap \'rm -f "$tmp_index"\' EXIT',
      'base_tree=$(git rev-parse --verify "HEAD^{tree}" 2>/dev/null || printf 4b825dc642cb6eb9a060e54bf8d69288fbee4904)',
      'GIT_INDEX_FILE="$tmp_index" git read-tree "$base_tree"',
      `GIT_INDEX_FILE="$tmp_index" git add -A -- . ${workerPatchExcludes.map((p) => `'${p}'`).join(" ")}`,
      'GIT_INDEX_FILE="$tmp_index" git diff --cached --binary "$base_tree"'
    ].join("\n"),
    cwd: worktreePath,
    timeoutMs: activityTimeout(context, "worker_patch", "work"),
    env: context.env,
    maxOutputBytes: 20 * 1024 * 1024,
    onProgress: () => context.heartbeat?.({ runId: context.run.id, state: state.name, attemptId })
  });
  const patchContent =
    patchResult.status === "succeeded"
      ? patchResult.output
      : `Patch unavailable for this isolated workspace.\nstatus=${patchResult.status}\n${patchResult.output}`;
  const patchArtifact = await context.store.writeArtifact({
    run: context.run,
    id: context.nextId("artifact"),
    kind: "worker_patch",
    filename: `${attemptId}-worker.patch`,
    content: patchContent,
    createdAt: context.now().toISOString(),
    stateId: state.id,
    activityAttemptId: attemptId
  });
  state.artifact_ids.push(patchArtifact.id);
  // `filesChanged` surfaces the "worker claimed success but produced no
  // tracked-file diff" case. Some agent CLIs (notably Claude without a
  // file-edit tool invocation in its turn) exit 0 even when they only
  // explain rather than act. Callers use this flag to annotate the
  // state reason so operators can distinguish real-success from
  // silent-no-op without opening the patch artifact.
  const filesChanged = patchResult.status === "succeeded" && patchResult.output.trim().length > 0;
  return { diffArtifactId: diffArtifact.id, patchArtifactId: patchArtifact.id, filesChanged };
}

async function captureWorktreePatchContent(context: SimpleWorkflowContext, worktreePath: string): Promise<string> {
  const result = await runCommand({
    command: [
      "set -e",
      'tmp_index=$(mktemp "${TMPDIR:-/tmp}/tychonic-worker-snapshot.XXXXXX")',
      'rm -f "$tmp_index"',
      'trap \'rm -f "$tmp_index"\' EXIT',
      'base_tree=$(git rev-parse --verify "HEAD^{tree}" 2>/dev/null || printf 4b825dc642cb6eb9a060e54bf8d69288fbee4904)',
      'GIT_INDEX_FILE="$tmp_index" git read-tree "$base_tree"',
      'GIT_INDEX_FILE="$tmp_index" git add -A -- .',
      'GIT_INDEX_FILE="$tmp_index" git diff --cached --binary "$base_tree"'
    ].join("\n"),
    cwd: worktreePath,
    timeoutMs: activityTimeout(context, "worker_patch", "work"),
    env: context.env,
    maxOutputBytes: 20 * 1024 * 1024
  });
  return result.status === "succeeded" ? result.output : "";
}

function startState(context: SimpleWorkflowContext, name: string, reason: string): WorkflowStateRecord {
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
  context: SimpleWorkflowContext,
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
  context: SimpleWorkflowContext,
  state: WorkflowStateRecord,
  kind: ActivityAttemptRecord["kind"],
  reason: string,
  optional: { command?: string; cwd?: string; agentSessionId?: string; timeoutMs?: number } = {}
): ActivityAttemptRecord {
  const attempt: ActivityAttemptRecord = {
    id: context.nextId("attempt"),
    state_id: state.id,
    kind,
    status: "running",
    reason,
    cwd: optional.cwd ?? context.cwd,
    started_at: context.now().toISOString(),
    ...(optional.command ? { command: optional.command } : {}),
    ...(optional.agentSessionId ? { agent_session_id: optional.agentSessionId } : {}),
    ...(optional.timeoutMs ? { timeout_ms: optional.timeoutMs } : {})
  };
  context.run.activity_attempts.push(attempt);
  state.activity_attempt_ids.push(attempt.id);
  return attempt;
}

function finishAttempt(
  context: SimpleWorkflowContext,
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

function targetFindings(findings: ReviewFinding[], targetSessionId: string): ReviewFinding[] {
  return findings.map((finding) => ({
    ...finding,
    target_session_id: finding.target_session_id ?? targetSessionId
  }));
}

function findingForInboxItem(
  run: WorkflowRunRecord,
  item: DecisionInboxItemRecord
): ReviewFinding | undefined {
  if (!item.finding_id) {
    return undefined;
  }
  const finding = run.findings.find((candidate) => candidate.id === item.finding_id);
  if (!finding) {
    return undefined;
  }
  return {
    severity: finding.severity,
    title: finding.title,
    detail: finding.detail,
    target: finding.target,
    ...(finding.target_work_session_id ? { target_session_id: finding.target_work_session_id } : {})
  };
}

function resolveInboxItem(run: WorkflowRunRecord, item: DecisionInboxItemRecord): void {
  item.status = "resolved";
  if (!item.finding_id) {
    return;
  }
  const finding = run.findings.find((candidate) => candidate.id === item.finding_id);
  if (finding) {
    finding.status = "fixed";
  }
}

function resolveOpenInboxItemsForSession(run: WorkflowRunRecord, sessionId: string): void {
  for (const item of run.inbox) {
    if (item.status !== "open") {
      continue;
    }
    if (item.target_session_id !== sessionId) {
      continue;
    }
    if (item.action.kind !== "resume_work" && item.action.kind !== "triage") {
      continue;
    }
    resolveInboxItem(run, item);
  }
}

function resolveInboxItems(run: WorkflowRunRecord, items: DecisionInboxItemRecord[]): void {
  for (const item of items) {
    resolveInboxItem(run, item);
  }
}

function nextIdFromRun(run: WorkflowRunRecord): (prefix: string) => string {
  let counter = 0;
  for (const id of [
    ...run.states.map((state) => state.id),
    ...run.activity_attempts.map((attempt) => attempt.id),
    ...run.agent_sessions.map((session) => session.id),
    ...run.artifacts.map((artifact) => artifact.id),
    ...run.findings.map((finding) => finding.id),
    ...run.inbox.map((item) => item.id)
  ]) {
    const match = /_(\d+)$/.exec(id);
    if (match) {
      counter = Math.max(counter, Number(match[1]));
    }
  }
  return (prefix: string): string => `${prefix}_${++counter}`;
}

function recomputeRunStatus(run: WorkflowRunRecord): void {
  const hasNonReviewFailure = run.states.some(
    (state) => state.name !== "review" && (state.status === "failed" || state.status === "timed_out")
  );
  if (hasNonReviewFailure) {
    run.status = "failed";
    return;
  }

  if (run.inbox.some((item) => item.status === "open")) {
    run.status = "waiting_user";
    return;
  }

  const reviewSteps = run.states.filter((state) => state.name === "review");
  const lastReview = reviewSteps[reviewSteps.length - 1];
  if (lastReview && (lastReview.status === "failed" || lastReview.status === "timed_out")) {
    run.status = "failed";
    return;
  }

  run.status = "succeeded";
}

function createRunId(now: Date): string {
  const timestamp = now.toISOString().replace(/[-:.]/g, "").replace("T", "_").replace("Z", "");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `simple_workflow_${timestamp}_${suffix}`;
}

function normalizeMaxIterations(value: number | undefined): number {
  const normalized = value ?? DEFAULT_AUTO_CONTINUE_MAX_ITERATIONS;
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error("--max-iterations must be a positive integer");
  }
  return normalized;
}

function relativeToCwd(cwd: string, targetPath: string): string {
  const relativePath = relative(resolve(cwd), resolve(targetPath));
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }
  return targetPath;
}

function reviewPrompt(
  run: WorkflowRunRecord,
  workerSessionId: string,
  verificationCommands: string[]
): string {
  const commands = verificationCommands.map((command) => `- ${command}`).join("\n");
  return [
    "Review the isolated worker changes for correctness, regressions, missing tests, and goal completion.",
    "Check whether the full original goal is complete. Do not limit the review to bugs in the diff.",
    "Return fail when the implementation is partial, even if the deterministic verification commands passed.",
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
    `Worker session for continuation: ${workerSessionId}`,
    run.goal ? `Goal: ${run.goal}` : "Goal: simple_workflow work",
    "",
    "Verification commands that already passed:",
    commands || "- run the configured deterministic verification command",
    ""
  ].join("\n");
}
