import { ApplicationFailure } from "@temporalio/activity";
import { join } from "node:path";
import {
  runWorkerActivityBody,
  type WorkerActivityResources
} from "../bootstrap/workerActivityBody.js";
import { activityTimeoutMs, defaultActivityTimeoutMs, optionalStateConfig, type ActivityBlock } from "../catalog/types.js";
import { resolveCommand, resolveResumeCommand, type AdapterDispatch } from "../adapters/resolveAdapter.js";
import { AdapterUnsupported } from "../adapters/types.js";
import { RunArtifactStore } from "../storage/runArtifactStore.js";
import type { ActivityInput, ActivityResult } from "../temporal/types.js";
import type { AgentSessionRecord } from "../domain/types.js";
import { applyParsedAdapterSession } from "./adapterSession.js";
import { heartbeatActivity } from "./heartbeat.js";

export type RunAutoContinueActivityInput = ActivityInput<"auto_continue">;
export type RunAutoContinueActivityResult = ActivityResult;

/**
 * Dispatcher activity. Delegates to `runWorkerActivityBody` in either
 * resume mode (`sessionId` present) or fresh mode (state config command/agent).
 * Inbox grouping, finding resolution, and multi-iteration loop control live
 * in the calling workflow. This activity runs one session; it does not know
 * about inbox items.
 */
export async function runAutoContinueActivity(
  input: RunAutoContinueActivityInput
): Promise<RunAutoContinueActivityResult> {
  const block = optionalStateConfig(input.profile, input.stateName, "auto_continue");
  if (!block) {
    throw ApplicationFailure.create({
      message: `auto_continue activity '${input.stateName}' requires profile.states.${input.stateName} with type 'auto_continue'`,
      type: "StateConfigBlockMissing",
      nonRetryable: true
    });
  }

  const worktreePath = input.worktreePath;
  if (!worktreePath) {
    throw ApplicationFailure.create({
      message: `auto_continue activity '${input.stateName}' requires worktreePath`,
      type: "WorktreePathMissing",
      nonRetryable: true
    });
  }

  const prompt = input.prompt ?? "";
  const store = new RunArtifactStore(join(input.cwd, ".tychonic"));
  const resources: WorkerActivityResources = {
    store,
    env: process.env,
    now: () => new Date(),
    nextId: nextIdFromRun(input.run),
    heartbeat: heartbeatActivity
  };
  const timeoutMs = activityTimeoutMs(
    input.profile,
    input.stateName,
    defaultActivityTimeoutMs("auto_continue")
  );

  if (input.sessionId) {
    const existing = input.run.agent_sessions.find((session) => session.id === input.sessionId);
    if (!existing) {
      throw ApplicationFailure.create({
        message: `auto_continue activity '${input.stateName}': session id '${input.sessionId}' is not in run.agent_sessions`,
        type: "ResumeSessionNotFound",
        nonRetryable: true
      });
    }
    const resumeDispatch = resolveAutoContinueResumeDispatch({
      input,
      block,
      session: existing,
      worktreePath,
      prompt
    });
    return runWorkerActivityBody({
      input,
      expectedType: "auto_continue",
      resources,
      command: resumeDispatch.command,
      timeoutMs,
      executionCwd: worktreePath,
      prompt,
      agent: resumeDispatch.agentName,
      stateReason: `auto_continue ${input.stateName} (resume session ${input.sessionId})`,
      resumeSessionId: input.sessionId,
      attemptKind: "resume_work"
    });
  }

  let resolved;
  try {
    resolved = resolveCommand({
      block,
      worktreeCwd: worktreePath,
      prompt,
      role: "auto_continue"
    });
  } catch (err) {
    if (err instanceof AdapterUnsupported) {
      throw ApplicationFailure.create({
        message: `auto_continue activity '${input.stateName}': ${err.message}`,
        type: "AdapterUnsupported",
        nonRetryable: true
      });
    }
    throw err;
  }
  if (!resolved) {
    throw ApplicationFailure.create({
      message: `auto_continue activity '${input.stateName}' requires either sessionId (resume) or profile.states.${input.stateName}.command/built-in agent (fresh)`,
      type: "CommandMissing",
      nonRetryable: true
    });
  }

  const agent = resolved.kind === "adapter" ? resolved.agentName : resolved.agentLabel;
  const result = await runWorkerActivityBody({
    input,
    expectedType: "auto_continue",
    resources,
    command: resolved.command,
    timeoutMs,
    executionCwd: worktreePath,
    prompt,
    agent,
    stateReason: `auto_continue ${input.stateName} (fresh)`
  });
  return resolved.kind === "adapter" ? applyParsedAdapterSession(result, resolved) : result;
}

function resolveAutoContinueResumeDispatch(args: {
  input: RunAutoContinueActivityInput;
  block: ActivityBlock;
  session: AgentSessionRecord;
  worktreePath: string;
  prompt: string;
}): AdapterDispatch {
  const { input, block, session, worktreePath, prompt } = args;
  if (!session.resumable) {
    throw ApplicationFailure.create({
      message: `auto_continue activity '${input.stateName}': session '${session.id}' is not resumable`,
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
      role: "auto_continue"
    });
  } catch (err) {
    if (err instanceof AdapterUnsupported) {
      throw ApplicationFailure.create({
        message: `auto_continue activity '${input.stateName}': ${err.message}`,
        type: "AdapterUnsupported",
        nonRetryable: true
      });
    }
    throw err;
  }
  if (!dispatch) {
    throw ApplicationFailure.create({
      message: `auto_continue activity '${input.stateName}': session '${session.id}' has no built-in adapter resume path`,
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

function nextIdFromRun(run: RunAutoContinueActivityInput["run"]): (prefix: string) => string {
  let counter =
    run.states.length +
    run.activity_attempts.length +
    run.artifacts.length +
    run.findings.length +
    run.inbox.length +
    run.agent_sessions.length;
  return (prefix: string) => `${prefix}_${++counter}`;
}
