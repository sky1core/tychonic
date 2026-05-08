// architectBuilderReviewRepairQaWorkflow — Kiro pre-review and repair before a
// structured final QA gate.

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
      approval: "never"
    },
    pre_review: {
      type: "work",
      agent: "kiro",
      model: "claude-opus-4.6",
      trust_all_tools: true,
      timeout: "30m"
    },
    repair: {
      type: "work",
      agent: "kiro",
      model: "claude-opus-4.6",
      trust_all_tools: true,
      sandbox: "workspace-write",
      approval: "never",
      timeout: "45m"
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

const PROMPT_ADDITION_STATES = ["architect", "builder", "pre_review", "repair", "final_qa"];

export async function architectBuilderReviewRepairQaWorkflow(input) {
  validateTaskWorkflowInput(input, { promptAdditionStates: PROMPT_ADDITION_STATES });
  const ctx = createTychonicWorkflowContext({
    input,
    template: "architect_builder_review_repair_qa",
    activities: act
  });

  await ctx.start();
  await ctx.createWorktree();

  const architect = await ctx.work(
    "architect",
    withPromptAddition(architectStageInstructions(input.goal ?? ""), input, "architect")
  );
  if (!architect.passed) return ctx.finish("architect failed");

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
  if (!builder.passed) return ctx.finish("builder failed");

  const preReview = await ctx.work(
    "pre_review",
    withPromptAddition(
      preReviewStageInstructions({
        cwd: input.cwd,
        runId: ctx.run().id,
        worktreePath: ctx.worktreePath()
      }),
      input,
      "pre_review"
    )
  );
  if (!preReview.passed) return ctx.finish("pre_review failed");

  const repair = await ctx.work(
    "repair",
    withPromptAddition(
      repairStageInstructions({
        cwd: input.cwd,
        runId: ctx.run().id,
        worktreePath: ctx.worktreePath()
      }),
      input,
      "repair"
    )
  );
  if (!repair.passed) return ctx.finish("repair failed");

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
    "Write a concrete implementation plan for the builder. Do not implement."
  ].join("\n");
}

function builderStageInstructions({ cwd, runId, worktreePath }) {
  return [
    "You are the builder stage. Implement the architect output for this run.",
    "",
    `Worktree: ${worktreePath}`,
    `Artifacts: ${cwd}/.tychonic/runs/${runId}/artifacts/`,
    "",
    "Apply the plan as code changes and tests. Do not expand scope beyond the plan."
  ].join("\n");
}

function preReviewStageInstructions({ cwd, runId, worktreePath }) {
  return [
    "You are the pre-review stage.",
    `Review the current worktree: ${worktreePath}`,
    `Use artifacts under ${cwd}/.tychonic/runs/${runId}/artifacts/ as context.`,
    "",
    "Do not edit files in this stage.",
    "Write a concise prose review listing only clear, actionable issues.",
    "If there are no clear issues, say that explicitly."
  ].join("\n");
}

function repairStageInstructions({ cwd, runId, worktreePath }) {
  return [
    "You are the repair stage.",
    `Worktree: ${worktreePath}`,
    `Read the pre-review output under ${cwd}/.tychonic/runs/${runId}/artifacts/.`,
    "",
    "Fix only clear issues from that pre-review. If it found no clear issues, make no changes and say so.",
    "Do not expand scope beyond the architect plan and pre-review."
  ].join("\n");
}

function finalQaStageInstructions({ cwd, runId, worktreePath }) {
  return [
    "You are the final structured QA reviewer.",
    `Check the final worktree in ${worktreePath}.`,
    `Use artifacts under ${cwd}/.tychonic/runs/${runId}/artifacts/ as context, including pre-review and repair output.`,
    "",
    "Report a semantic review verdict with status, summary, and findings.",
    "Each finding needs severity, title, and actionable detail.",
    "Use status pass only when findings is empty. Use status fail when any actionable finding exists."
  ].join("\n");
}
