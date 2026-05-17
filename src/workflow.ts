import { defineQuery, setHandler, workflowInfo } from "@temporalio/workflow";
import type { TychonicConfig } from "./catalog/types.js";
import type {
  DecisionInboxItemRecord,
  AttemptKind,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStateStatus,
  WorkflowStateRecord
} from "./domain/types.js";
import type { ActivityInput, ActivityResult } from "./temporal/types.js";
import { tychonicWorkflowStateQueryName } from "./temporal/types.js";
import {
  applyApprovalDecision,
  drainStraySignals,
  effectiveInteractionMode,
  registerInteractionSignals,
  rejectCapInboxItem,
  resolveRejectCap,
  setInteractionPolicy,
  strayInteractionSignalInboxItem,
  waitForStateApproval,
  waitForStateRecovery,
  type ApprovalDecision,
  type PolicyInteraction,
  type StraySignal
} from "./workflows/interactionHook.js";
import {
  addRunInboxItem,
  applyActivityResult,
  latestStateByName,
  nextRunLocalId
} from "./workflows/runMerge.js";

export {
  addRunInboxItem,
  applyActivityResult,
  latestStateByName,
  nextRunLocalId
} from "./workflows/runMerge.js";

export interface TychonicWorkflowResult {
  runId: string;
  status: WorkflowRunStatus;
  run: WorkflowRunRecord;
  artifactRoot: string;
  activeState?: WorkflowStateRecord;
  summary?: string;
  worktreePath?: string;
}

export interface TychonicRunStateSnapshotFields {
  artifactRoot?: string;
  activeState?: WorkflowStateRecord;
  summary?: string;
  worktreePath?: string;
}

export interface TychonicRunState {
  update(run: WorkflowRunRecord, fields?: TychonicRunStateSnapshotFields): WorkflowRunRecord;
  result(run: WorkflowRunRecord, fields?: TychonicRunStateSnapshotFields): TychonicWorkflowResult;
  current(): TychonicWorkflowResult | undefined;
}

export interface TychonicInteraction {
  mode(): "auto" | "interactive";
  rejectCap(): number;
  waitForStateApproval(stateName: string): Promise<ApprovalDecision>;
  waitForStateRecovery(stateName: string): Promise<ApprovalDecision>;
  applyApprovalDecision(
    run: WorkflowRunRecord,
    stateName: string,
    decision: ApprovalDecision
  ): WorkflowRunRecord;
  drainStraySignals(): StraySignal[];
  rejectCapInboxItem: typeof rejectCapInboxItem;
  strayInteractionSignalInboxItem: typeof strayInteractionSignalInboxItem;
}

export type {
  TychonicWorkflowRuntimeInput,
  TaskWorkflowInputContract
} from "./inputValidation.js";
export { validateTaskWorkflowInput, derivePromptableStates } from "./inputValidation.js";
import { validateTaskWorkflowInput } from "./inputValidation.js";
import type { TychonicWorkflowRuntimeInput, TaskWorkflowInputContract } from "./inputValidation.js";

export function reviewFailReturnTarget(
  profile: TychonicConfig | undefined,
  reviewStateName: string
): string {
  const block = profile?.states?.[reviewStateName];
  if (block === undefined) {
    throw new Error(`review state '${reviewStateName}' is missing from effective profile.states`);
  }
  if (block.type !== "review") {
    throw new Error(`state '${reviewStateName}' must have type 'review' to declare on_fail_return_to`);
  }
  if (block.on_fail_return_to === undefined) {
    throw new Error(`review state '${reviewStateName}' must declare on_fail_return_to`);
  }
  const target = profile?.states?.[block.on_fail_return_to];
  if (target === undefined) {
    throw new Error(
      `review state '${reviewStateName}' declares on_fail_return_to '${block.on_fail_return_to}', but that state is missing`
    );
  }
  if (target.type === "review") {
    throw new Error(
      `review state '${reviewStateName}' declares on_fail_return_to '${block.on_fail_return_to}', but failed review feedback must return to a non-review state`
    );
  }
  return block.on_fail_return_to;
}

export function assertReviewFailReturnTo(
  profile: TychonicConfig | undefined,
  reviewStateName: string,
  expectedReturnTo: string
): string {
  const actual = reviewFailReturnTarget(profile, reviewStateName);
  if (actual !== expectedReturnTo) {
    throw new Error(
      `review state '${reviewStateName}' declares on_fail_return_to '${actual}', ` +
      `but this workflow routes failed review feedback to '${expectedReturnTo}'`
    );
  }
  return actual;
}

export interface TychonicWorkflowRuntimeActivities {
  startRunActivity(input: {
    template: string;
    cwd: string;
    profile?: TychonicConfig;
    goal?: string;
  }): Promise<WorkflowRunRecord>;
  createWorktreeActivity?(input: {
    run: WorkflowRunRecord;
    cwd: string;
  }): Promise<{ worktreePath: string; worktreeParentDir: string; baseHead: string }>;
  extractWorktreePatchActivity?(input: {
    run: WorkflowRunRecord;
    cwd: string;
    worktreePath: string;
    worktreeParentDir: string;
    baseHead: string;
  }): Promise<ActivityResult & { extracted: true }>;
  runWorkerActivity?(input: Omit<ActivityInput<"work">, "profile"> & { profile?: TychonicConfig }): Promise<ActivityResult>;
  runVerifyActivity?(input: Omit<ActivityInput<"verify">, "profile"> & { profile?: TychonicConfig }): Promise<ActivityResult>;
  runReviewActivity?(input: Omit<ActivityInput<"review">, "profile"> & { profile?: TychonicConfig }): Promise<ActivityResult>;
  finalizeRunActivity(input: { run: WorkflowRunRecord; summary?: string }): Promise<ActivityResult>;
}

type TychonicAgentActivity = (input: {
  stateName: string;
  run: WorkflowRunRecord;
  cwd: string;
  profile?: TychonicConfig;
  worktreePath?: string;
  prompt?: string;
}) => Promise<ActivityResult>;

export interface TychonicStateRunResult {
  run: WorkflowRunRecord;
  state?: WorkflowStateRecord;
  activityResult?: ActivityResult;
  halted: boolean;
  passed: boolean;
  reason?: string;
  summary?: string;
}

export interface TychonicWorkflowContext {
  workflowId(): string;
  run(): WorkflowRunRecord;
  worktreePath(): string | undefined;
  isInteractive(): boolean;
  update(run: WorkflowRunRecord): WorkflowRunRecord;
  apply(result: ActivityResult): WorkflowRunRecord;
  start(): Promise<WorkflowRunRecord>;
  createWorktree(): Promise<string>;
  work(stateName: string, prompt: string): Promise<TychonicStateRunResult>;
  verify(stateName: string): Promise<TychonicStateRunResult>;
  review(stateName: string, prompt: string): Promise<TychonicStateRunResult>;
  latestState(stateName: string): WorkflowStateRecord | undefined;
  addInboxItem(item: DecisionInboxItemRecord): WorkflowRunRecord;
  finish(summary?: string): Promise<TychonicWorkflowResult>;
  finishWaitingUser(summary: string, item: DecisionInboxItemRecord): Promise<TychonicWorkflowResult>;
}

export function createTychonicRunState(): TychonicRunState {
  let latest: TychonicWorkflowResult | undefined;
  const query = defineQuery<TychonicWorkflowResult | undefined>(tychonicWorkflowStateQueryName);
  setHandler(query, () => latest);

  return {
    update(run, fields) {
      latest = toWorkflowResult(run, fields);
      return run;
    },
    result(run, fields) {
      latest = toWorkflowResult(run, fields);
      return latest;
    },
    current() {
      return latest;
    }
  };
}

export function createTychonicInteraction(policy?: PolicyInteraction): TychonicInteraction {
  registerInteractionSignals();
  setInteractionPolicy(policy);
  return {
    mode: effectiveInteractionMode,
    rejectCap: resolveRejectCap,
    waitForStateApproval,
    waitForStateRecovery,
    applyApprovalDecision,
    drainStraySignals,
    rejectCapInboxItem,
    strayInteractionSignalInboxItem
  };
}

export function createTychonicWorkflowContext(options: {
  input: TychonicWorkflowRuntimeInput;
  template: string;
  activities: TychonicWorkflowRuntimeActivities;
  interactionPolicy?: PolicyInteraction;
}): TychonicWorkflowContext {
  const { input, template, activities } = options;
  validateTaskWorkflowInput(input);
  const runState = createTychonicRunState();
  const interaction = createTychonicInteraction(
    options.interactionPolicy ?? (input.profile?.policies?.interaction as PolicyInteraction | undefined)
  );
  const rejectCounts = new Map<string, number>();
  let currentRun: WorkflowRunRecord | undefined;
  let currentWorktreePath: string | undefined;
  let currentWorktreeParentDir: string | undefined;
  let currentWorktreeBaseHead: string | undefined;

  function requireRun(): WorkflowRunRecord {
    if (!currentRun) {
      throw new Error("Tychonic workflow context has no run yet; call start() first");
    }
    return currentRun;
  }

  function update(run: WorkflowRunRecord): WorkflowRunRecord {
    currentRun = run;
    return runState.update(run, currentWorktreePath ? { worktreePath: currentWorktreePath } : {});
  }

  function publishActiveState(stateName: string, kind: "work" | "verify" | "review"): void {
    const timestamp = nowIso();
    runState.update(requireRun(), {
      ...(currentWorktreePath ? { worktreePath: currentWorktreePath } : {}),
      activeState: {
        id: `active_${stateName}`,
        name: stateName,
        status: "running",
        reason: `running ${kind} state '${stateName}'`,
        activity_attempt_ids: [],
        artifact_ids: [],
        finding_ids: [],
        started_at: timestamp
      }
    });
  }

  async function runAgentState(
    stateName: string,
    activity: TychonicAgentActivity,
    basePrompt: string,
    kind: "work" | "review"
  ): Promise<TychonicStateRunResult> {
    const feedbacks: string[] = [];
    let lastActivityResult: ActivityResult | undefined;
    while (true) {
      const promptBase = promptWithAddition(basePrompt, input, stateName);
      const prompt = feedbacks.length > 0
        ? `${promptBase}\n\n[reviewer feedback from previous attempts]\n${feedbacks
            .map((feedback, index) => `${index + 1}. ${feedback}`)
            .join("\n")}\n[/reviewer feedback]`
        : promptBase;

      let result: ActivityResult;
      try {
        publishActiveState(stateName, kind);
        result = await activity({
          stateName,
          run: requireRun(),
          cwd: input.cwd,
          ...(input.profile ? { profile: input.profile } : {}),
          ...(currentWorktreePath ? { worktreePath: currentWorktreePath } : {}),
          prompt
        });
      } catch (error) {
        result = recoverableActivityFailureResult({
          run: requireRun(),
          stateName,
          kind,
          cwd: currentWorktreePath ?? input.cwd,
          error
        });
        lastActivityResult = result;
        update(applyActivityResult(requireRun(), result));
        const recovery = await waitForRecoverableStateDecision(stateName);
        if (recovery === "rerun") {
          continue;
        }
        if (recovery.kind === "reject") {
          feedbacks.push(recovery.feedback);
          continue;
        }
        return recovery.result;
      }
      lastActivityResult = result;
      update(applyActivityResult(requireRun(), result));

      const recovery = await maybeWaitForRecoverableActivityResult(stateName, result);
      if (recovery === "rerun") {
        continue;
      }
      if (recovery?.kind === "reject") {
        feedbacks.push(recovery.feedback);
        continue;
      }
      if (recovery?.kind === "result") {
        return recovery.result;
      }
      const stateAfterActivity = latestStateByName(requireRun(), stateName);
      if (stateAfterActivity?.status === "blocked") {
        return stateResult(stateName, true, stateAfterActivity.reason, lastActivityResult);
      }

      if (interaction.mode() === "interactive") {
        update({ ...requireRun(), status: "waiting_user" });
      }
      const decision = await interaction.waitForStateApproval(stateName);
      if (decision.kind === "approve") {
        update({ ...requireRun(), status: "running" });
        return stateResult(stateName, false, undefined, lastActivityResult);
      }
      if (decision.kind === "modify") {
        const patched = interaction.applyApprovalDecision(requireRun(), stateName, decision);
        update({ ...patched, status: "running" });
        return stateResult(stateName, false, undefined, lastActivityResult);
      }
      if (decision.kind === "rerun") {
        update({ ...requireRun(), status: "running" });
        continue;
      }

      const nextCount = (rejectCounts.get(stateName) ?? 0) + 1;
      rejectCounts.set(stateName, nextCount);
      if (nextCount >= interaction.rejectCap()) {
        const run = addRunInboxItem(
          requireRun(),
          interaction.rejectCapInboxItem(stateName, {
            id: `inbox_reject_cap_${stateName}`,
            createdAt: nowIso()
          })
        );
        update({ ...run, status: "waiting_user" });
        return stateResult(stateName, true, `${stateName} reached reject cap`, lastActivityResult);
      }
      update({ ...requireRun(), status: "running" });
      feedbacks.push(decision.feedback);
    }
  }

  async function maybeWaitForRecoverableActivityResult(
    stateName: string,
    result: ActivityResult
  ): Promise<"rerun" | { kind: "reject"; feedback: string } | { kind: "result"; result: TychonicStateRunResult } | undefined> {
    const state = latestStateByName(requireRun(), stateName);
    if (!state || state.status === "succeeded") {
      return undefined;
    }
    if (!isRecoverableActivityResult(result, state.status)) {
      return undefined;
    }
    return waitForRecoverableStateDecision(stateName);
  }

  async function waitForRecoverableStateDecision(
    stateName: string
  ): Promise<"rerun" | { kind: "reject"; feedback: string } | { kind: "result"; result: TychonicStateRunResult }> {
    update({ ...requireRun(), status: "waiting_user" });
    const decision = await interaction.waitForStateRecovery(stateName);
    if (decision.kind === "rerun") {
      update({ ...requireRun(), status: "running" });
      return "rerun";
    }
    if (decision.kind === "reject") {
      update({ ...requireRun(), status: "running" });
      return { kind: "reject", feedback: decision.feedback };
    }
    if (decision.kind === "modify") {
      const patched = interaction.applyApprovalDecision(requireRun(), stateName, decision);
      update({ ...patched, status: "running" });
      return { kind: "result", result: stateResult(stateName, false) };
    }
    update({ ...requireRun(), status: "running" });
    return { kind: "result", result: stateResult(stateName, false) };
  }

  function stateResult(
    stateName: string,
    halted: boolean,
    summary?: string,
    activityResult?: ActivityResult
  ): TychonicStateRunResult {
    const run = requireRun();
    const state = latestStateByName(run, stateName);
    return {
      run,
      ...(state ? { state } : {}),
      ...(activityResult ? { activityResult } : {}),
      halted,
      passed: state?.status === "succeeded",
      ...(state?.reason !== undefined ? { reason: state.reason } : {}),
      ...(summary !== undefined ? { summary } : {})
    };
  }

  async function finish(summary?: string): Promise<TychonicWorkflowResult> {
    let run = requireRun();
    const straySignals = interaction.drainStraySignals();
    straySignals.forEach((entry, index) => {
      run = addRunInboxItem(
        run,
        interaction.strayInteractionSignalInboxItem(entry, {
          id: `inbox_stray_${entry.kind}_${entry.state}_${index}`,
          createdAt: nowIso()
        })
      );
    });
    currentRun = run;
    const result = await activities.finalizeRunActivity({
      run: requireRun(),
      ...(summary !== undefined ? { summary } : {})
    });
    const finalizedRun = applyActivityResult(requireRun(), result);
    const extractWorktreePath = currentWorktreePath;
    if (extractWorktreePath) {
      if (!activities.extractWorktreePatchActivity) {
        throw new Error("extractWorktreePatchActivity is required after ctx.createWorktree()");
      }
      if (!currentWorktreeBaseHead) {
        throw new Error("internal error: extract worktree baseHead is missing");
      }
      if (!currentWorktreeParentDir) {
        throw new Error("internal error: extract worktree parent dir is missing");
      }
      const extractWorktreeParentDir = currentWorktreeParentDir;
      const extractActivityResult = await activities.extractWorktreePatchActivity({
        run: finalizedRun,
        cwd: input.cwd,
        worktreePath: extractWorktreePath,
        worktreeParentDir: extractWorktreeParentDir,
        baseHead: currentWorktreeBaseHead
      });
      update(applyActivityResult(finalizedRun, extractActivityResult));
    } else {
      update(finalizedRun);
    }
    return runState.result(requireRun(), {
      artifactRoot: artifactRootForRun(requireRun()),
      ...(currentWorktreePath ? { worktreePath: currentWorktreePath } : {})
    });
  }

  async function finishWaitingUser(
    summary: string,
    item: DecisionInboxItemRecord
  ): Promise<TychonicWorkflowResult> {
    let run = requireRun();
    run = addRunInboxItem(run, item);
    currentRun = { ...run, status: "waiting_user" };
    return finish(summary);
  }

  return {
    workflowId: () => workflowInfo().workflowId,
    run: requireRun,
    worktreePath: () => currentWorktreePath,
    isInteractive: () => interaction.mode() === "interactive",
    update,
    apply(result) {
      return update(applyActivityResult(requireRun(), result));
    },
    async start() {
      const run = await activities.startRunActivity({
        template,
        cwd: input.cwd,
        ...(input.profile ? { profile: input.profile } : {}),
        ...(input.goal !== undefined ? { goal: input.goal } : {})
      });
      return update({ ...run, status: "running" });
    },
    async createWorktree() {
      if (!activities.createWorktreeActivity) {
        throw new Error("createWorktreeActivity is required to call ctx.createWorktree()");
      }
      const wt = await activities.createWorktreeActivity({ run: requireRun(), cwd: input.cwd });
      currentWorktreePath = wt.worktreePath;
      currentWorktreeParentDir = wt.worktreeParentDir;
      currentWorktreeBaseHead = wt.baseHead;
      update(requireRun());
      return currentWorktreePath;
    },
    work(stateName, prompt) {
      if (!activities.runWorkerActivity) {
        throw new Error("runWorkerActivity is required to call ctx.work()");
      }
      return runAgentState(stateName, activities.runWorkerActivity, prompt, "work");
    },
    async verify(stateName) {
      if (!activities.runVerifyActivity) {
        throw new Error("runVerifyActivity is required to call ctx.verify()");
      }
      while (true) {
        let result: ActivityResult;
        try {
          publishActiveState(stateName, "verify");
          result = await activities.runVerifyActivity({
            stateName,
            run: requireRun(),
            cwd: input.cwd,
            ...(input.profile ? { profile: input.profile } : {}),
            ...(currentWorktreePath ? { worktreePath: currentWorktreePath } : {})
          });
        } catch (error) {
          result = recoverableActivityFailureResult({
            run: requireRun(),
            stateName,
            kind: "verify",
            cwd: currentWorktreePath ?? input.cwd,
            error
          });
          update(applyActivityResult(requireRun(), result));
          const recovery = await waitForRecoverableStateDecision(stateName);
          if (recovery === "rerun" || recovery.kind === "reject") {
            continue;
          }
          return recovery.result;
        }
        update(applyActivityResult(requireRun(), result));
        const recovery = await maybeWaitForRecoverableActivityResult(stateName, result);
        if (recovery === "rerun" || recovery?.kind === "reject") {
          continue;
        }
        if (recovery?.kind === "result") {
          return recovery.result;
        }
        return stateResult(stateName, false, undefined, result);
      }
    },
    review(stateName, prompt) {
      if (!activities.runReviewActivity) {
        throw new Error("runReviewActivity is required to call ctx.review()");
      }
      return runAgentState(stateName, activities.runReviewActivity, prompt, "review");
    },
    latestState(stateName) {
      return latestStateByName(requireRun(), stateName);
    },
    addInboxItem(item) {
      return update(addRunInboxItem(requireRun(), item));
    },
    finish,
    finishWaitingUser
  };
}

export function promptWithAddition(
  basePrompt: string,
  input: Pick<TychonicWorkflowRuntimeInput, "promptAdditions">,
  stateName: string
): string {
  const addition = input.promptAdditions?.[stateName];
  if (addition === undefined) return basePrompt;
  return `${basePrompt}\n\n[operator additional instructions for ${stateName}]\n${addition}\n[/operator additional instructions]`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecoverableActivityResult(
  result: ActivityResult,
  status: WorkflowStateStatus
): boolean {
  if (status !== "failed" && status !== "timed_out" && status !== "blocked") {
    return false;
  }
  return result.recoverableFailure?.kind === "activity_exception";
}

export function recoverableActivityFailureResult(options: {
  run: WorkflowRunRecord;
  stateName: string;
  kind: "work" | "verify" | "review";
  cwd: string;
  error: unknown;
}): ActivityResult {
  const { run, stateName, kind, cwd, error } = options;
  const status = classifyActivityFailureStatus(error);
  const stateId = nextRunLocalId(run, "state");
  const attemptId = nextRunLocalId(run, "attempt");
  const timestamp = nowIso();
  const reason = `activity '${stateName}' failed before returning a Tychonic result; rerun is available after the external issue is resolved`;
  return {
    delta: {
      states: [
        {
          id: stateId,
          name: stateName,
          status,
          reason,
          activity_attempt_ids: [attemptId],
          artifact_ids: [],
          finding_ids: [],
          started_at: timestamp,
          finished_at: timestamp
        }
      ],
      activityAttempts: [
        {
          id: attemptId,
          state_id: stateId,
          kind: attemptKindForRecoverableFailure(kind),
          status,
          reason,
          cwd,
          error: errorMessage(error),
          started_at: timestamp,
          finished_at: timestamp
        }
      ]
    },
    recoverableFailure: { kind: "activity_exception" }
  };
}

function attemptKindForRecoverableFailure(kind: "work" | "verify" | "review"): AttemptKind {
  if (kind === "verify") return "deterministic_command";
  if (kind === "review") return "semantic_review";
  return "work";
}

function classifyActivityFailureStatus(error: unknown): WorkflowStateStatus {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) {
    return "timed_out";
  }
  return "failed";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}


function toWorkflowResult(
  run: WorkflowRunRecord,
  fields: TychonicRunStateSnapshotFields = {}
): TychonicWorkflowResult {
  return {
    runId: run.id,
    status: run.status,
    run,
    artifactRoot: fields.artifactRoot ?? artifactRootForRun(run),
    ...(fields.activeState !== undefined ? { activeState: fields.activeState } : {}),
    ...(run.summary !== undefined ? { summary: run.summary } : {}),
    ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
    ...(fields.worktreePath !== undefined ? { worktreePath: fields.worktreePath } : {})
  };
}

function artifactRootForRun(run: WorkflowRunRecord): string {
  if (!run.artifact_root) {
    throw new Error("run.artifact_root is required");
  }
  return run.artifact_root;
}
