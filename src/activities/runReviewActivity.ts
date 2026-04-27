import { ApplicationFailure } from "@temporalio/common";
import { join } from "node:path";
import {
  resolveNamedReviewOptions,
  runReviewActivityBody
} from "../bootstrap/reviewActivityBody.js";
import { activityTimeoutMs, defaultActivityTimeoutMs, optionalStateConfig } from "../catalog/types.js";
import type { WorkflowRunRecord, WorkflowStateRecord } from "../domain/types.js";
import { AdapterUnsupported } from "../adapters/types.js";
import { RunArtifactStore } from "../storage/runArtifactStore.js";
import type { ActivityInput, ActivityResult } from "../temporal/types.js";
import { heartbeatActivity } from "./heartbeat.js";

/**
 * Temporal activity entry-point for `review` TYPE activities. Resolves the
 * NAMEd review block, builds the shared resources, and delegates to
 * `runReviewActivityBody`. The activity does not mutate `input.run` and
 * returns a `WorkflowRunDelta` through `ActivityResult` (SPEC §Activity
 * Result And Evidence Invariants).
 */
export type RunReviewActivityInput = ActivityInput<"review">;
export type RunReviewActivityResult = ActivityResult;

export async function runReviewActivity(input: RunReviewActivityInput): Promise<RunReviewActivityResult> {
  if (!input.prompt || input.prompt.trim() === "") {
    throw ApplicationFailure.nonRetryable(
      `review activity '${input.stateName}' requires prompt`,
      "review_activity_missing_prompt"
    );
  }

  const block = optionalStateConfig(input.profile, input.stateName, "review");
  if (!block) {
    return missingBlockResult(input.run, input.stateName, () => new Date());
  }

  const store = new RunArtifactStore(join(input.cwd, ".tychonic"));
  const nextId = nextIdFromRun(input.run);
  const env = process.env;
  const now = (): Date => new Date();

  let reviewOptions;
  try {
    reviewOptions = await resolveNamedReviewOptions({
      profile: input.profile,
      name: input.stateName,
      expectedType: "review",
      env,
      worktreeCwd: input.worktreePath ?? input.cwd,
      prompt: input.prompt ?? ""
    });
  } catch (err) {
    if (err instanceof AdapterUnsupported) {
      throw ApplicationFailure.nonRetryable(
        `review activity '${input.stateName}': ${err.message}`,
        "AdapterUnsupported"
      );
    }
    throw err;
  }
  if (!reviewOptions) {
    return missingBlockResult(input.run, input.stateName, now);
  }

  const timeoutMs = activityTimeoutMs(input.profile, input.stateName, defaultActivityTimeoutMs("review"));

  return runReviewActivityBody({
    input,
    expectedType: "review",
    resources: { store, env, now, nextId, heartbeat: heartbeatActivity },
    reviewOptions,
    timeoutMs,
    stateReason: `run configured review activity ${input.stateName}`
  });
}

function missingBlockResult(
  run: WorkflowRunRecord,
  name: string,
  now: () => Date
): ActivityResult {
  const reason = `activity '${name}' is not configured`;
  const timestamp = now().toISOString();
  const state: WorkflowStateRecord = {
    id: `${run.id}_skipped_${name}`,
    name,
    status: "skipped",
    reason,
    activity_attempt_ids: [],
    artifact_ids: [],
    finding_ids: [],
    started_at: timestamp,
    finished_at: timestamp
  };
  return {
    delta: { states: [state], activityAttempts: [] },
    reviewOutcome: { kind: "skipped", reason }
  };
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
