import { ApplicationFailure } from "@temporalio/activity";
import { join } from "node:path";
import {
  runDeterministicCommandBody,
  type DeterministicCommandResources
} from "../bootstrap/deterministicCommandBody.js";
import { activityTimeoutMs, defaultActivityTimeoutMs, optionalStateConfig } from "../catalog/types.js";
import { RunArtifactStore } from "../storage/runArtifactStore.js";
import type { ActivityInput, ActivityResult } from "../temporal/types.js";

export type RunUnitTestActivityInput = ActivityInput<"unit_test">;
export type RunUnitTestActivityResult = ActivityResult;

export async function runUnitTestActivity(input: RunUnitTestActivityInput): Promise<RunUnitTestActivityResult> {
  const block = optionalStateConfig(input.profile, input.stateName, "unit_test");
  if (!block) {
    throw ApplicationFailure.create({
      message: `unit_test activity '${input.stateName}' requires profile.states.${input.stateName} with type 'unit_test'`,
      type: "ActivityBlockMissing",
      nonRetryable: true
    });
  }

  const command = block.command;
  if (!command) {
    throw ApplicationFailure.create({
      message: `unit_test activity '${input.stateName}' requires profile.states.${input.stateName}.command`,
      type: "CommandMissing",
      nonRetryable: true
    });
  }

  const store = new RunArtifactStore(join(input.cwd, ".tychonic"));
  const resources: DeterministicCommandResources = {
    store,
    env: process.env,
    now: () => new Date(),
    nextId: nextIdFromRun(input.run)
  };
  const timeoutMs = activityTimeoutMs(input.profile, input.stateName, defaultActivityTimeoutMs("unit_test"));
  const executionCwd = input.worktreePath ?? input.cwd;

  return runDeterministicCommandBody({
    input,
    expectedType: "unit_test",
    resources,
    command,
    timeoutMs,
    executionCwd,
    stateReason: `run ${input.stateName}`
  });
}

function nextIdFromRun(run: RunUnitTestActivityInput["run"]): (prefix: string) => string {
  let counter =
    run.states.length +
    run.activity_attempts.length +
    run.artifacts.length +
    run.findings.length +
    run.inbox.length +
    run.agent_sessions.length;
  return (prefix: string) => `${prefix}_${++counter}`;
}
