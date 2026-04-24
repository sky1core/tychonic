import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import type { ActivityType, TychonicConfig } from "../catalog/types.js";
import type { WorkflowRunRecord, WorkflowStateRecord } from "../domain/types.js";
import type { CheckpointWorkflowInput, CheckpointWorkflowResult } from "../temporal/types.js";
import { applyActivityResult, applyModifyStateDecision } from "./runMerge.js";
import {
  appendInboxForActionableSkippedReviews,
  factsForRun,
  hasFailedOrTimedOutState,
  integrationPosition,
  nextSequentialId,
  reviewPrompt,
  shouldRunDeterministicCommand,
  shouldRunSemanticReview,
  shouldRunTestReview,
  skippedState,
  summarizeRun,
  TEST_REVIEW_PROMPT
} from "./checkpointPure.js";
import { applyWorkflowCommandTimeout } from "./commandTimeout.js";
import {
  drainStraySignals,
  effectiveInteractionMode,
  registerInteractionSignals,
  setInteractionPolicy,
  strayInteractionSignalInboxItem,
  waitForStateApproval,
  type ApprovalDecision
} from "./interactionHook.js";
import { INTERACTION_DEFAULT_MAX_REJECT_ITERATIONS } from "./interactionDefaults.js";

const act = proxyActivities<typeof activities>({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
});

const {
  startRunActivity,
  collectGitFactsActivity,
  runLintActivity,
  runUnitTestActivity,
  runIntegrationActivity,
  runReviewActivity,
  finalizeRunActivity
} = act;

export const requires = {
  states: [
    { name: "lint", type: "lint" },
    { name: "unit_test", type: "unit_test" },
    { name: "integration", type: "integration" },
    { name: "semantic_review", type: "review" },
    { name: "test_review", type: "review" }
  ]
} as const;

/**
 * Included `checkpoint` workflow module. Orchestrates the deterministic + review
 * pipeline by calling each state's activity directly through Temporal.
 * Skip conditions (autonomy, facts, missing config block) and inbox
 * entries for skipped reviews are computed inline using the pure helpers
 * in `checkpointPure.ts`. No bootstrap runner is invoked — every observable
 * behavior is explicit in this file.
 */
export async function checkpointWorkflow(input: CheckpointWorkflowInput): Promise<CheckpointWorkflowResult> {
  const profile = applyWorkflowCommandTimeout(
    input.profile,
    input.commandTimeoutMs,
    ["lint", "unit_test", "integration", "semantic_review", "test_review"]
  );
  // Register interactive signals and cache the policy before the first
  // `await`. Auto-mode runs never suspend; interactive mode gates every
  // activity call. See SPEC §Workflow Model → `waitForStateApproval`.
  registerInteractionSignals();
  setInteractionPolicy(profile.policies?.interaction);

  // Pre-flight config validation. Keeps the old contract where a wrong
  // TYPE on a known NAME fails the workflow before any work.
  assertNameType(profile, "lint", "lint");
  assertNameType(profile, "unit_test", "unit_test");
  assertNameType(profile, "integration", "integration");
  assertNameType(profile, "semantic_review", "review");
  assertNameType(profile, "test_review", "review");

  const autonomy = input.autonomy ?? "check";
  let run = await startRunActivity({
    template: "checkpoint",
    cwd: input.cwd,
    profile,
    ...(input.goal ? { goal: input.goal } : {}),
    ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
    ...(input.runId ? { runId: input.runId } : {})
  });
  run = { ...run, status: "running" };

  // Collect git facts. Writes no state; attaches a RunFacts patch via the
  // delta. The facts govern skip decisions for the later states.
  const factsResult = await collectGitFactsActivity({ run, cwd: input.cwd });
  run = applyActivityResult(run, factsResult);

  const now = (): string => new Date().toISOString();
  const runForActivity = (r: WorkflowRunRecord): WorkflowRunRecord => r;

  const rejectCounts = new Map<string, number>();

  // Deterministic commands (lint, unit_test).
  run = await runOrSkipDeterministic(run, "lint", autonomy, input, profile, now, runLintActivity, rejectCounts);
  run = await runOrSkipDeterministic(run, "unit_test", autonomy, input, profile, now, runUnitTestActivity, rejectCounts);
  const integrationAt = integrationPosition(profile);

  if (integrationAt === "before_ai_review") {
    // Integration: policy-driven. Disabled skips silently; manual blocks
    // with an inbox triage item; auto / required runs the activity when
    // the block is configured and the previous pipeline has not failed.
    run = await runIntegration(run, autonomy, input, profile, now, rejectCounts);
  }

  // Semantic review.
  run = await runOrSkipReview(
    run,
    "semantic_review",
    autonomy,
    input,
    profile,
    now,
    shouldRunSemanticReview,
    reviewPrompt(run),
    rejectCounts
  );

  if (integrationAt === "after_ai_review") {
    run = await runIntegration(run, autonomy, input, profile, now, rejectCounts);
  }

  // Test-only review.
  run = await runOrSkipReview(
    run,
    "test_review",
    autonomy,
    input,
    profile,
    now,
    shouldRunTestReview,
    TEST_REVIEW_PROMPT,
    rejectCounts
  );

  if (integrationAt === "final_gate") {
    run = await runIntegration(run, autonomy, input, profile, now, rejectCounts);
  }

  // Surface only actionable skipped reviews (for example, missing review
  // config) as inbox items. Benign skips like "no source changes" should not
  // force the run into waiting_user.
  run = appendInboxForActionableSkippedReviews(run, now());

  // Stray interaction signals (R-03). Only populated when interactive
  // mode was active; auto-mode callers never emit these signals.
  run = absorbStrayInteractionSignals(run, now());

  // Finalize: compute terminal run.status and summary.
  const finalize = await finalizeRunActivity({
    run: runForActivity(run),
    summary: summarizeRun(run)
  });
  run = applyActivityResult(run, finalize);

  return {
    runId: run.id,
    status: run.status,
    run,
    artifactRoot: `${input.cwd}/.tychonic/runs/${run.id}`,
    ...(run.summary ? { summary: run.summary } : {})
  };
}

function absorbStrayInteractionSignals(run: WorkflowRunRecord, createdAt: string): WorkflowRunRecord {
  if (effectiveInteractionMode() !== "interactive") {
    return run;
  }
  const strays = drainStraySignals();
  if (strays.length === 0) {
    return run;
  }
  const nextInbox = [...run.inbox];
  for (const stray of strays) {
    nextInbox.push(
      strayInteractionSignalInboxItem(stray, {
        createdAt,
        id: nextSequentialId("inbox", nextInbox.map((item) => item.id))
      })
    );
  }
  return { ...run, inbox: nextInbox };
}

/**
 * Exported for direct testing; production callers are the workflow
 * helpers above.
 */
export async function gateDecisionForCheckpoint(
  run: WorkflowRunRecord,
  stateName: string,
  rejectCounts: Map<string, number>,
  profile: TychonicConfig,
  now: () => string,
  rerunActivity: (currentRun: WorkflowRunRecord, feedback?: string) => Promise<WorkflowRunRecord>
): Promise<WorkflowRunRecord> {
  const cap = rejectCapFor(profile);
  let currentRun = run;
  while (true) {
    if ((rejectCounts.get(stateName) ?? 0) >= cap) {
      return parkAtRejectCap(currentRun, stateName, now());
    }
    const decision = await waitForStateApproval(stateName);
    if (decision.kind === "approve") {
      return currentRun;
    }
    if (decision.kind === "modify") {
      return applyModifyStateDecision(currentRun, stateName, decision.patch);
    }
    // reject
    const next = (rejectCounts.get(stateName) ?? 0) + 1;
    rejectCounts.set(stateName, next);
    if (next >= cap) {
      return parkAtRejectCap(currentRun, stateName, now());
    }
    currentRun = await rerunActivity(currentRun, decision.feedback);
  }
}

// SPEC §Interactive mode: cap → waiting_user + inbox item.
function parkAtRejectCap(run: WorkflowRunRecord, stateName: string, now: string): WorkflowRunRecord {
  const withInbox = appendRejectCapInbox(run, stateName, now);
  if (withInbox.status === "waiting_user") return withInbox;
  return { ...withInbox, status: "waiting_user" };
}

function rejectCapFor(profile: TychonicConfig): number {
  const policy = profile.policies?.interaction;
  if (policy?.mode !== "interactive") {
    return Number.POSITIVE_INFINITY;
  }
  return policy.max_reject_iterations ?? INTERACTION_DEFAULT_MAX_REJECT_ITERATIONS;
}

function appendRejectCapInbox(run: WorkflowRunRecord, stateName: string, createdAt: string): WorkflowRunRecord {
  return {
    ...run,
    inbox: [
      ...run.inbox,
      {
        id: nextSequentialId("inbox", run.inbox.map((item) => item.id)),
        status: "open",
        title: "Interactive reject limit reached",
        detail: `state '${stateName}' reached the interactive reject iteration cap`,
        action: { kind: "triage", reason: `interactive reject cap for state '${stateName}'` },
        created_at: createdAt
      }
    ]
  };
}

function assertNameType(profile: TychonicConfig, name: string, expectedType: ActivityType): void {
  const block = profile.states?.[name];
  if (block && block.type !== expectedType) {
    throw new Error(`state '${name}' must have type '${expectedType}', got '${block.type}'`);
  }
}

async function runOrSkipDeterministic(
  run: WorkflowRunRecord,
  name: "lint" | "unit_test",
  autonomy: "observe" | "check" | "review",
  input: CheckpointWorkflowInput,
  profile: TychonicConfig,
  now: () => string,
  activity: typeof runLintActivity | typeof runUnitTestActivity,
  rejectCounts: Map<string, number>
): Promise<WorkflowRunRecord> {
  const block = profile.states?.[name];
  const decision = shouldRunDeterministicCommand(autonomy, !block, factsForRun(run), name);
  if (!decision.run) {
    const skipped = skippedState({
      id: nextStateId(run),
      stateName: name,
      reason: decision.skipReason ?? "skipped",
      now: now()
    });
    let nextRun: WorkflowRunRecord = { ...run, states: [...run.states, skipped] };
    // Skip decisions still go through the interactive gate so an
    // external caller can override a skip via modifyState (SPEC Edit 4,
    // "skipped states also go through the gate with the state name used
    // for the skip entry").
    nextRun = await gateDecisionForCheckpoint(
      nextRun,
      name,
      rejectCounts,
      profile,
      now,
      async (currentRun, _feedback) => currentRun
    );
    return nextRun;
  }
  const runActivityOnce = async (currentRun: WorkflowRunRecord, _feedback?: string): Promise<WorkflowRunRecord> => {
    const result = await activity({
      stateName: name,
      run: currentRun,
      cwd: input.cwd,
      profile,
      extras: {}
    });
    return applyActivityResult(currentRun, result);
  };
  let nextRun = await runActivityOnce(run);
  nextRun = await gateDecisionForCheckpoint(nextRun, name, rejectCounts, profile, now, runActivityOnce);
  return nextRun;
}

async function runIntegration(
  run: WorkflowRunRecord,
  autonomy: "observe" | "check" | "review",
  input: CheckpointWorkflowInput,
  profile: TychonicConfig,
  now: () => string,
  rejectCounts: Map<string, number>
): Promise<WorkflowRunRecord> {
  const block = profile.states?.integration;
  const policy = profile.policies?.integration;

  const gateSkip = async (nextRun: WorkflowRunRecord): Promise<WorkflowRunRecord> =>
    gateDecisionForCheckpoint(
      nextRun,
      "integration",
      rejectCounts,
      profile,
      now,
      async (current, _feedback) => current
    );

  if (autonomy === "observe") {
    const skipped = skippedState({
      id: nextStateId(run),
      stateName: "integration",
      reason: "autonomy observe does not run integration tests",
      now: now()
    });
    return gateSkip({ ...run, states: [...run.states, skipped] });
  }
  if (!block) {
    const skipped = skippedState({
      id: nextStateId(run),
      stateName: "integration",
      reason: "integration command is not configured",
      now: now()
    });
    return gateSkip({ ...run, states: [...run.states, skipped] });
  }
  if (!policy || policy.mode === "disabled") {
    const skipped = skippedState({
      id: nextStateId(run),
      stateName: "integration",
      reason: "integration tests are disabled by policy",
      now: now()
    });
    return gateSkip({ ...run, states: [...run.states, skipped] });
  }
  if (policy.mode === "manual") {
    const blocked: WorkflowStateRecord = {
      id: nextStateId(run),
      name: "integration",
      status: "blocked",
      reason: "integration mode is manual",
      activity_attempt_ids: [],
      artifact_ids: [],
      finding_ids: [],
      started_at: now(),
      finished_at: now()
    };
    const inboxId = `inbox_manual_${blocked.id}`;
    const withBlocked: WorkflowRunRecord = {
      ...run,
      states: [...run.states, blocked],
      inbox: [
        ...run.inbox,
        {
          id: inboxId,
          status: "open",
          title: "Manual integration approval required",
          detail: `Integration command is configured for ${policy.position}: ${block.command ?? "(no command)"}`,
          action: { kind: "manual_approval", reason: "integration mode is manual" },
          created_at: now()
        }
      ]
    };
    return gateSkip(withBlocked);
  }
  if (hasFailedOrTimedOutState(run)) {
    const skipped = skippedState({
      id: nextStateId(run),
      stateName: "integration",
      reason: "previous required state failed",
      now: now()
    });
    return gateSkip({ ...run, states: [...run.states, skipped] });
  }
  const runActivityOnce = async (currentRun: WorkflowRunRecord, _feedback?: string): Promise<WorkflowRunRecord> => {
    const result = await runIntegrationActivity({
      stateName: "integration",
      run: currentRun,
      cwd: input.cwd,
      profile,
      extras: {}
    });
    return applyActivityResult(currentRun, result);
  };
  let nextRun = await runActivityOnce(run);
  nextRun = await gateDecisionForCheckpoint(nextRun, "integration", rejectCounts, profile, now, runActivityOnce);
  return nextRun;
}

async function runOrSkipReview(
  run: WorkflowRunRecord,
  name: "semantic_review" | "test_review",
  autonomy: "observe" | "check" | "review",
  input: CheckpointWorkflowInput,
  profile: TychonicConfig,
  now: () => string,
  decide: (
    autonomy: "observe" | "check" | "review",
    blockMissing: boolean,
    failedEarlier: boolean,
    facts: ReturnType<typeof factsForRun>
  ) => { run: boolean; skipReason?: string },
  prompt: string,
  rejectCounts: Map<string, number>
): Promise<WorkflowRunRecord> {
  const block = profile.states?.[name];
  const decision = decide(autonomy, !block, hasFailedOrTimedOutState(run), factsForRun(run));
  if (!decision.run) {
    const skipped = skippedState({
      id: nextStateId(run),
      stateName: name,
      reason: decision.skipReason ?? "skipped",
      now: now()
    });
    let nextRun: WorkflowRunRecord = { ...run, states: [...run.states, skipped] };
    nextRun = await gateDecisionForCheckpoint(
      nextRun,
      name,
      rejectCounts,
      profile,
      now,
      async (current, _feedback) => current
    );
    return nextRun;
  }
  const runActivityOnce = async (currentRun: WorkflowRunRecord, _feedback?: string): Promise<WorkflowRunRecord> => {
    const result = await runReviewActivity({
      stateName: name,
      run: currentRun,
      cwd: input.cwd,
      profile,
      extras: { prompt }
    });
    return applyActivityResult(currentRun, result);
  };
  let nextRun = await runActivityOnce(run);
  nextRun = await gateDecisionForCheckpoint(nextRun, name, rejectCounts, profile, now, runActivityOnce);
  return nextRun;
}

function nextStateId(run: WorkflowRunRecord): string {
  return nextSequentialId(
    "state",
    run.states.map((state) => state.id)
  );
}
