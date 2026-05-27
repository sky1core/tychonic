import { ApplicationFailure } from "@temporalio/activity";
import {
  runWorkerActivityBody,
  type WorkerActivityResources
} from "../bootstrap/workerActivityBody.js";
import {
  activityTimeoutMs,
  defaultActivityTimeoutMs,
  optionalStateConfig,
  type ActivityBlock
} from "../catalog/types.js";
import {
  resolveCommand,
  resolveResumeCommand,
  type AdapterDispatch
} from "../adapters/resolveAdapter.js";
import {
  AGENT_EXECUTABLE_MISSING_FAILURE_TYPE,
  formatMissingAgentExecutables,
  checkAgentExecutables,
  resolvedExecutablePathMap
} from "../adapters/executablePreflight.js";
import { isBuiltInAgentName } from "../adapters/index.js";
import { AdapterUnsupported } from "../adapters/types.js";
import type { BuiltInAgentName } from "../adapters/types.js";
import { runArtifactStoreForRun } from "../storage/runArtifactStore.js";
import type { ActivityInput, ActivityResult } from "../temporal/types.js";
import type { AgentSessionRecord } from "../domain/types.js";
import { applyParsedAdapterSession } from "./adapterSession.js";
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

  const worktreePath = input.worktreePath;
  if (!worktreePath) {
    throw ApplicationFailure.create({
      message: `work activity '${input.stateName}' requires worktreePath (worker activities run inside an isolated worktree)`,
      type: "WorktreePathMissing",
      nonRetryable: true
    });
  }

  const store = runArtifactStoreForRun(input.run);
  const prompt = input.prompt ?? "";
  const resumeSession = resolveExplicitResumeSession(input);

  const resources: WorkerActivityResources = {
    store,
    env: process.env,
    now: () => new Date(),
    nextId: nextIdFromRun(input.run),
    heartbeat: heartbeatActivity
  };
  const timeoutMs = activityTimeoutMs(input.profile, input.stateName, defaultActivityTimeoutMs("work"));

  if (resumeSession) {
    if (!isBuiltInAgentName(resumeSession.agent)) {
      throw ApplicationFailure.create({
        message: `work activity '${input.stateName}': session '${resumeSession.id}' uses unsupported built-in agent '${resumeSession.agent}'`,
        type: "ResumeSessionNotResumable",
        nonRetryable: true
      });
    }
    const resumeBlock = blockForSessionAgent(block, resumeSession.agent);
    const executablePaths = await resolveAdapterExecutablePaths(
      resumeSession.agent,
      resources.env,
      input.stateName,
      "resume"
    );
    const resumeDispatch = resolveResumeDispatch({
      input,
      block: resumeBlock,
      session: resumeSession,
      worktreePath,
      prompt,
      role: "work",
      executablePaths
    });
    const result = await runWorkerActivityBody({
      input,
      expectedType: "work",
      resources,
      command: resumeDispatch.command,
      timeoutMs,
      executionCwd: worktreePath,
      prompt,
      agent: resumeDispatch.agentName,
      stateReason: `resume ${input.stateName} (session ${resumeSession.id})`,
      resumeSessionId: resumeSession.id,
      attemptKind: "resume_work"
    });
    return applyParsedAdapterSession(result, resumeDispatch);
  }

  return runFreshWorkerActivity({
    input,
    block,
    resources,
    timeoutMs,
    worktreePath,
    prompt
  });
}

async function runFreshWorkerActivity(args: {
  input: RunWorkerActivityInput;
  block: ActivityBlock;
  resources: WorkerActivityResources;
  timeoutMs: number;
  worktreePath: string;
  prompt: string;
}): Promise<ActivityResult> {
  const { input, block, resources, timeoutMs, worktreePath, prompt } = args;
  const executablePaths = isBuiltInAgentName(block.agent)
    ? await resolveAdapterExecutablePaths(block.agent, resources.env, input.stateName, "run")
    : undefined;

  let resolved;
  try {
    resolved = resolveCommand({
      block,
      worktreeCwd: worktreePath,
      prompt,
      role: "work",
      ...(executablePaths ? { executablePaths } : {})
    });
  } catch (err) {
    if (err instanceof AdapterUnsupported) {
      throw ApplicationFailure.create({
        message: `work activity '${input.stateName}': ${err.message}`,
        type: "AdapterUnsupported",
        nonRetryable: true
      });
    }
    throw err;
  }
  if (!resolved) {
    throw ApplicationFailure.create({
      message: `work activity '${input.stateName}' requires profile.states.${input.stateName}.command or a built-in agent`,
      type: "CommandMissing",
      nonRetryable: true
    });
  }

  const agentLabel = resolved.kind === "adapter" ? resolved.agentName : resolved.agentLabel;
  const result = await runWorkerActivityBody({
    input,
    expectedType: "work",
    resources,
    command: resolved.command,
    timeoutMs,
    executionCwd: worktreePath,
    prompt,
    agent: agentLabel,
    stateReason: `run ${input.stateName}`
  });

  if (resolved.kind === "adapter") {
    return applyParsedAdapterSession(result, resolved);
  }
  return result;
}

async function resolveAdapterExecutablePaths(
  agentName: BuiltInAgentName,
  env: NodeJS.ProcessEnv,
  stateName: string,
  operation: string
): Promise<Record<string, string>> {
  const result = await checkAgentExecutables(
    {
      version: "tychonic.config.v1",
      states: {
        [stateName]: {
          type: "work",
          agent: agentName
        }
      }
    },
    { env }
  );
  if (result.missing.length === 0) return resolvedExecutablePathMap(result);
  throw ApplicationFailure.create({
    message: formatMissingAgentExecutables(
      `work activity '${stateName}' ${operation}`,
      result.missing
    ),
    type: AGENT_EXECUTABLE_MISSING_FAILURE_TYPE,
    nonRetryable: true
  });
}

function resolveResumeDispatch(args: {
  input: RunWorkerActivityInput;
  block: ActivityBlock;
  session: AgentSessionRecord;
  worktreePath: string;
  prompt: string;
  role: "work";
  executablePaths: Record<string, string>;
}): AdapterDispatch {
  const { input, block, session, worktreePath, prompt, role, executablePaths } = args;
  if (!session.resumable) {
    throw ApplicationFailure.create({
      message: `work activity '${input.stateName}': session '${session.id}' is not resumable`,
      type: "ResumeSessionNotResumable",
      nonRetryable: true
    });
  }

  let dispatch;
  try {
    dispatch = resolveResumeCommand({
      block: blockForSessionAgent(block, session.agent),
      sessionId: session.id,
      worktreeCwd: worktreePath,
      prompt,
      role,
      executablePaths
    });
  } catch (err) {
    if (err instanceof AdapterUnsupported) {
      throw ApplicationFailure.create({
        message: `work activity '${input.stateName}': ${err.message}`,
        type: "AdapterUnsupported",
        nonRetryable: true
      });
    }
    throw err;
  }
  if (!dispatch) {
    throw ApplicationFailure.create({
      message: `work activity '${input.stateName}': session '${session.id}' has no built-in adapter resume path`,
      type: "ResumeSessionNotResumable",
      nonRetryable: true
    });
  }
  return dispatch;
}

function blockForSessionAgent(block: ActivityBlock, agent: string): ActivityBlock {
  const { command: _command, ...rest } = block;
  return { ...rest, agent };
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
  const sessionId = input.sessionId;
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
  if (!session.resumable) {
    throw ApplicationFailure.create({
      message: `work activity '${input.stateName}': session '${sessionId}' is not resumable`,
      type: "ResumeSessionNotResumable",
      nonRetryable: true
    });
  }
  return session;
}
