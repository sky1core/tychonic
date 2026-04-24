import type { TychonicConfig } from "../catalog/types.js";
import type { WorkflowRunRecord, WorkflowStateRecord, WorkflowRunStatus } from "../domain/types.js";
import type { ReviewFinding } from "../review/schema.js";
import type {
  ActivityResult,
  SelfRepairWorkflowInput,
  SelfRepairWorkflowResult
} from "../temporal/types.js";
import { applyActivityResult, applyModifyStateDecision } from "./runMerge.js";
import { createFindingRecord } from "./resumeLoop.js";
import { nextSequentialId } from "./checkpointPure.js";
import { applyWorkflowCommandTimeout } from "./commandTimeout.js";
import {
  drainStraySignals,
  effectiveInteractionMode,
  strayInteractionSignalInboxItem,
  waitForStateApproval,
  type ApprovalDecision
} from "./interactionHook.js";
import { INTERACTION_DEFAULT_MAX_REJECT_ITERATIONS } from "./interactionDefaults.js";

export const DEFAULT_SELF_REPAIR_WORKFLOW_MAX_ITERATIONS = 3;

interface StartRunResult extends WorkflowRunRecord {}

export interface SelfRepairWorkflowActivities {
  startRunActivity(input: {
    template: string;
    cwd: string;
    profile?: TychonicConfig;
    goal?: string;
    targetSessionId?: string;
    runId?: string;
  }): Promise<StartRunResult>;
  createWorktreeActivity(input: {
    run: WorkflowRunRecord;
    cwd: string;
  }): Promise<{
    worktreePath: string;
    mode: "git_worktree" | "directory_copy_no_head";
    reason: string;
  }>;
  runWorkerActivity(input: {
    stateName: string;
    run: WorkflowRunRecord;
    profile: TychonicConfig;
    cwd: string;
    extras: {
      prompt?: string;
      goal?: string;
      worktreePath?: string;
      command?: string;
    };
  }): Promise<ActivityResult>;
  runReviewActivity(input: {
    stateName: string;
    run: WorkflowRunRecord;
    profile: TychonicConfig;
    cwd: string;
    extras: {
      prompt?: string;
      worktreePath?: string;
    };
  }): Promise<ActivityResult>;
  runVerifyActivity(input: {
    stateName: string;
    run: WorkflowRunRecord;
    profile: TychonicConfig;
    cwd: string;
    extras: {
      worktreePath?: string;
      command?: string;
    };
  }): Promise<ActivityResult>;
  finalizeRunActivity(input: {
    run: WorkflowRunRecord;
    summary?: string;
  }): Promise<ActivityResult>;
}

export interface SelfRepairWorkflowHooks {
  onUpdate?(result: SelfRepairWorkflowResult): void;
}

type ReviewStepDecision =
  | { kind: "pass"; run: WorkflowRunRecord }
  | { kind: "fail"; run: WorkflowRunRecord; findings: ReviewFinding[]; findingIds: string[] }
  | { kind: "waiting_user"; run: WorkflowRunRecord; detail: string }
  | { kind: "command_failed"; run: WorkflowRunRecord };

export async function runSelfRepairWorkflowLoop(
  input: SelfRepairWorkflowInput,
  activities: SelfRepairWorkflowActivities,
  hooks: SelfRepairWorkflowHooks = {}
): Promise<SelfRepairWorkflowResult> {
  const profile = applyWorkflowCommandTimeout(
    input.profile,
    input.commandTimeoutMs,
    [
      "detect_bugs",
      "write_regression_tests",
      "review_regression_tests",
      "fix_bugs",
      "verify",
      "final_review"
    ]
  );
  assertSelfRepairConfig(profile);

  let run = await activities.startRunActivity({
    template: "self_repair_workflow",
    cwd: input.cwd,
    profile,
    ...(input.goal ? { goal: input.goal } : {}),
    ...(input.targetSessionId ? { targetSessionId: input.targetSessionId } : {}),
    ...(input.runId ? { runId: input.runId } : {})
  });
  run = { ...run, status: "running" };

  const worktree = await activities.createWorktreeActivity({ run, cwd: input.cwd });
  run = appendCreateWorktreeState(run, worktree.reason);
  let latest = resultSnapshot(run, input.cwd, worktree.worktreePath);
  hooks.onUpdate?.(latest);
  // Gate on the worktree-creation state. Reject here is a caller error
  // (the workflow cannot re-run worktree creation inside the same run),
  // so the gate simply records the signal and moves on; modify replaces
  // the synthetic state record the workflow appended for visibility.
  {
    const decision = await waitForStateApproval("create_isolated_worktree");
    if (decision.kind === "modify") {
      run = applyModifyStateDecision(run, "create_isolated_worktree", decision.patch);
    } else if (decision.kind === "reject") {
      run = appendWorkflowInbox(
        run,
        "Interactive reject on worktree creation",
        `external caller rejected create_isolated_worktree with feedback: ${decision.feedback}`
      );
    }
    latest = resultSnapshot(run, input.cwd, worktree.worktreePath);
    hooks.onUpdate?.(latest);
  }

  const rejectCounts = new Map<string, number>();
  const interactionCap =
    profile.policies?.interaction?.mode === "interactive"
      ? profile.policies.interaction.max_reject_iterations ?? INTERACTION_DEFAULT_MAX_REJECT_ITERATIONS
      : Number.POSITIVE_INFINITY;
  // Gate helper: auto mode returns immediately (no history event).
  // Interactive mode suspends on the hook's `condition()`. A reject
  // bumps the per-state counter and lets the outer detect/fix loop
  // re-iterate with the accumulated findings; it does not re-run the
  // just-finished activity in place. Cap adds an inbox item so the run
  // surfaces as waiting_user.
  //
  // SPEC §Workflow Loop Semantics / spec-diff Edit 4 allow each
  // workflow to choose its reject-incorporation strategy; self_repair
  // already owns a richer outer loop, so reject feeds the existing
  // loop rather than a local re-execution.
  const parkAtCap = (currentRun: WorkflowRunRecord, stateName: string): WorkflowRunRecord => {
    let parked = appendWorkflowInbox(
      currentRun,
      "Interactive reject limit reached",
      `state '${stateName}' reached the interactive reject iteration cap`
    );
    if (parked.status !== "waiting_user") parked = { ...parked, status: "waiting_user" };
    return parked;
  };
  const gateReturn = async (
    currentRun: WorkflowRunRecord,
    stateName: string
  ): Promise<{ run: WorkflowRunRecord; rejected: boolean; feedback?: string }> => {
    if ((rejectCounts.get(stateName) ?? 0) >= interactionCap) {
      return { run: parkAtCap(currentRun, stateName), rejected: false };
    }
    const decision: ApprovalDecision = await waitForStateApproval(stateName);
    if (decision.kind === "approve") {
      return { run: currentRun, rejected: false };
    }
    if (decision.kind === "modify") {
      return {
        run: applyModifyStateDecision(currentRun, stateName, decision.patch),
        rejected: false
      };
    }
    const nextCount = (rejectCounts.get(stateName) ?? 0) + 1;
    rejectCounts.set(stateName, nextCount);
    if (nextCount >= interactionCap) {
      return { run: parkAtCap(currentRun, stateName), rejected: false };
    }
    return { run: currentRun, rejected: true, feedback: decision.feedback };
  };

  const maxDetectIterations = maxIterationsForProfile(profile);
  const maxFixIterations = maxDetectIterations;

  for (let detectIteration = 1; detectIteration <= maxDetectIterations; detectIteration += 1) {
    const detect = await runReviewStep({
      run,
      input,
      activities,
      profile,
      worktreePath: worktree.worktreePath,
      stateName: "detect_bugs",
      prompt: detectBugsPrompt({
        iteration: detectIteration,
        maxIterations: maxDetectIterations,
        ...(input.goal ? { goal: input.goal } : {})
      })
    });
    run = detect.run;
    latest = resultSnapshot(run, input.cwd, worktree.worktreePath);
    hooks.onUpdate?.(latest);

    // Gate the detect_bugs state. Approve/modify proceed; reject keeps
    // the detect_bugs verdict and advances to the fix iteration loop
    // carrying the interactive feedback as a synthetic finding so the
    // workflow-owned incorporation strategy can react.
    const detectGate = await gateReturn(run, "detect_bugs");
    run = detectGate.run;
    latest = resultSnapshot(run, input.cwd, worktree.worktreePath);
    hooks.onUpdate?.(latest);

    if (detect.kind === "waiting_user" || detect.kind === "command_failed") {
      return await finalizeSelfRepairWorkflowRun(run, input.cwd, worktree.worktreePath, activities);
    }

    if (detect.kind === "pass" && !detectGate.rejected) {
      return await finalizeSelfRepairWorkflowRun(run, input.cwd, worktree.worktreePath, activities);
    }

    const activeFindings: ReviewFinding[] = detect.kind === "fail" ? [...detect.findings] : [];
    const activeFindingIds: string[] = detect.kind === "fail" ? [...detect.findingIds] : [];
    if (detectGate.rejected && detectGate.feedback) {
      const overrideFinding: ReviewFinding = {
        severity: "medium",
        title: "Interactive reject override on detect_bugs",
        detail: detectGate.feedback,
        target: "detect_bugs"
      };
      const persisted = appendFindingRecords(run, latestStateId(run, "detect_bugs"), [overrideFinding]);
      run = persisted.run;
      activeFindings.push(overrideFinding);
      activeFindingIds.push(...persisted.findingIds);
    }
    let requiresRegressionTests = true;
    let bugSetResolved = false;

    for (let fixIteration = 1; fixIteration <= maxFixIterations; fixIteration += 1) {
      if (requiresRegressionTests) {
        const writeTests = await activities.runWorkerActivity({
          stateName: "write_regression_tests",
          run,
          cwd: input.cwd,
          profile,
          extras: {
            worktreePath: worktree.worktreePath,
            prompt: writeRegressionTestsPrompt({
              findings: activeFindings,
              ...(input.goal ? { goal: input.goal } : {})
            })
          }
        });
        run = applyActivityResult(run, writeTests);
        latest = resultSnapshot(run, input.cwd, worktree.worktreePath);
        hooks.onUpdate?.(latest);
        const writeTestsGate = await gateReturn(run, "write_regression_tests");
        run = writeTestsGate.run;
        latest = resultSnapshot(run, input.cwd, worktree.worktreePath);
        hooks.onUpdate?.(latest);
        if (isTerminalFailureStep(writeTests)) {
          run = appendFindingInboxItems(run, activeFindingIds, "self_repair_workflow stopped before regression tests were completed");
          return await finalizeSelfRepairWorkflowRun(run, input.cwd, worktree.worktreePath, activities);
        }

        const regressionReview = await runReviewStep({
          run,
          input,
          activities,
          profile,
          worktreePath: worktree.worktreePath,
          stateName: "review_regression_tests",
          prompt: reviewRegressionTestsPrompt({
            findings: activeFindings,
            ...(input.goal ? { goal: input.goal } : {})
          })
        });
        run = regressionReview.run;
        latest = resultSnapshot(run, input.cwd, worktree.worktreePath);
        hooks.onUpdate?.(latest);
        const regressionGate = await gateReturn(run, "review_regression_tests");
        run = regressionGate.run;
        latest = resultSnapshot(run, input.cwd, worktree.worktreePath);
        hooks.onUpdate?.(latest);
        if (regressionReview.kind === "waiting_user" || regressionReview.kind === "command_failed") {
          run = appendFindingInboxItems(run, activeFindingIds, "self_repair_workflow stopped during regression-test review");
          return await finalizeSelfRepairWorkflowRun(run, input.cwd, worktree.worktreePath, activities);
        }
        if (regressionReview.kind === "fail") {
          activeFindings.push(...regressionReview.findings);
          activeFindingIds.push(...regressionReview.findingIds);
          requiresRegressionTests = true;
          continue;
        }
      }

      const fixBugs = await activities.runWorkerActivity({
        stateName: "fix_bugs",
        run,
        cwd: input.cwd,
        profile,
        extras: {
          worktreePath: worktree.worktreePath,
          prompt: fixBugsPrompt({
            findings: activeFindings,
            ...(input.goal ? { goal: input.goal } : {})
          })
        }
      });
      run = applyActivityResult(run, fixBugs);
      latest = resultSnapshot(run, input.cwd, worktree.worktreePath);
      hooks.onUpdate?.(latest);
      const fixBugsGate = await gateReturn(run, "fix_bugs");
      run = fixBugsGate.run;
      latest = resultSnapshot(run, input.cwd, worktree.worktreePath);
      hooks.onUpdate?.(latest);
      if (isTerminalFailureStep(fixBugs)) {
        run = appendFindingInboxItems(run, activeFindingIds, "self_repair_workflow stopped before the fix step completed");
        return await finalizeSelfRepairWorkflowRun(run, input.cwd, worktree.worktreePath, activities);
      }

      const verify = await activities.runVerifyActivity({
        stateName: "verify",
        run,
        cwd: input.cwd,
        profile,
        extras: {
          worktreePath: worktree.worktreePath
        }
      });
      run = applyActivityResult(run, verify);
      latest = resultSnapshot(run, input.cwd, worktree.worktreePath);
      hooks.onUpdate?.(latest);
      const verifyGate = await gateReturn(run, "verify");
      run = verifyGate.run;
      latest = resultSnapshot(run, input.cwd, worktree.worktreePath);
      hooks.onUpdate?.(latest);
      if (isTerminalFailureStep(verify)) {
        const verifyFinding = verifyFailureFinding(run);
        const persisted = appendFindingRecords(run, latestStateId(run, "verify"), [verifyFinding]);
        run = persisted.run;
        activeFindingIds.push(...persisted.findingIds);
        activeFindings.push(verifyFinding);
        requiresRegressionTests = false;
        continue;
      }

      const finalReview = await runReviewStep({
        run,
        input,
        activities,
        profile,
        worktreePath: worktree.worktreePath,
        stateName: "final_review",
        prompt: finalReviewPrompt({
          findings: activeFindings,
          ...(input.goal ? { goal: input.goal } : {})
        })
      });
      run = finalReview.run;
      latest = resultSnapshot(run, input.cwd, worktree.worktreePath);
      hooks.onUpdate?.(latest);
      const finalReviewGate = await gateReturn(run, "final_review");
      run = finalReviewGate.run;
      latest = resultSnapshot(run, input.cwd, worktree.worktreePath);
      hooks.onUpdate?.(latest);
      if (finalReview.kind === "waiting_user" || finalReview.kind === "command_failed") {
        run = appendFindingInboxItems(run, activeFindingIds, "self_repair_workflow stopped during final review");
        return await finalizeSelfRepairWorkflowRun(run, input.cwd, worktree.worktreePath, activities);
      }
      if (finalReview.kind === "fail") {
        activeFindings.push(...finalReview.findings);
        activeFindingIds.push(...finalReview.findingIds);
        requiresRegressionTests = false;
        continue;
      }

      run = resolveFindings(run, activeFindingIds);
      latest = resultSnapshot(run, input.cwd, worktree.worktreePath);
      hooks.onUpdate?.(latest);
      bugSetResolved = true;
      break;
    }

    if (!bugSetResolved) {
      run = appendFindingInboxItems(run, activeFindingIds, "self_repair_workflow exhausted its fix budget");
      return await finalizeSelfRepairWorkflowRun(run, input.cwd, worktree.worktreePath, activities);
    }
  }

  run = appendWorkflowInbox(
    run,
    "self_repair_workflow exhausted its detect budget",
    "self_repair_workflow reached the maximum number of detect_bugs iterations before proving the worktree clean"
  );
  return await finalizeSelfRepairWorkflowRun(run, input.cwd, worktree.worktreePath, activities);
}

async function runReviewStep(input: {
  run: WorkflowRunRecord;
  activities: SelfRepairWorkflowActivities;
  profile: TychonicConfig;
  worktreePath: string;
  stateName: "detect_bugs" | "review_regression_tests" | "final_review";
  prompt: string;
  input: SelfRepairWorkflowInput;
}): Promise<ReviewStepDecision> {
  const result = await input.activities.runReviewActivity({
    stateName: input.stateName,
    run: input.run,
    cwd: input.input.cwd,
    profile: input.profile,
    extras: {
      prompt: input.prompt,
      worktreePath: input.worktreePath
    }
  });
  let run = applyActivityResult(input.run, result);
  const outcome = result.reviewOutcome;
  if (!outcome || outcome.kind === "skipped") {
    return { kind: "waiting_user", run: appendWorkflowInbox(run, `${input.stateName} requires triage`, "review step returned no structured outcome"), detail: "review step returned no structured outcome" };
  }
  if (outcome.kind === "command_failed") {
    return { kind: "command_failed", run };
  }
  if (outcome.kind === "unparseable") {
    run = appendWorkflowInbox(run, `${input.stateName} requires triage`, outcome.detail);
    return { kind: "waiting_user", run, detail: outcome.detail };
  }
  if (outcome.result.status === "fail") {
    const persisted = appendFindingRecords(
      run,
      result.delta.states?.[0]?.id,
      outcome.result.findings,
      outcome.reviewerSessionId
    );
    return { kind: "fail", run: persisted.run, findings: outcome.result.findings, findingIds: persisted.findingIds };
  }
  return { kind: "pass", run };
}

async function finalizeSelfRepairWorkflowRun(
  run: WorkflowRunRecord,
  cwd: string,
  worktreePath: string,
  activities: SelfRepairWorkflowActivities
): Promise<SelfRepairWorkflowResult> {
  let working = run;
  // Stray interaction signals (R-03). Only populated when interactive
  // mode was active; auto-mode callers never emit these signals.
  if (effectiveInteractionMode() === "interactive") {
    const strays = drainStraySignals();
    if (strays.length > 0) {
      const createdAt = new Date().toISOString();
      const nextInbox = [...working.inbox];
      for (const stray of strays) {
        nextInbox.push(
          strayInteractionSignalInboxItem(stray, {
            createdAt,
            id: nextSequentialId("inbox", nextInbox.map((item) => item.id))
          })
        );
      }
      working = { ...working, inbox: nextInbox };
    }
  }
  const finalized = await activities.finalizeRunActivity({
    run: working,
    summary: summarizeRun(working)
  });
  const finalRun = applyActivityResult(working, finalized);
  // Gate after finalizeRunActivity so external callers can still
  // signal approve/modify/reject against a `finalize_run` state. A
  // reject here is advisory only — the run has already been finalized.
  if (effectiveInteractionMode() === "interactive") {
    const decision = await waitForStateApproval("finalize_run");
    if (decision.kind === "modify") {
      // The finalize activity may not have produced a state record
      // named 'finalize_run'; swap only if one exists to avoid
      // throwing from applyModifyStateDecision.
      if (finalRun.states.some((state) => state.name === "finalize_run")) {
        const replaced = applyModifyStateDecision(finalRun, "finalize_run", decision.patch);
        return resultSnapshot(replaced, cwd, worktreePath);
      }
    }
  }
  return resultSnapshot(finalRun, cwd, worktreePath);
}

function resultSnapshot(
  run: WorkflowRunRecord,
  cwd: string,
  worktreePath: string
): SelfRepairWorkflowResult {
  return {
    runId: run.id,
    status: run.status,
    run,
    artifactRoot: `${cwd}/.tychonic/runs/${run.id}`,
    worktreePath,
    ...(run.summary ? { summary: run.summary } : {})
  };
}

function summarizeRun(run: WorkflowRunRecord): string {
  const latestStates = latestStatesByName(run);
  const succeeded = latestStates.filter((state) => state.status === "succeeded").length;
  const failed = latestStates.filter((state) => state.status === "failed").length;
  const blocked = latestStates.filter((state) => state.status === "blocked").length;
  const skipped = latestStates.filter((state) => state.status === "skipped").length;
  const parts: string[] = [];
  if (succeeded > 0) parts.push(`${succeeded} succeeded`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.length > 0 ? parts.join(", ") : "no states recorded";
}

function appendCreateWorktreeState(run: WorkflowRunRecord, reason: string): WorkflowRunRecord {
  const timestamp = new Date().toISOString();
  const state: WorkflowStateRecord = {
    id: nextSequentialId("state", run.states.map((item) => item.id)),
    name: "create_isolated_worktree",
    status: "succeeded",
    reason,
    activity_attempt_ids: [],
    artifact_ids: [],
    finding_ids: [],
    started_at: timestamp,
    finished_at: timestamp
  };
  return {
    ...run,
    states: [...run.states, state]
  };
}

function appendWorkflowInbox(run: WorkflowRunRecord, title: string, detail: string): WorkflowRunRecord {
  return {
    ...run,
    inbox: [
      ...run.inbox,
      {
        id: nextSequentialId("inbox", run.inbox.map((item) => item.id)),
        status: "open",
        title,
        detail,
        action: { kind: "triage", reason: detail },
        created_at: new Date().toISOString()
      }
    ]
  };
}

function appendFindingRecords(
  run: WorkflowRunRecord,
  sourceStateId: string | undefined,
  findings: ReviewFinding[],
  sourceReviewSessionId?: string
): { run: WorkflowRunRecord; findingIds: string[] } {
  if (!sourceStateId || findings.length === 0) {
    return { run, findingIds: [] };
  }

  const nextFindings = [...run.findings];
  const findingIds: string[] = [];
  for (const finding of findings) {
    const id = nextSequentialId("finding", nextFindings.map((item) => item.id));
    const record = createFindingRecord(
      sourceReviewSessionId
        ? {
            id,
            finding,
            sourceStateId,
            sourceReviewSessionId,
            createdAt: new Date().toISOString()
          }
        : {
            id,
            finding,
            sourceStateId,
            createdAt: new Date().toISOString()
          }
    );
    nextFindings.push(record);
    findingIds.push(id);
  }

  const nextStates = run.states.map((state) =>
    state.id === sourceStateId
      ? { ...state, finding_ids: [...state.finding_ids, ...findingIds] }
      : state
  );
  return { run: { ...run, states: nextStates, findings: nextFindings }, findingIds };
}

function resolveFindings(run: WorkflowRunRecord, findingIds: string[]): WorkflowRunRecord {
  if (findingIds.length === 0) {
    return run;
  }
  return {
    ...run,
    findings: run.findings.map((finding) =>
      findingIds.includes(finding.id) ? { ...finding, status: "fixed" } : finding
    ),
    inbox: run.inbox.map((item) =>
      item.status === "open" && item.finding_id && findingIds.includes(item.finding_id)
        ? { ...item, status: "resolved" }
        : item
    )
  };
}

function appendFindingInboxItems(run: WorkflowRunRecord, findingIds: string[], reason: string): WorkflowRunRecord {
  if (findingIds.length === 0) {
    return run;
  }

  const nextInbox = [...run.inbox];
  for (const findingId of findingIds) {
    const finding = run.findings.find((candidate) => candidate.id === findingId);
    if (!finding) {
      continue;
    }
    const existing = nextInbox.find((item) => item.finding_id === findingId);
    if (existing) {
      continue;
    }
    nextInbox.push({
      id: nextSequentialId("inbox", nextInbox.map((item) => item.id)),
      status: "open",
      title: `Triage finding: ${finding.title}`,
      detail: reason,
      finding_id: findingId,
      ...(finding.target_work_session_id ? { target_session_id: finding.target_work_session_id } : {}),
      action: { kind: "triage", reason },
      created_at: new Date().toISOString()
    });
  }

  return { ...run, inbox: nextInbox };
}

function latestStateId(run: WorkflowRunRecord, stateName: string): string | undefined {
  return [...run.states].reverse().find((state) => state.name === stateName)?.id;
}

function latestStatesByName(run: WorkflowRunRecord): WorkflowStateRecord[] {
  const latest = new Map<string, WorkflowStateRecord>();
  for (const state of run.states) {
    latest.set(state.name, state);
  }
  return [...latest.values()];
}

function isTerminalFailureStep(result: ActivityResult): boolean {
  return Boolean(result.delta.states?.some((state) => state.status === "failed" || state.status === "timed_out"));
}

function maxIterationsForProfile(profile: TychonicConfig): number {
  return profile.policies?.self_repair_workflow?.max_iterations ?? DEFAULT_SELF_REPAIR_WORKFLOW_MAX_ITERATIONS;
}

export function assertSelfRepairConfig(profile: TychonicConfig): void {
  assertStateType(profile, "detect_bugs", "review");
  assertStateType(profile, "write_regression_tests", "work");
  assertStateType(profile, "review_regression_tests", "review");
  assertStateType(profile, "fix_bugs", "work");
  assertStateType(profile, "verify", "verify");
  assertStateType(profile, "final_review", "review");
}

function assertStateType(profile: TychonicConfig, stateName: string, expectedType: string): void {
  const state = profile.states?.[stateName];
  if (!state) {
    throw new Error(`self_repair_workflow requires profile.states.${stateName} with type '${expectedType}'`);
  }
  if (state.type !== expectedType) {
    throw new Error(`self_repair_workflow state '${stateName}' must have type '${expectedType}', got '${state.type}'`);
  }
}

function detectBugsPrompt(input: {
  goal?: string;
  iteration: number;
  maxIterations: number;
}): string {
  return [
    input.goal ? `Goal: ${input.goal}` : "Goal: bootstrap hardening",
    `Iteration: ${input.iteration}/${input.maxIterations}`,
    "",
    "Review the isolated worktree for real, actionable bugs or regressions.",
    "Prioritize structural problems first: broken contracts, wrong workflow/state-machine behavior, misleading operator surface, naming/shape drift, missing invariants, or any root cause that would keep rediscovering the same class of bug.",
    "Prefer the underlying structural defect over listing several local symptoms when they collapse to one root cause.",
    "Only report local one-off defects after structural issues are exhausted.",
    "Focus on concrete product defects, broken behavior, missing required handling, or operator-facing workflow bugs.",
    "Return only one JSON object matching tychonic.review.v1.",
    "Use status pass only when there are no actionable bugs left to fix in this iteration."
  ].filter(Boolean).join("\n");
}

function writeRegressionTestsPrompt(input: {
  goal?: string;
  findings: ReviewFinding[];
}): string {
  return [
    input.goal ? `Goal: ${input.goal}` : "Goal: bootstrap hardening",
    "",
    "Add or update regression tests that demonstrate these bugs.",
    "Prefer changing tests only. Do not fix the production bug in this step unless a test cannot be written otherwise.",
    "The tests should fail against the buggy behavior and protect the intended fix.",
    "",
    "Target bugs:",
    formatFindings(input.findings)
  ].join("\n");
}

function reviewRegressionTestsPrompt(input: {
  goal?: string;
  findings: ReviewFinding[];
}): string {
  return [
    input.goal ? `Goal: ${input.goal}` : "Goal: bootstrap hardening",
    "",
    "Review the newly written regression tests.",
    "Fail when the tests do not actually protect the reported bug, are too weak, are flaky, or miss the intended regression surface.",
    "Return only one JSON object matching tychonic.review.v1.",
    "",
    "The tests are meant to cover these bugs:",
    formatFindings(input.findings)
  ].join("\n");
}

function fixBugsPrompt(input: {
  goal?: string;
  findings: ReviewFinding[];
}): string {
  return [
    input.goal ? `Goal: ${input.goal}` : "Goal: bootstrap hardening",
    "",
    "Fix the reported bugs in the isolated worktree.",
    "Preserve the regression tests and make them pass without broadening scope beyond these issues.",
    "",
    "Fix all of these findings:",
    formatFindings(input.findings)
  ].join("\n");
}

function finalReviewPrompt(input: {
  goal?: string;
  findings: ReviewFinding[];
}): string {
  return [
    input.goal ? `Goal: ${input.goal}` : "Goal: bootstrap hardening",
    "",
    "Review the current code and tests after the attempted fix.",
    "Fail when any actionable bug remains, the regression coverage is still weak, or the fix introduced a new problem.",
    "Return only one JSON object matching tychonic.review.v1.",
    "",
    "The iteration was trying to address these findings:",
    formatFindings(input.findings)
  ].join("\n");
}

function formatFindings(findings: ReviewFinding[]): string {
  if (findings.length === 0) {
    return "- no findings";
  }
  return findings
    .map((finding, index) =>
      [
        `${index + 1}. ${finding.title}`,
        `   Severity: ${finding.severity}`,
        `   Detail: ${finding.detail}`,
        `   Target: ${finding.target}`,
        finding.target_session_id ? `   Target session: ${finding.target_session_id}` : undefined
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");
}

function verifyFailureFinding(run: WorkflowRunRecord): ReviewFinding {
  const state = [...run.states].reverse().find((item) => item.name === "verify");
  return {
    severity: "high",
    title: "Verification command failed",
    detail: state?.reason ?? "verify state did not succeed",
    target: "verify"
  };
}
