import { CancelledFailure, Context } from "@temporalio/activity";
import {
  runSimpleWorkflow,
  runSimpleWorkflowContinuation,
  runSimpleWorkflowExtendIterations,
  runSimpleWorkflowSessionResume
} from "../bootstrap/simpleWorkflowRunner.js";
import { dismissDecisionInboxItem } from "../domain/inbox.js";
import type {
  SimpleWorkflowContinuationInput,
  SimpleWorkflowDismissInboxInput,
  SimpleWorkflowExtendIterationsInput,
  SimpleWorkflowResumeSessionInput,
  SimpleWorkflowInput,
  SimpleWorkflowResult
} from "../temporal/types.js";

export async function runSimpleWorkflowActivity(input: SimpleWorkflowInput): Promise<SimpleWorkflowResult> {
  const result = await runSimpleWorkflow({
    cwd: input.cwd,
    ...(input.command ? { command: input.command } : {}),
    verifyCommand: input.verifyCommand,
    ...(input.goal ? { goal: input.goal } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.resumeCommand ? { resumeCommand: input.resumeCommand } : {}),
    ...(input.workerCandidates ? { workerCandidates: input.workerCandidates } : {}),
    ...(input.reviewCommand ? { reviewCommand: input.reviewCommand } : {}),
    ...(input.reviewAgent ? { reviewAgent: input.reviewAgent } : {}),
    ...(input.reviewCandidates ? { reviewCandidates: input.reviewCandidates } : {}),
    ...(input.autoContinue ? { autoContinue: input.autoContinue } : {}),
    ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
    ...(input.commandTimeoutMs ? { commandTimeoutMs: input.commandTimeoutMs } : {}),
    ...(input.activityTimeouts ? { activityTimeouts: input.activityTimeouts } : {}),
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    heartbeat: heartbeatActivity
  });

  return {
    runId: result.run.id,
    status: result.run.status,
    run: result.run,
    artifactRoot: `${input.cwd}/.tychonic/runs/${result.run.id}`,
    worktreePath: result.worktreePath
  };
}

export async function runSimpleWorkflowContinuationActivity(input: SimpleWorkflowContinuationInput): Promise<SimpleWorkflowResult> {
  const result = await runSimpleWorkflowContinuation({
    cwd: input.cwd,
    run: input.run,
    worktreePath: input.worktreePath,
    inboxItemId: input.inboxItemId,
    ...(input.command ? { command: input.command } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.resumeCommand ? { resumeCommand: input.resumeCommand } : {}),
    ...(input.workerCandidates ? { workerCandidates: input.workerCandidates } : {}),
    ...(input.goal ? { goal: input.goal } : {}),
    verifyCommand: input.verifyCommand,
    ...(input.reviewCommand ? { reviewCommand: input.reviewCommand } : {}),
    ...(input.reviewAgent ? { reviewAgent: input.reviewAgent } : {}),
    ...(input.reviewCandidates ? { reviewCandidates: input.reviewCandidates } : {}),
    ...(input.commandTimeoutMs ? { commandTimeoutMs: input.commandTimeoutMs } : {}),
    ...(input.activityTimeouts ? { activityTimeouts: input.activityTimeouts } : {}),
    heartbeat: heartbeatActivity
  });

  return {
    runId: result.run.id,
    status: result.run.status,
    run: result.run,
    artifactRoot: `${input.cwd}/.tychonic/runs/${result.run.id}`,
    worktreePath: result.worktreePath
  };
}

export async function runSimpleWorkflowExtendIterationsActivity(
  input: SimpleWorkflowExtendIterationsInput
): Promise<SimpleWorkflowResult> {
  const result = await runSimpleWorkflowExtendIterations({
    cwd: input.cwd,
    run: input.run,
    worktreePath: input.worktreePath,
    verifyCommand: input.verifyCommand,
    maxIterations: input.maxIterations,
    ...(input.command ? { command: input.command } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.resumeCommand ? { resumeCommand: input.resumeCommand } : {}),
    ...(input.workerCandidates ? { workerCandidates: input.workerCandidates } : {}),
    ...(input.goal ? { goal: input.goal } : {}),
    ...(input.reviewCommand ? { reviewCommand: input.reviewCommand } : {}),
    ...(input.reviewAgent ? { reviewAgent: input.reviewAgent } : {}),
    ...(input.reviewCandidates ? { reviewCandidates: input.reviewCandidates } : {}),
    ...(input.commandTimeoutMs ? { commandTimeoutMs: input.commandTimeoutMs } : {}),
    ...(input.activityTimeouts ? { activityTimeouts: input.activityTimeouts } : {}),
    heartbeat: heartbeatActivity
  });

  return {
    runId: result.run.id,
    status: result.run.status,
    run: result.run,
    artifactRoot: `${input.cwd}/.tychonic/runs/${result.run.id}`,
    worktreePath: result.worktreePath
  };
}

export async function runSimpleWorkflowSessionResumeActivity(input: SimpleWorkflowResumeSessionInput): Promise<SimpleWorkflowResult> {
  const result = await runSimpleWorkflowSessionResume({
    cwd: input.cwd,
    run: input.run,
    worktreePath: input.worktreePath,
    sessionId: input.sessionId,
    prompt: input.prompt,
    verifyCommand: input.verifyCommand,
    ...(input.reviewCommand ? { reviewCommand: input.reviewCommand } : {}),
    ...(input.reviewAgent ? { reviewAgent: input.reviewAgent } : {}),
    ...(input.reviewCandidates ? { reviewCandidates: input.reviewCandidates } : {}),
    ...(input.commandTimeoutMs ? { commandTimeoutMs: input.commandTimeoutMs } : {}),
    ...(input.activityTimeouts ? { activityTimeouts: input.activityTimeouts } : {}),
    heartbeat: heartbeatActivity
  });

  return {
    runId: result.run.id,
    status: result.run.status,
    run: result.run,
    artifactRoot: `${input.cwd}/.tychonic/runs/${result.run.id}`,
    worktreePath: result.worktreePath
  };
}

export async function dismissSimpleWorkflowInboxActivity(input: SimpleWorkflowDismissInboxInput): Promise<SimpleWorkflowResult> {
  const run = dismissDecisionInboxItem({
    run: input.run,
    inboxItemId: input.inboxItemId,
    ...(input.reason ? { reason: input.reason } : {}),
    dismissedAt: new Date().toISOString()
  });

  return {
    runId: run.id,
    status: run.status,
    run,
    artifactRoot: `${input.cwd}/.tychonic/runs/${run.id}`,
    worktreePath: input.worktreePath
  };
}

function heartbeatActivity(details: unknown): void {
  let context: Context;
  try {
    context = Context.current();
  } catch {
    // Unit tests can call activities directly without a Temporal activity context.
    return;
  }
  context.heartbeat(details);
  const signal = context.cancellationSignal;
  if (signal.aborted) {
    // Temporal cancellation arrived. Throwing CancelledFailure lets the activity
    // surface as cancelled in workflow history and propagate out of any
    // long-running loop that routes its progress callback through heartbeat.
    throw new CancelledFailure(
      typeof signal.reason === "string" && signal.reason.length > 0
        ? signal.reason
        : "activity cancelled"
    );
  }
}

function currentCancellationSignal(): AbortSignal | undefined {
  try {
    return Context.current().cancellationSignal;
  } catch {
    // Unit tests can call activities directly without a Temporal activity context.
    return undefined;
  }
}

// stage 1 skeletons — unimplemented
export { runLintActivity } from "./runLintActivity.js";
export { runUnitTestActivity } from "./runUnitTestActivity.js";
export { runIntegrationActivity } from "./runIntegrationActivity.js";
export { runVerifyActivity } from "./runVerifyActivity.js";
export { runWorkerActivity } from "./runWorkerActivity.js";
export { runResumeWorkActivity } from "./runResumeWorkActivity.js";
export { runAutoContinueActivity } from "./runAutoContinueActivity.js";
export { runReviewActivity } from "./runReviewActivity.js";
export { startRunActivity } from "./startRunActivity.js";
export { collectGitFactsActivity } from "./collectGitFactsActivity.js";
export { createWorktreeActivity } from "./createWorktreeActivity.js";
export { finalizeRunActivity } from "./finalizeRunActivity.js";
