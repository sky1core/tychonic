import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { optionalStateConfig } from "../catalog/types.js";
import type {
  ActivityAttemptRecord,
  ArtifactRecord,
  WorkflowStateRecord
} from "../domain/types.js";
import type { RunArtifactStore } from "../storage/runArtifactStore.js";
import type { ActivityInput, ActivityResult } from "../temporal/types.js";
import { runCommand, withPeriodicProgress } from "./commandRunner.js";

export type DeterministicCommandType = "lint" | "unit_test" | "integration" | "verify";

export interface DeterministicCommandResources {
  store: RunArtifactStore;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  nextId: (prefix: string) => string;
  heartbeat?: (details: unknown) => void;
}

export interface RunDeterministicCommandBodyOptions<T extends DeterministicCommandType> {
  input: ActivityInput<T>;
  expectedType: T;
  resources: DeterministicCommandResources;
  command: string;
  timeoutMs: number;
  executionCwd: string;
  stateReason: string;
}

/**
 * Shared body for deterministic-command activities (`lint`, `unit_test`,
 * `integration`, `verify`). Runs one command, records one attempt, writes
 * one output artifact. Does not mutate `input.run` (SPEC §File I/O vs run
 * mutation). Produces exactly one state (SPEC §One state per body call).
 *
 * Skip conditions (autonomy, facts, policy modes, missing config) live in
 * the caller. This body is called only when the caller has already decided
 * to execute the command.
 */
export async function runDeterministicCommandBody<T extends DeterministicCommandType>(
  options: RunDeterministicCommandBodyOptions<T>
): Promise<ActivityResult> {
  const { input, expectedType, resources, command, timeoutMs, executionCwd, stateReason } = options;
  const { store, env, now, nextId, heartbeat } = resources;
  const { run, profile, stateName } = input;

  const block = optionalStateConfig(profile, stateName, expectedType);
  if (!block) {
    throw new Error(
      `deterministic-command activity '${stateName}' expects profile.states.${stateName} with type '${expectedType}'`
    );
  }

  const stateStartedAt = now().toISOString();
  const state: WorkflowStateRecord = {
    id: nextId("state"),
    name: stateName,
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
    kind: "deterministic_command",
    status: "running",
    reason: `execute ${stateName}`,
    cwd: executionCwd,
    command,
    timeout_ms: timeoutMs,
    started_at: attemptStartedAt
  };
  state.activity_attempt_ids.push(attempt.id);

  await mkdir(store.liveDir(run.id), { recursive: true });
  const liveOutputPath = join(store.liveDir(run.id), `${attempt.id}.log`);
  attempt.live_output_path = relativeToExecutionCwd(executionCwd, liveOutputPath);

  const progress = (): void => heartbeat?.({ runId: run.id, state: state.name, attemptId: attempt.id });
  const result = await withPeriodicProgress(progress, async () =>
    await runCommand({
      command,
      cwd: executionCwd,
      timeoutMs,
      env,
      liveOutputPath,
      onProgress: progress
    })
  );
  if (result.exitCode !== undefined) {
    attempt.exit_code = result.exitCode;
  }
  attempt.status = result.status;
  attempt.reason = result.status;
  attempt.finished_at = now().toISOString();

  const artifactsDir = store.artifactsDir(run.id);
  await mkdir(artifactsDir, { recursive: true });
  const artifactKind = `${stateName}_output`;
  const filename = `${artifactKind}-${attempt.id}.txt`;
  const artifactPath = join(artifactsDir, filename);
  await writeFile(artifactPath, result.output, "utf8");
  const artifact: ArtifactRecord = {
    id: nextId("artifact"),
    kind: artifactKind,
    path: relative(dirname(store.rootDir), artifactPath),
    created_at: now().toISOString(),
    state_id: state.id,
    activity_attempt_id: attempt.id
  };
  state.artifact_ids.push(artifact.id);

  state.status = result.status;
  state.reason = result.status;
  state.finished_at = now().toISOString();

  return {
    delta: { states: [state], activityAttempts: [attempt] },
    commandOutcome: { artifact }
  };
}

function relativeToExecutionCwd(cwd: string, targetPath: string): string {
  const relativePath = relative(resolve(cwd), resolve(targetPath));
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }
  return targetPath;
}
