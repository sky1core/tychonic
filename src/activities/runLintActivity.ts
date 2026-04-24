import { ApplicationFailure } from "@temporalio/activity";
import { join } from "node:path";
import {
  runDeterministicCommandBody,
  type DeterministicCommandResources
} from "../bootstrap/deterministicCommandBody.js";
import { activityTimeoutMs, defaultActivityTimeoutMs, optionalStateConfig } from "../catalog/types.js";
import { RunArtifactStore } from "../storage/runArtifactStore.js";
import type { ActivityInput, ActivityResult } from "../temporal/types.js";

export type RunLintActivityInput = ActivityInput<"lint">;
export type RunLintActivityResult = ActivityResult;

export async function runLintActivity(input: RunLintActivityInput): Promise<RunLintActivityResult> {
  const block = optionalStateConfig(input.profile, input.stateName, "lint");
  if (!block) {
    throw ApplicationFailure.create({
      message: `lint activity '${input.stateName}' requires profile.states.${input.stateName} with type 'lint'`,
      type: "ActivityBlockMissing",
      nonRetryable: true
    });
  }

  const command = input.extras.command ?? block.command;
  if (!command) {
    throw ApplicationFailure.create({
      message: `lint activity '${input.stateName}' requires a command (profile.states.${input.stateName}.command or extras.command)`,
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
  const timeoutMs = activityTimeoutMs(input.profile, input.stateName, defaultActivityTimeoutMs("lint"));
  const executionCwd = input.extras.worktreePath ?? input.cwd;

  return runDeterministicCommandBody({
    input,
    expectedType: "lint",
    resources,
    command,
    timeoutMs,
    executionCwd,
    stateReason: `run ${input.stateName}`
  });
}

function nextIdFromRun(run: RunLintActivityInput["run"]): (prefix: string) => string {
  let counter =
    run.states.length +
    run.activity_attempts.length +
    run.artifacts.length +
    run.findings.length +
    run.inbox.length +
    run.agent_sessions.length;
  return (prefix: string) => `${prefix}_${++counter}`;
}
