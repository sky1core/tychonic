import {
  activityTimeoutOverrides,
  optionalStateConfig,
  requiredActivity,
  resolveActivityCommand,
  type ActivityBlock,
  type TychonicConfig
} from "../catalog/types.js";
import type { AgentCandidateInput, SimpleWorkflowInput } from "../temporal/types.js";

export interface SimpleWorkflowCliOptions {
  cwd: string;
  command?: string;
  verifyCommand?: string;
  goal?: string;
  agent?: string;
  resumeCommand?: string;
  workerCandidates?: AgentCandidateInput[];
  reviewCommand?: string;
  reviewAgent?: string;
  reviewCandidates?: AgentCandidateInput[];
  autoContinue?: boolean;
  maxIterations?: number;
  commandTimeout?: number;
  profile?: TychonicConfig;
}

export function resolveSimpleWorkflowCliOptions(options: SimpleWorkflowCliOptions): SimpleWorkflowInput {
  const profile = options.profile;
  const work = optionalStateConfig(profile, "work", "work");
  const verify = optionalStateConfig(profile, "verify", "verify");
  const review = optionalStateConfig(profile, "review", "review");
  const loop = profile?.policies?.loop;

  const verifyCommand = options.verifyCommand ?? verify?.command;
  if (!verifyCommand) {
    throw new Error("simple_workflow requires activity 'verify' of type 'verify' with command, or --verify-command");
  }

  const resolved: SimpleWorkflowInput = {
    cwd: options.cwd,
    verifyCommand
  };

  resolveWorkerSelection(resolved, options, work);
  resolveReviewSelection(resolved, options, review);

  if (options.goal) {
    resolved.goal = options.goal;
  }

  const autoContinue = options.autoContinue ?? loop?.auto_continue;
  if (autoContinue) {
    resolved.autoContinue = true;
  }

  const maxIterations = options.maxIterations ?? loop?.max_review_iterations;
  if (maxIterations !== undefined) {
    resolved.maxIterations = maxIterations;
  }

  if (options.commandTimeout) {
    resolved.commandTimeoutMs = options.commandTimeout;
  }
  const timeouts = activityTimeoutOverrides(profile, options.commandTimeout);
  if (timeouts) {
    resolved.activityTimeouts = timeouts;
  }

  return resolved;
}

function resolveWorkerSelection(
  resolved: SimpleWorkflowInput,
  options: SimpleWorkflowCliOptions,
  work: ActivityBlock | undefined
): void {
  const cliWorkerCandidates = options.workerCandidates?.length ? options.workerCandidates : undefined;
  const cliSelectsWorker = Boolean(options.command || cliWorkerCandidates);
  const selected = cliSelectsWorker ? undefined : work ?? requiredActivity(options.profile, "work", "work");
  const commandActivity = cliSelectsWorker ? undefined : resolveActivityCommand(selected);

  const command = options.command ?? commandActivity?.command;
  if (command) {
    resolved.command = command;
  }
  if (cliWorkerCandidates) {
    resolved.workerCandidates = cliWorkerCandidates;
  }

  const agent = options.agent ?? (!cliSelectsWorker ? selected?.agent : undefined);
  if (agent) {
    resolved.agent = agent;
  }

  const resumeCommand = options.resumeCommand ?? (!cliSelectsWorker ? selected?.resume_command ?? commandActivity?.resume_command : undefined);
  if (resumeCommand) {
    resolved.resumeCommand = resumeCommand;
  }
}

function resolveReviewSelection(
  resolved: SimpleWorkflowInput,
  options: SimpleWorkflowCliOptions,
  review: ActivityBlock | undefined
): void {
  const cliReviewCandidates = options.reviewCandidates?.length ? options.reviewCandidates : undefined;
  const cliSelectsReview = Boolean(options.reviewCommand || cliReviewCandidates);
  const commandActivity = cliSelectsReview ? undefined : resolveActivityCommand(review);

  const reviewCommand = options.reviewCommand ?? commandActivity?.command;
  if (reviewCommand) {
    resolved.reviewCommand = reviewCommand;
  }
  if (cliReviewCandidates) {
    resolved.reviewCandidates = cliReviewCandidates;
  }

  const reviewAgent = options.reviewAgent ?? (!cliSelectsReview ? review?.agent : undefined);
  if (reviewAgent) {
    resolved.reviewAgent = reviewAgent;
  }
}
