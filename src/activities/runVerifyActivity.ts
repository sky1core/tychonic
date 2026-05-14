import { ApplicationFailure } from "@temporalio/activity";
import {
  runDeterministicCommandBody,
  type DeterministicCommandResources
} from "../bootstrap/deterministicCommandBody.js";
import { activityTimeoutMs, defaultActivityTimeoutMs, optionalStateConfig } from "../catalog/types.js";
import { runArtifactStoreForRun } from "../storage/runArtifactStore.js";
import type { ActivityInput, ActivityResult } from "../temporal/types.js";
import { heartbeatActivity } from "./heartbeat.js";

export type RunVerifyActivityInput = ActivityInput<"verify">;
export type RunVerifyActivityResult = ActivityResult;

export async function runVerifyActivity(input: RunVerifyActivityInput): Promise<RunVerifyActivityResult> {
  const block = optionalStateConfig(input.profile, input.stateName, "verify");
  if (!block) {
    throw ApplicationFailure.create({
      message: `verify activity '${input.stateName}' requires profile.states.${input.stateName} with type 'verify'`,
      type: "ActivityBlockMissing",
      nonRetryable: true
    });
  }

  const command = block.command;
  if (!command) {
    throw ApplicationFailure.create({
      message: `verify activity '${input.stateName}' requires profile.states.${input.stateName}.command`,
      type: "CommandMissing",
      nonRetryable: true
    });
  }

  const store = runArtifactStoreForRun(input.run);
  const resources: DeterministicCommandResources = {
    store,
    env: process.env,
    now: () => new Date(),
    nextId: nextIdFromRun(input.run),
    heartbeat: heartbeatActivity
  };
  const timeoutMs = activityTimeoutMs(input.profile, input.stateName, defaultActivityTimeoutMs("verify"));
  const executionCwd = input.worktreePath ?? input.cwd;

  return runDeterministicCommandBody({
    input,
    expectedType: "verify",
    resources,
    command,
    timeoutMs,
    executionCwd,
    stateReason: `run ${input.stateName}`
  });
}

function nextIdFromRun(run: RunVerifyActivityInput["run"]): (prefix: string) => string {
  let counter =
    run.states.length +
    run.activity_attempts.length +
    run.artifacts.length +
    run.findings.length +
    run.inbox.length +
    run.agent_sessions.length;
  return (prefix: string) => `${prefix}_${++counter}`;
}
