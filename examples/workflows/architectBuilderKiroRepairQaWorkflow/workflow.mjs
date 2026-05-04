// architectBuilderKiroRepairQaWorkflow — Kiro pre-review and repair before a
// structured final QA gate.

import { proxyActivities } from "@temporalio/workflow";
import { createTychonicWorkflowContext } from "tychonic/workflow";

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
      permission_mode: "plan"
    },
    builder: {
      type: "work",
      agent: "codex",
      sandbox: "workspace-write",
      approval: "never"
    },
    kiro_pre_review: {
      type: "work",
      agent: "kiro",
      model: "claude-sonnet-4.5",
      trust_all_tools: true,
      timeout: "30m"
    },
    kiro_fix: {
      type: "work",
      agent: "kiro",
      model: "claude-sonnet-4.5",
      trust_all_tools: true,
      sandbox: "workspace-write",
      approval: "never",
      timeout: "45m"
    },
    final_qa: {
      type: "review",
      agent: "claude",
      model: "opus",
      reasoning_effort: "max",
      permission_mode: "plan",
      timeout: "30m"
    }
  },
  policies: {}
};

const INPUT_FIELDS = new Set([
  "cwd",
  "profile",
  "goal",
  "architectPrompt",
  "builderPrompt",
  "kiroPreReviewPrompt",
  "kiroFixPrompt",
  "finalQaPrompt"
]);

function rejectUnknownInputFields(input) {
  if (!input || typeof input !== "object") return;
  for (const field of Object.keys(input)) {
    if (!INPUT_FIELDS.has(field)) {
      throw new Error(`unsupported input field: ${field}`);
    }
  }
}

export async function architectBuilderKiroRepairQaWorkflow(input) {
  rejectUnknownInputFields(input);
  const ctx = createTychonicWorkflowContext({
    input,
    template: "architect_builder_kiro_repair_qa",
    activities: act
  });

  await ctx.start();
  await ctx.createWorktree();

  const architect = await ctx.work(
    "architect",
    input.architectPrompt ?? architectPrompt(input.goal ?? "")
  );
  if (!architect.passed) return ctx.finish("architect failed");

  const builder = await ctx.work(
    "builder",
    input.builderPrompt ?? builderPrompt({
      cwd: input.cwd,
      runId: ctx.run().id,
      worktreePath: ctx.worktreePath()
    })
  );
  if (!builder.passed) return ctx.finish("builder failed");

  const preReview = await ctx.work(
    "kiro_pre_review",
    input.kiroPreReviewPrompt ?? kiroPreReviewPrompt({
      cwd: input.cwd,
      runId: ctx.run().id,
      worktreePath: ctx.worktreePath()
    })
  );
  if (!preReview.passed) return ctx.finish("kiro pre-review failed");

  const repair = await ctx.work(
    "kiro_fix",
    input.kiroFixPrompt ?? kiroFixPrompt({
      cwd: input.cwd,
      runId: ctx.run().id,
      worktreePath: ctx.worktreePath()
    })
  );
  if (!repair.passed) return ctx.finish("kiro repair failed");

  await ctx.review(
    "final_qa",
    input.finalQaPrompt ?? finalQaPrompt({
      cwd: input.cwd,
      runId: ctx.run().id,
      worktreePath: ctx.worktreePath()
    })
  );

  return ctx.finish("architectBuilderKiroRepairQaWorkflow completed");
}

function architectPrompt(goal) {
  return [
    "You are the architect stage.",
    "",
    "Goal:",
    goal || "(no explicit goal supplied; infer from the project state)",
    "",
    "Write a concrete implementation plan for the builder. Do not implement."
  ].join("\n");
}

function builderPrompt({ cwd, runId, worktreePath }) {
  return [
    "You are the builder stage. Implement the architect output for this run.",
    "",
    `Worktree: ${worktreePath}`,
    `Artifacts: ${cwd}/.tychonic/runs/${runId}/artifacts/`,
    "",
    "Apply the plan as code changes and tests. Do not expand scope beyond the plan."
  ].join("\n");
}

function kiroPreReviewPrompt({ cwd, runId, worktreePath }) {
  return [
    "You are the Kiro pre-review stage.",
    `Review the current worktree: ${worktreePath}`,
    `Use artifacts under ${cwd}/.tychonic/runs/${runId}/artifacts/ as context.`,
    "",
    "Do not edit files in this stage.",
    "Write a concise prose review listing only clear, actionable issues.",
    "If there are no clear issues, say that explicitly."
  ].join("\n");
}

function kiroFixPrompt({ cwd, runId, worktreePath }) {
  return [
    "You are the Kiro repair stage.",
    `Worktree: ${worktreePath}`,
    `Read the Kiro pre-review output under ${cwd}/.tychonic/runs/${runId}/artifacts/.`,
    "",
    "Fix only clear issues from that pre-review. If it found no clear issues, make no changes and say so.",
    "Do not expand scope beyond the architect plan and Kiro pre-review."
  ].join("\n");
}

function finalQaPrompt({ cwd, runId, worktreePath }) {
  return [
    "You are the final structured QA reviewer.",
    `Check the final worktree in ${worktreePath}.`,
    `Use artifacts under ${cwd}/.tychonic/runs/${runId}/artifacts/ as context, including Kiro pre-review and Kiro repair output.`,
    "",
    "Report a semantic review verdict with status, summary, and findings.",
    "Each finding needs severity, title, and actionable detail.",
    "Use status pass only when findings is empty. Use status fail when any actionable finding exists."
  ].join("\n");
}
