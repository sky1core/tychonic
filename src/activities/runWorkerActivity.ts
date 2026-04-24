import { ApplicationFailure } from "@temporalio/activity";
import { join } from "node:path";
import {
  runWorkerActivityBody,
  type WorkerActivityResources
} from "../bootstrap/workerActivityBody.js";
import {
  activityTimeoutMs,
  defaultActivityTimeoutMs,
  optionalStateConfig,
  resolveActivityCommand,
  stateResumeEnabled
} from "../catalog/types.js";
import { RunArtifactStore } from "../storage/runArtifactStore.js";
import type { ActivityInput, ActivityResult } from "../temporal/types.js";
import type { AgentSessionRecord } from "../domain/types.js";
import { heartbeatActivity } from "./heartbeat.js";

export type RunWorkerActivityInput = ActivityInput<"work">;
export type RunWorkerActivityResult = ActivityResult;

export async function runWorkerActivity(input: RunWorkerActivityInput): Promise<RunWorkerActivityResult> {
  const block = optionalStateConfig(input.profile, input.stateName, "work");
  if (!block) {
    throw ApplicationFailure.create({
      message: `work activity '${input.stateName}' requires profile.states.${input.stateName} with type 'work'`,
      type: "StateConfigBlockMissing",
      nonRetryable: true
    });
  }

  const worktreePath = input.extras.worktreePath;
  if (!worktreePath) {
    throw ApplicationFailure.create({
      message: `work activity '${input.stateName}' requires extras.worktreePath (worker activities run inside an isolated worktree)`,
      type: "WorktreePathMissing",
      nonRetryable: true
    });
  }

  const store = new RunArtifactStore(join(input.cwd, ".tychonic"));
  const prompt = input.extras.prompt ?? input.extras.goal ?? "";
  const resumeSession =
    resolveExplicitResumeSession(input) ??
    (stateResumeEnabled(block) ? findLatestStateResumeSession(input) : undefined);

  const resources: WorkerActivityResources = {
    store,
    env: process.env,
    now: () => new Date(),
    nextId: nextIdFromRun(input.run),
    heartbeat: heartbeatActivity
  };
  const timeoutMs = activityTimeoutMs(input.profile, input.stateName, defaultActivityTimeoutMs("work"));

  const result = resumeSession
    ? await runWorkerActivityBody({
        input,
        expectedType: "work",
        resources,
        command: resumeSession.resume_command!,
        timeoutMs,
        executionCwd: worktreePath,
        prompt,
        agent: resumeSession.agent,
        stateReason: `resume ${input.stateName} (session ${resumeSession.id})`,
        resumeSessionId: resumeSession.id,
        attemptKind: "resume_work"
      })
    : (await runFreshWorkerActivity({
        input,
        block,
        resources,
        timeoutMs,
        worktreePath,
        prompt
      })).result;
  return result;
}

async function runFreshWorkerActivity(input: {
  input: RunWorkerActivityInput;
  block: NonNullable<ReturnType<typeof optionalStateConfig>>;
  resources: WorkerActivityResources;
  timeoutMs: number;
  worktreePath: string;
  prompt: string;
}): Promise<{ result: ActivityResult; command: string }> {
  const agentCommand = resolveActivityCommand(input.block);
  let command = input.input.extras.command ?? input.block.command ?? agentCommand?.command;
  if (!command) {
    throw ApplicationFailure.create({
      message: `work activity '${input.input.stateName}' requires a command (profile.states.${input.input.stateName}.command or extras.command)`,
      type: "CommandMissing",
      nonRetryable: true
    });
  }

  const result = await runWorkerActivityBody({
    input: input.input,
    expectedType: "work",
    resources: input.resources,
    command,
    timeoutMs: input.timeoutMs,
    executionCwd: input.worktreePath,
    prompt: input.prompt,
    agent: input.block.agent ?? "custom",
    stateReason: `run ${input.input.stateName}`,
    ...(input.block.resume_command ? { resumeCommand: input.block.resume_command } : {})
  });
  return { result, command };
}

function nextIdFromRun(run: RunWorkerActivityInput["run"]): (prefix: string) => string {
  let counter =
    run.states.length +
    run.activity_attempts.length +
    run.artifacts.length +
    run.findings.length +
    run.inbox.length +
    run.agent_sessions.length;
  return (prefix: string) => `${prefix}_${++counter}`;
}

function resolveExplicitResumeSession(input: RunWorkerActivityInput): AgentSessionRecord | undefined {
  const sessionId = input.extras.sessionId;
  if (!sessionId) {
    return undefined;
  }
  const session = input.run.agent_sessions.find((candidate) => candidate.id === sessionId);
  if (!session) {
    throw ApplicationFailure.create({
      message: `work activity '${input.stateName}': session id '${sessionId}' is not in run.agent_sessions`,
      type: "ResumeSessionNotFound",
      nonRetryable: true
    });
  }
  if (!session.resume_command) {
    throw ApplicationFailure.create({
      message: `work activity '${input.stateName}': session '${sessionId}' has no resume_command`,
      type: "ResumeCommandMissing",
      nonRetryable: true
    });
  }
  return session;
}

function findLatestStateResumeSession(input: RunWorkerActivityInput): AgentSessionRecord | undefined {
  const stateIds = new Set(
    input.run.states.filter((state) => state.name === input.stateName).map((state) => state.id)
  );
  for (const attempt of [...input.run.activity_attempts].reverse()) {
    if (!stateIds.has(attempt.state_id) || !attempt.agent_session_id) {
      continue;
    }
    const session = input.run.agent_sessions.find((candidate) => candidate.id === attempt.agent_session_id);
    if (session?.resume_command) {
      return session;
    }
  }
  return undefined;
}
