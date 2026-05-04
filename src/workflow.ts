import { defineQuery, setHandler } from "@temporalio/workflow";
import type { TychonicConfig } from "./catalog/types.js";
import type {
  DecisionInboxItemRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
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
  type ApprovalDecision,
  type PolicyInteraction,
  type StraySignal
} from "./workflows/interactionHook.js";
import {
  addRunInboxItem,
  applyActivityResult,
  latestStateByName
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
  summary?: string;
  worktreePath?: string;
}

export interface TychonicRunStateSnapshotFields {
  artifactRoot?: string;
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
  applyApprovalDecision(
    run: WorkflowRunRecord,
    stateName: string,
    decision: ApprovalDecision
  ): WorkflowRunRecord;
  drainStraySignals(): StraySignal[];
  rejectCapInboxItem: typeof rejectCapInboxItem;
  strayInteractionSignalInboxItem: typeof strayInteractionSignalInboxItem;
}

export interface TychonicWorkflowRuntimeInput {
  cwd: string;
  profile?: TychonicConfig;
  goal?: string;
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
  }): Promise<{ worktreePath: string }>;
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
  const runState = createTychonicRunState();
  const interaction = createTychonicInteraction(
    options.interactionPolicy ?? (input.profile?.policies?.interaction as PolicyInteraction | undefined)
  );
  const rejectCounts = new Map<string, number>();
  let currentRun: WorkflowRunRecord | undefined;
  let currentWorktreePath: string | undefined;

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

  async function runAgentState(
    stateName: string,
    activity: TychonicAgentActivity,
    basePrompt: string
  ): Promise<TychonicStateRunResult> {
    const feedbacks: string[] = [];
    let lastActivityResult: ActivityResult | undefined;
    while (true) {
      const prompt = feedbacks.length > 0
        ? `${basePrompt}\n\n[reviewer feedback from previous attempts]\n${feedbacks
            .map((feedback, index) => `${index + 1}. ${feedback}`)
            .join("\n")}\n[/reviewer feedback]`
        : basePrompt;

      const result = await activity({
        stateName,
        run: requireRun(),
        cwd: input.cwd,
        ...(input.profile ? { profile: input.profile } : {}),
        ...(currentWorktreePath ? { worktreePath: currentWorktreePath } : {}),
        prompt
      });
      lastActivityResult = result;
      update(applyActivityResult(requireRun(), result));

      const decision = await interaction.waitForStateApproval(stateName);
      if (decision.kind === "approve") {
        return stateResult(stateName, false, undefined, lastActivityResult);
      }
      if (decision.kind === "modify") {
        update(interaction.applyApprovalDecision(requireRun(), stateName, decision));
        return stateResult(stateName, false, undefined, lastActivityResult);
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
      feedbacks.push(decision.feedback);
    }
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
    update(run);
    const result = await activities.finalizeRunActivity({
      run: requireRun(),
      ...(summary !== undefined ? { summary } : {})
    });
    update(applyActivityResult(requireRun(), result));
    return runState.result(requireRun(), {
      artifactRoot: `${input.cwd}/.tychonic/runs/${requireRun().id}`,
      ...(currentWorktreePath ? { worktreePath: currentWorktreePath } : {})
    });
  }

  async function finishWaitingUser(
    summary: string,
    item: DecisionInboxItemRecord
  ): Promise<TychonicWorkflowResult> {
    let run = requireRun();
    run = addRunInboxItem(run, item);
    update({ ...run, status: "waiting_user" });
    return finish(summary);
  }

  return {
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
      update(requireRun());
      return currentWorktreePath;
    },
    work(stateName, prompt) {
      if (!activities.runWorkerActivity) {
        throw new Error("runWorkerActivity is required to call ctx.work()");
      }
      return runAgentState(stateName, activities.runWorkerActivity, prompt);
    },
    async verify(stateName) {
      if (!activities.runVerifyActivity) {
        throw new Error("runVerifyActivity is required to call ctx.verify()");
      }
      const result = await activities.runVerifyActivity({
        stateName,
        run: requireRun(),
        cwd: input.cwd,
        ...(input.profile ? { profile: input.profile } : {}),
        ...(currentWorktreePath ? { worktreePath: currentWorktreePath } : {})
      });
      update(applyActivityResult(requireRun(), result));
      return stateResult(stateName, false, undefined, result);
    },
    review(stateName, prompt) {
      if (!activities.runReviewActivity) {
        throw new Error("runReviewActivity is required to call ctx.review()");
      }
      return runAgentState(stateName, activities.runReviewActivity, prompt);
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

function nowIso(): string {
  return new Date().toISOString();
}

function toWorkflowResult(
  run: WorkflowRunRecord,
  fields: TychonicRunStateSnapshotFields = {}
): TychonicWorkflowResult {
  return {
    runId: run.id,
    status: run.status,
    run,
    artifactRoot: fields.artifactRoot ?? `${run.cwd}/.tychonic/runs/${run.id}`,
    ...(run.summary !== undefined ? { summary: run.summary } : {}),
    ...(fields.summary !== undefined ? { summary: fields.summary } : {}),
    ...(fields.worktreePath !== undefined ? { worktreePath: fields.worktreePath } : {})
  };
}
