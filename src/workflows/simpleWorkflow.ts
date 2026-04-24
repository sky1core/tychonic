import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import type {
  SimpleWorkflowContinuationSignalInput,
  SimpleWorkflowDismissInboxSignalInput,
  SimpleWorkflowExtendIterationsSignalInput,
  SimpleWorkflowRegisterSessionSignalInput,
  SimpleWorkflowResumeSessionSignalInput,
  SimpleWorkflowInput,
  SimpleWorkflowResult
} from "../temporal/types.js";
import {
  DEFAULT_EXTEND_ITERATIONS_BUDGET,
  simpleWorkflowContinueSignalName,
  simpleWorkflowDismissInboxSignalName,
  simpleWorkflowExtendIterationsSignalName,
  simpleWorkflowRegisterSessionSignalName,
  simpleWorkflowResumeSessionSignalName,
  tychonicWorkflowStateQueryName
} from "../temporal/types.js";
import type { WorkflowRunRecord } from "../domain/types.js";
import type { PolicyInteraction, TychonicConfig } from "../catalog/types.js";
import { applyActivityResult } from "./runMerge.js";
import {
  applyApprovalDecision,
  drainStraySignals,
  effectiveInteractionMode as effectiveInteractionModeFromHook,
  registerInteractionSignals,
  setInteractionPolicy,
  strayInteractionSignalInboxItem,
  waitForStateApproval
} from "./interactionHook.js";

const {
  dismissSimpleWorkflowInboxActivity,
  runSimpleWorkflowActivity,
  runSimpleWorkflowContinuationActivity,
  runSimpleWorkflowExtendIterationsActivity,
  runSimpleWorkflowSessionResumeActivity,
  startRunActivity,
  createWorktreeActivity,
  runWorkerActivity,
  runVerifyActivity,
  runReviewActivity,
  finalizeRunActivity
} = proxyActivities<typeof activities>({
  // Activity command timeouts are enforced inside the runner from profile settings.
  // Keep the Temporal envelope generous so local long-running agent work is not cut off first.
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
});

const workflowStateQuery = defineQuery<SimpleWorkflowResult | undefined>(tychonicWorkflowStateQueryName);
const continueSignal = defineSignal<[SimpleWorkflowContinuationSignalInput]>(simpleWorkflowContinueSignalName);
const registerSessionSignal = defineSignal<[SimpleWorkflowRegisterSessionSignalInput]>(simpleWorkflowRegisterSessionSignalName);
const resumeSessionSignal = defineSignal<[SimpleWorkflowResumeSessionSignalInput]>(simpleWorkflowResumeSessionSignalName);
const dismissInboxSignal = defineSignal<[SimpleWorkflowDismissInboxSignalInput]>(simpleWorkflowDismissInboxSignalName);
const extendIterationsSignal = defineSignal<[SimpleWorkflowExtendIterationsSignalInput]>(
  simpleWorkflowExtendIterationsSignalName
);

export const requires = {
  states: [
    { name: "work", type: "work" },
    { name: "verify", type: "verify" },
    { name: "review", type: "review" }
  ]
} as const;

/**
 * Resolves the effective interactive mode for this run from the
 * workflow input. The interactionHook caches this once and every
 * subsequent read goes through the hook.
 */
function resolveInteractionMode(policy: PolicyInteraction | undefined): "auto" | "interactive" {
  return policy?.mode ?? "auto";
}

export async function simpleWorkflow(input: SimpleWorkflowInput): Promise<SimpleWorkflowResult> {
  let latestResult: SimpleWorkflowResult | undefined;
  const continuationQueue: SimpleWorkflowContinuationSignalInput[] = [];
  const sessionRegistrationQueue: SimpleWorkflowRegisterSessionSignalInput[] = [];
  const sessionResumeQueue: SimpleWorkflowResumeSessionSignalInput[] = [];
  const dismissInboxQueue: SimpleWorkflowDismissInboxSignalInput[] = [];
  const extendIterationsQueue: SimpleWorkflowExtendIterationsSignalInput[] = [];

  setHandler(workflowStateQuery, () => latestResult);
  setHandler(continueSignal, (continuation) => {
    continuationQueue.push(continuation);
  });
  setHandler(registerSessionSignal, (registration) => {
    sessionRegistrationQueue.push(registration);
    if (latestResult) {
      applySessionRegistrations(latestResult, sessionRegistrationQueue);
    }
  });
  setHandler(resumeSessionSignal, (resume) => {
    sessionResumeQueue.push(resume);
  });
  setHandler(dismissInboxSignal, (dismiss) => {
    dismissInboxQueue.push(dismiss);
  });
  setHandler(extendIterationsSignal, (extend) => {
    extendIterationsQueue.push(extend);
  });

  // Register interactive signal handlers and cache the policy before the
  // first `await`. Temporal buffers pre-registration signals; the handler
  // must exist on replay (R-07).
  registerInteractionSignals();
  setInteractionPolicy(input.profile?.policies?.interaction);

  const mode = resolveInteractionMode(input.profile?.policies?.interaction);

  if (mode === "auto") {
    // Auto branch: unchanged. SPEC §Workflow Model — interactive mode must
    // not shift the auto execution path; preserving the single-activity
    // call keeps Temporal history identical for runs that do not opt into
    // interactive gating.
    latestResult = await runSimpleWorkflowActivity(input);
  } else {
    latestResult = await runSimpleWorkflowInteractive(input);
  }
  applySessionRegistrations(latestResult, sessionRegistrationQueue);

  while (input.holdOpenOnWaiting && latestResult.status === "waiting_user") {
    await condition(
      () =>
        continuationQueue.length > 0 ||
        sessionResumeQueue.length > 0 ||
        dismissInboxQueue.length > 0 ||
        extendIterationsQueue.length > 0
    );
    const extend = extendIterationsQueue.shift();
    if (extend) {
      const extendInput = {
        ...extendDefaultsFromWorkflowInput(input, extend),
        ...extend
      };
      if (!extendInput.verifyCommand) {
        throw new Error(
          "simple_workflow loop extend iterations requires verifyCommand or a workflow start verifyCommand default"
        );
      }
      latestResult = await runSimpleWorkflowExtendIterationsActivity({
        cwd: input.cwd,
        run: latestResult.run,
        worktreePath: latestResult.worktreePath,
        ...extendInput,
        verifyCommand: extendInput.verifyCommand,
        maxIterations: extendInput.maxIterations ?? input.maxIterations ?? DEFAULT_EXTEND_ITERATIONS_BUDGET
      });
      applySessionRegistrations(latestResult, sessionRegistrationQueue);
      continue;
    }

    const continuation = continuationQueue.shift();
    if (continuation) {
      const continuationInput = {
        ...continuationDefaultsFromWorkflowInput(input, continuation),
        ...continuation
      };
      if (!continuationInput.verifyCommand) {
        throw new Error("simple_workflow loop continuation requires verifyCommand or a workflow start verifyCommand default");
      }
      latestResult = await runSimpleWorkflowContinuationActivity({
        cwd: input.cwd,
        run: latestResult.run,
        worktreePath: latestResult.worktreePath,
        ...continuationInput,
        verifyCommand: continuationInput.verifyCommand
      });
      applySessionRegistrations(latestResult, sessionRegistrationQueue);
      continue;
    }

    const dismiss = dismissInboxQueue.shift();
    if (dismiss) {
      latestResult = await dismissSimpleWorkflowInboxActivity({
        cwd: input.cwd,
        run: latestResult.run,
        worktreePath: latestResult.worktreePath,
        ...dismiss
      });
      applySessionRegistrations(latestResult, sessionRegistrationQueue);
      continue;
    }

    const resume = sessionResumeQueue.shift();
    if (!resume) {
      continue;
    }
    latestResult = await runSimpleWorkflowSessionResumeActivity({
      cwd: input.cwd,
      run: latestResult.run,
      worktreePath: latestResult.worktreePath,
      ...resume,
      ...(input.commandTimeoutMs && !resume.commandTimeoutMs ? { commandTimeoutMs: input.commandTimeoutMs } : {}),
      ...(input.activityTimeouts && !resume.activityTimeouts ? { activityTimeouts: input.activityTimeouts } : {})
    });
    applySessionRegistrations(latestResult, sessionRegistrationQueue);
  }

  return latestResult;
}

/**
 * Interactive branch of `simpleWorkflow`. Drives the work/verify/review
 * loop at the workflow level so every state can be gated by
 * `waitForStateApproval`. Auto mode keeps the legacy single-activity
 * path for Temporal-history compatibility.
 *
 * A reject on a state re-runs that state's activity and feeds the
 * feedback string to the next attempt's extras. Stage 6 enforces the
 * `max_reject_iterations` cap via `gateState` below.
 */
async function runSimpleWorkflowInteractive(input: SimpleWorkflowInput): Promise<SimpleWorkflowResult> {
  if (!input.profile) {
    throw new Error(
      "simple_workflow interactive mode requires input.profile (the immutable workflow profile snapshot)"
    );
  }
  const profile = input.profile;

  let run = await startRunActivity({
    template: "simple_workflow",
    cwd: input.cwd,
    profile,
    ...(input.goal ? { goal: input.goal } : {}),
    ...(input.runId ? { runId: input.runId } : {})
  });
  run = { ...run, status: "running" };

  const worktree = await createWorktreeActivity({ run, cwd: input.cwd });

  const rejectCounts = new Map<string, number>();

  // work
  run = await gateState({
    stateName: "work",
    run,
    profile,
    rejectCounts,
    runActivity: async (runNow, feedback) => {
      const res = await runWorkerActivity({
        stateName: "work",
        run: runNow,
        profile,
        cwd: input.cwd,
        extras: {
          worktreePath: worktree.worktreePath,
          ...(input.goal ? { goal: input.goal } : {}),
          ...(feedback ? { prompt: feedback } : {})
        }
      });
      return applyActivityResult(runNow, res);
    }
  });

  // verify — skipped when a previous state parked the run.
  if (run.status !== "waiting_user") {
    run = await gateState({
      stateName: "verify",
      run,
      profile,
      rejectCounts,
      runActivity: async (runNow, _feedback) => {
        const res = await runVerifyActivity({
          stateName: "verify",
          run: runNow,
          profile,
          cwd: input.cwd,
          extras: {
            worktreePath: worktree.worktreePath,
            command: input.verifyCommand
          }
        });
        return applyActivityResult(runNow, res);
      }
    });
  }

  // review — skipped when a previous state parked the run.
  if (run.status !== "waiting_user") {
    run = await gateState({
      stateName: "review",
      run,
      profile,
      rejectCounts,
      runActivity: async (runNow, _feedback) => {
        const res = await runReviewActivity({
          stateName: "review",
          run: runNow,
          profile,
          cwd: input.cwd,
          extras: {
            worktreePath: worktree.worktreePath,
            verificationCommands: [input.verifyCommand]
          }
        });
        return applyActivityResult(runNow, res);
      }
    });
  }

  // Surface any stray interaction signals that never matched a hook
  // call (R-03 mitigation) before finalize computes terminal status.
  run = absorbStrayInteractionSignals(run);

  const finalize = await finalizeRunActivity({ run });
  run = applyActivityResult(run, finalize);

  return {
    runId: run.id,
    status: run.status,
    run,
    artifactRoot: `${input.cwd}/.tychonic/runs/${run.id}`,
    worktreePath: worktree.worktreePath
  };
}

/**
 * Run the state's activity, then gate on the interactive decision.
 * Implements the reject-retry branch and respects the reject cap by
 * stopping further gate attempts once the cap is reached (Task 6).
 *
 * Exported for direct testing; production callers inside
 * `runSimpleWorkflowInteractive` drive it through workflow activity
 * proxies.
 */
export async function gateState(options: {
  stateName: string;
  run: WorkflowRunRecord;
  profile: TychonicConfig;
  rejectCounts: Map<string, number>;
  runActivity: (run: WorkflowRunRecord, feedback?: string) => Promise<WorkflowRunRecord>;
}): Promise<WorkflowRunRecord> {
  let run = options.run;
  let nextFeedback: string | undefined;
  // Pre-compute the cap once.
  const cap = rejectCapFor(options.profile);

  // First attempt.
  run = await options.runActivity(run, nextFeedback);
  // Gate loop.
  while (true) {
    if (isCapReached(options.rejectCounts, options.stateName, options.profile)) {
      // SPEC §Interactive mode: "promotes the run to waiting_user with an
      // inbox item titled 'Interactive reject limit reached' and stops
      // calling waitForStateApproval for that state."
      run = parkRunAtRejectCap(run, options.stateName);
      return run;
    }
    const decision = await waitForStateApproval(options.stateName);
    if (decision.kind === "approve") {
      return run;
    }
    if (decision.kind === "modify") {
      run = applyApprovalDecision(run, options.stateName, decision);
      return run;
    }
    // reject
    const current = options.rejectCounts.get(options.stateName) ?? 0;
    options.rejectCounts.set(options.stateName, current + 1);
    if (current + 1 >= cap) {
      run = parkRunAtRejectCap(run, options.stateName);
      return run;
    }
    nextFeedback = decision.feedback;
    run = await options.runActivity(run, nextFeedback);
  }
}

/**
 * Park the run at the reject cap: append the `inbox_reject_cap_<state>`
 * inbox item and transition `run.status` to `waiting_user`. Callers
 * must stop driving subsequent states once this transition occurs.
 */
function parkRunAtRejectCap(run: WorkflowRunRecord, stateName: string): WorkflowRunRecord {
  const withInbox = appendRejectCapInboxItem(run, stateName);
  if (withInbox.status === "waiting_user") return withInbox;
  return { ...withInbox, status: "waiting_user" };
}

function rejectCapFor(profile: TychonicConfig): number {
  const policy = profile.policies?.interaction;
  if (policy?.mode !== "interactive") {
    return Number.POSITIVE_INFINITY;
  }
  return policy.max_reject_iterations ?? 5;
}

function isCapReached(
  counts: Map<string, number>,
  stateName: string,
  profile: TychonicConfig
): boolean {
  const policy = profile.policies?.interaction;
  if (policy?.mode !== "interactive") {
    return false;
  }
  const cap = policy.max_reject_iterations ?? 5;
  return (counts.get(stateName) ?? 0) >= cap;
}

function appendRejectCapInboxItem(run: WorkflowRunRecord, stateName: string): WorkflowRunRecord {
  const createdAt = new Date().toISOString();
  const id = `inbox_reject_cap_${stateName}_${run.inbox.length + 1}`;
  const item = {
    id,
    status: "open" as const,
    title: "Interactive reject limit reached",
    detail: `state '${stateName}' reached the interactive reject iteration cap`,
    action: { kind: "triage" as const, reason: `interactive reject cap for state '${stateName}'` },
    created_at: createdAt
  };
  return { ...run, inbox: [...run.inbox, item] };
}

function absorbStrayInteractionSignals(run: WorkflowRunRecord): WorkflowRunRecord {
  if (effectiveInteractionModeFromHook() !== "interactive") {
    return run;
  }
  const strays = drainStraySignals();
  if (strays.length === 0) {
    return run;
  }
  const createdAt = new Date().toISOString();
  const inboxAdditions = strays.map((stray, idx) =>
    strayInteractionSignalInboxItem(stray, {
      createdAt,
      id: `inbox_stray_${idx + 1}_${run.inbox.length + idx + 1}`
    })
  );
  return { ...run, inbox: [...run.inbox, ...inboxAdditions] };
}

export function continuationDefaultsFromWorkflowInput(
  input: SimpleWorkflowInput,
  continuation: SimpleWorkflowContinuationSignalInput
): Partial<SimpleWorkflowContinuationSignalInput> {
  const signalSelectsWorker = Boolean(
    continuation.command || continuation.workerCandidates?.length
  );
  const signalSelectsReview = Boolean(
    continuation.reviewCommand || continuation.reviewCandidates?.length
  );
  return {
    ...(!signalSelectsWorker && input.command ? { command: input.command } : {}),
    ...(!signalSelectsWorker && input.agent ? { agent: input.agent } : {}),
    ...(!signalSelectsWorker && input.resumeCommand ? { resumeCommand: input.resumeCommand } : {}),
    ...(!signalSelectsWorker && input.workerCandidates ? { workerCandidates: input.workerCandidates } : {}),
    ...(input.goal && !continuation.goal ? { goal: input.goal } : {}),
    ...(!signalSelectsReview && input.reviewCommand ? { reviewCommand: input.reviewCommand } : {}),
    ...(!signalSelectsReview && input.reviewAgent ? { reviewAgent: input.reviewAgent } : {}),
    ...(!signalSelectsReview && input.reviewCandidates ? { reviewCandidates: input.reviewCandidates } : {}),
    ...(input.verifyCommand && !continuation.verifyCommand ? { verifyCommand: input.verifyCommand } : {}),
    ...(input.commandTimeoutMs && !continuation.commandTimeoutMs ? { commandTimeoutMs: input.commandTimeoutMs } : {}),
    ...(input.activityTimeouts && !continuation.activityTimeouts ? { activityTimeouts: input.activityTimeouts } : {})
  };
}

export function extendDefaultsFromWorkflowInput(
  input: SimpleWorkflowInput,
  extend: SimpleWorkflowExtendIterationsSignalInput
): Partial<SimpleWorkflowExtendIterationsSignalInput> {
  const signalSelectsWorker = Boolean(
    extend.command || extend.workerCandidates?.length
  );
  const signalSelectsReview = Boolean(
    extend.reviewCommand || extend.reviewCandidates?.length
  );
  return {
    ...(!signalSelectsWorker && input.command ? { command: input.command } : {}),
    ...(!signalSelectsWorker && input.agent ? { agent: input.agent } : {}),
    ...(!signalSelectsWorker && input.resumeCommand ? { resumeCommand: input.resumeCommand } : {}),
    ...(!signalSelectsWorker && input.workerCandidates ? { workerCandidates: input.workerCandidates } : {}),
    ...(input.goal && !extend.goal ? { goal: input.goal } : {}),
    ...(!signalSelectsReview && input.reviewCommand ? { reviewCommand: input.reviewCommand } : {}),
    ...(!signalSelectsReview && input.reviewAgent ? { reviewAgent: input.reviewAgent } : {}),
    ...(!signalSelectsReview && input.reviewCandidates ? { reviewCandidates: input.reviewCandidates } : {}),
    ...(input.verifyCommand && !extend.verifyCommand ? { verifyCommand: input.verifyCommand } : {}),
    ...(input.commandTimeoutMs && !extend.commandTimeoutMs ? { commandTimeoutMs: input.commandTimeoutMs } : {}),
    ...(input.activityTimeouts && !extend.activityTimeouts ? { activityTimeouts: input.activityTimeouts } : {})
  };
}

function applySessionRegistrations(
  result: SimpleWorkflowResult,
  queue: SimpleWorkflowRegisterSessionSignalInput[]
): void {
  while (queue.length > 0) {
    const registration = queue.shift();
    if (!registration) {
      continue;
    }
    const existing = result.run.agent_sessions.find((session) => session.id === registration.id);
    if (existing) {
      existing.agent = registration.agent;
      existing.role = registration.role;
      existing.cwd = registration.cwd;
      existing.status = registration.status ?? existing.status;
      existing.started_at = registration.startedAt;
      if (registration.externalSessionId) {
        existing.external_session_id = registration.externalSessionId;
      }
      if (registration.resumeCommand) {
        existing.resume_command = registration.resumeCommand;
      }
      continue;
    }
    result.run.agent_sessions.push({
      id: registration.id,
      agent: registration.agent,
      role: registration.role,
      cwd: registration.cwd,
      status: registration.status ?? "unknown",
      ...(registration.externalSessionId ? { external_session_id: registration.externalSessionId } : {}),
      ...(registration.resumeCommand ? { resume_command: registration.resumeCommand } : {}),
      started_at: registration.startedAt
    });
  }
}
