// architectBuilderFirstReviewQaWorkflow — Claude plans, Kiro builds and performs
// the first normalized review, Codex runs only the final structured QA gate.

import { proxyActivities } from "@temporalio/workflow";
import { createTychonicWorkflowContext, validateTaskWorkflowInput } from "tychonic/workflow";

const act = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
});

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    architect: {
      type: "work",
      agent: "claude",
      model: "claude-opus-4-7",
      reasoning_effort: "max",
      permission_mode: "plan"
    },
    builder: {
      type: "work",
      agent: "kiro",
      model: "claude-opus-4.6",
      trust_all_tools: true,
      sandbox: "workspace-write",
      approval: "never",
      timeout: "60m"
    },
    first_review: {
      type: "review",
      agent: "kiro",
      model: "claude-opus-4.6",
      normalizer: "claude",
      trust_all_tools: true,
      timeout: "30m"
    },
    final_qa: {
      type: "review",
      agent: "codex",
      model: "gpt-5.5",
      reasoning_effort: "xhigh",
      approval: "never",
      timeout: "30m"
    }
  },
  policies: {}
};

const PROMPT_ADDITION_STATES = ["architect", "builder", "first_review", "final_qa"];

export async function architectBuilderFirstReviewQaWorkflow(input) {
  validateTaskWorkflowInput(input, { promptAdditionStates: PROMPT_ADDITION_STATES });
  const ctx = createTychonicWorkflowContext({
    input,
    template: "architect_builder_first_review_qa",
    activities: act
  });

  await ctx.start();
  await ctx.createWorktree();

  const architect = await ctx.work(
    "architect",
    withPromptAddition(architectStageInstructions(input.goal ?? ""), input, "architect")
  );
  if (!architect.passed) return ctx.finish(architect.summary ?? "architect failed");

  const builder = await ctx.work(
    "builder",
    withPromptAddition(
      builderStageInstructions({
        cwd: input.cwd,
        runId: ctx.run().id,
        worktreePath: ctx.worktreePath()
      }),
      input,
      "builder"
    )
  );
  if (!builder.passed) return ctx.finish(builder.summary ?? "builder failed");

  const firstReview = await ctx.review(
    "first_review",
    withPromptAddition(
      firstReviewStageInstructions({
        cwd: input.cwd,
        runId: ctx.run().id,
        worktreePath: ctx.worktreePath()
      }),
      input,
      "first_review"
    )
  );
  if (firstReview.halted) return ctx.finish(firstReview.summary);
  if (!firstReview.passed) {
    return ctx.finish(firstReview.summary ?? "first_review did not pass; final_qa was not run");
  }

  const finalQa = await ctx.review(
    "final_qa",
    withPromptAddition(
      finalQaStageInstructions({
        cwd: input.cwd,
        runId: ctx.run().id,
        worktreePath: ctx.worktreePath()
      }),
      input,
      "final_qa"
    )
  );
  if (!finalQa.passed) return ctx.finish(finalQa.summary ?? "final_qa did not pass");

  return ctx.finish();
}

function withPromptAddition(basePrompt, input, stateName) {
  const addition = input.promptAdditions?.[stateName];
  if (addition === undefined) return basePrompt;
  return `${basePrompt}\n\n[additional ${stateName} instructions]\n${addition}\n[/additional ${stateName} instructions]`;
}

function architectStageInstructions(goal) {
  return [
    "You are the architect stage.",
    "",
    "Goal:",
    goal || "(no explicit goal supplied; infer from the project state)",
    "",
    "Write a concrete implementation plan for the Kiro builder. Do not implement."
  ].join("\n");
}

function builderStageInstructions({ cwd, runId, worktreePath }) {
  return [
    "You are the Kiro builder stage. Implement the architect output for this run.",
    "",
    `Worktree: ${worktreePath}`,
    `Artifacts: ${cwd}/.tychonic/runs/${runId}/artifacts/`,
    "",
    "Apply the architect plan as code changes and tests. Do not expand scope beyond the plan."
  ].join("\n");
}

function firstReviewStageInstructions({ cwd, runId, worktreePath }) {
  return [
    "You are the first QA reviewer for this run.",
    `Review the Kiro builder output in ${worktreePath}.`,
    `Use artifacts under ${cwd}/.tychonic/runs/${runId}/artifacts/ as context.`,
    "",
    "Filter out clear correctness issues before Codex final QA runs.",
    "Report concrete regressions, missing tests, unsafe assumptions, and scope drift.",
    "Do not repair code in this stage. The normalizer will structure only your review."
  ].join("\n");
}

function finalQaStageInstructions({ cwd, runId, worktreePath }) {
  return [
    "You are the final Codex QA reviewer for this run.",
    `Check the final worktree in ${worktreePath}.`,
    `Use artifacts under ${cwd}/.tychonic/runs/${runId}/artifacts/ as context, including Kiro's first review.`,
    "",
    "Report a semantic review verdict with status, summary, and findings.",
    "Each finding needs severity, title, and actionable detail.",
    "Use status pass only when findings is empty. Use status fail when any actionable finding exists."
  ].join("\n");
}
