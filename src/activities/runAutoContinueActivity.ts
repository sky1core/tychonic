import { ApplicationFailure } from "@temporalio/activity";
import { join } from "node:path";
import {
  runWorkerActivityBody,
  type WorkerActivityResources
} from "../bootstrap/workerActivityBody.js";
import { activityTimeoutMs, defaultActivityTimeoutMs, optionalStateConfig } from "../catalog/types.js";
import { RunArtifactStore } from "../storage/runArtifactStore.js";
import type { ActivityInput, ActivityResult } from "../temporal/types.js";
import { heartbeatActivity } from "./heartbeat.js";

export type RunAutoContinueActivityInput = ActivityInput<"auto_continue">;
export type RunAutoContinueActivityResult = ActivityResult;

/**
 * Dispatcher activity. Delegates to `runWorkerActivityBody` in either
 * resume mode (`extras.sessionId` present) or fresh mode (`extras.command`
 * present). Inbox grouping, finding resolution, and multi-iteration loop
 * control live in the caller (Stage 5 workflow). This activity runs one
 * session; it does not know about inbox items.
 *
 * If Stage 5 decides to replace `auto_continue` with direct calls to
 * `runWorkerActivity` / `runResumeWorkActivity` from workflow code (Stage
 * 4 design doc §6.3 and §11 Q7), this file gets deleted alongside the
 * TYPE.
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

  const worktreePath = input.extras.worktreePath;
  if (!worktreePath) {
    throw ApplicationFailure.create({
      message: `auto_continue activity '${input.stateName}' requires extras.worktreePath`,
      type: "WorktreePathMissing",
      nonRetryable: true
    });
  }

  const prompt = input.extras.prompt ?? "";
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

  if (input.extras.sessionId) {
    const existing = input.run.agent_sessions.find((session) => session.id === input.extras.sessionId);
    if (!existing) {
      throw ApplicationFailure.create({
        message: `auto_continue activity '${input.stateName}': session id '${input.extras.sessionId}' is not in run.agent_sessions`,
        type: "ResumeSessionNotFound",
        nonRetryable: true
      });
    }
    if (!existing.resume_command) {
      throw ApplicationFailure.create({
        message: `auto_continue activity '${input.stateName}': session '${input.extras.sessionId}' has no resume_command`,
        type: "ResumeCommandMissing",
        nonRetryable: true
      });
    }
    return runWorkerActivityBody({
      input,
      expectedType: "auto_continue",
      resources,
      command: existing.resume_command,
      timeoutMs,
      executionCwd: worktreePath,
      prompt,
      agent: existing.agent,
      stateReason: `auto_continue ${input.stateName} (resume session ${input.extras.sessionId})`,
      resumeSessionId: input.extras.sessionId,
      attemptKind: "resume_work"
    });
  }

  const command = input.extras.command ?? block.command;
  if (!command) {
    throw ApplicationFailure.create({
      message: `auto_continue activity '${input.stateName}' requires either extras.sessionId (resume) or a command (fresh)`,
      type: "CommandMissing",
      nonRetryable: true
    });
  }

  const agent = input.extras.agent ?? block.agent ?? "custom";
  return runWorkerActivityBody({
    input,
    expectedType: "auto_continue",
    resources,
    command,
    timeoutMs,
    executionCwd: worktreePath,
    prompt,
    agent,
    stateReason: `auto_continue ${input.stateName} (fresh)`
  });
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
