// architectBuilderQaWorkflow — interactive 3-stage delegated-work pipeline.
//
// Stages:
//   1. architect (work) — drafts the design / plan.
//   2. builder   (work) — implements the design.
//   3. qa        (review) — returns `tychonic.review.v1`.
//
// The workflow owns the state order and the QA loop. Shared Tychonic run
// bookkeeping is handled by `createTychonicWorkflowContext` so the module stays
// focused on orchestration.

import { proxyActivities } from "@temporalio/workflow";
import { createTychonicWorkflowContext } from "tychonic/workflow";
import {
  validateInteractionPolicy,
  validateLoopPolicy
} from "./workflowPolicies.mjs";

const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

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
      timeout: "30m",
      permission_mode: "plan"
    },
    builder: {
      type: "work",
      agent: "codex",
      resume: 2,
      timeout: "60m",
      sandbox: "workspace-write",
      approval: "never"
    },
    qa: {
      type: "review",
      agent: "claude",
      permission_mode: "plan",
      timeout: "30m"
    }
  },
  policies: {
    interaction: { mode: "auto" },
    loop: { max_review_iterations: 3 }
  }
};

const ARCHITECT_BUILDER_QA_INPUT_FIELDS = new Set([
  "cwd",
  "profile",
  "goal",
  "architectPrompt",
  "builderPrompt",
  "qaPrompt"
]);

function rejectUnknownInputFields(input) {
  if (!input || typeof input !== "object") return;
  for (const field of Object.keys(input)) {
    if (!ARCHITECT_BUILDER_QA_INPUT_FIELDS.has(field)) {
      throw new Error(`unsupported input field: ${field}`);
    }
  }
}

export async function architectBuilderQaWorkflow(input) {
  rejectUnknownInputFields(input);
  validateInteractionPolicy(input.profile?.policies);
  validateLoopPolicy(input.profile?.policies);

  const ctx = createTychonicWorkflowContext({
    input,
    template: "architect_builder_qa",
    activities: act
  });

  await ctx.start();
  await ctx.createWorktree();

  const architect = await ctx.work(
    "architect",
    input.architectPrompt ?? architectPrompt(input.goal ?? "")
  );
  if (!architect.passed) return ctx.finish(architect.summary ?? "architect failed");

  const maxReviewIterations =
    input.profile?.policies?.loop?.max_review_iterations ?? DEFAULT_MAX_REVIEW_ITERATIONS;
  const qaFeedbacks = [];
  let reviewIteration = 0;

  while (true) {
    reviewIteration += 1;

    const builder = await ctx.work(
      "builder",
      withQaFeedback(
        input.builderPrompt ?? builderPrompt({
          runId: ctx.run().id,
          worktreePath: ctx.worktreePath()
        }),
        qaFeedbacks
      )
    );
    if (!builder.passed) return ctx.finish(builder.summary ?? "builder failed");

    const qa = await ctx.review(
      "qa",
      input.qaPrompt ?? qaPrompt({
        runId: ctx.run().id,
        worktreePath: ctx.worktreePath()
      })
    );
    if (qa.halted) return ctx.finish(qa.summary);

    if (ctx.isInteractive() || qa.passed) {
      break;
    }
    if (reviewIteration >= maxReviewIterations) {
      return ctx.finishWaitingUser(
        `qa review did not pass within ${maxReviewIterations} iterations`,
        reviewCapInboxItem()
      );
    }
    qaFeedbacks.push(
      `QA iteration ${reviewIteration} verdict: ${qa.reason ?? "(no reason recorded)"}`
    );
  }

  return ctx.finish("architectBuilderQaWorkflow completed");
}

function withQaFeedback(basePrompt, feedbacks) {
  if (feedbacks.length === 0) return basePrompt;
  return `${basePrompt}\n\n[qa findings from previous iteration(s)]\n${feedbacks
    .map((feedback, index) => `${index + 1}. ${feedback}`)
    .join("\n")}\n[/qa findings]`;
}

function reviewCapInboxItem() {
  return {
    id: "inbox_review_cap",
    status: "open",
    title: "Auto-mode review iteration cap reached",
    detail:
      "qa stage did not report pass within policies.loop.max_review_iterations; builder did not converge. " +
      "Inspect run.states and run.findings, then start a fresh run with adjusted input/config.",
    action: { kind: "triage", reason: "qa review loop cap reached in auto mode" },
    created_at: new Date().toISOString()
  };
}

function architectPrompt(goal) {
  return [
    "You are the architect stage of a three-stage delegated-work pipeline.",
    "",
    "Goal:",
    goal || "(no explicit goal supplied; infer from the project state)",
    "",
    "Deliver a concrete design: file changes to make, public APIs to add or",
    "remove, validation steps, and explicit risks. Do NOT implement yet.",
    "Write the design as files in the current worktree (or as a structured",
    "Markdown document). The builder stage will consume your output directly."
  ].join("\n");
}

function builderPrompt({ runId, worktreePath }) {
  return [
    "You are the builder stage. Implement the design produced by the",
    "architect stage of this run.",
    "",
    `Worktree:  ${worktreePath}`,
    `Artifacts: .tychonic/runs/${runId}/artifacts/`,
    "",
    "Apply the architect's design as code changes in the worktree. Write",
    "or update tests where the design calls for them. Do not expand the",
    "scope beyond the architect's instructions; if you discover a gap,",
    "describe it in a short note and stop so the reviewer stage can flag",
    "it back to the architect."
  ].join("\n");
}

function qaPrompt({ runId, worktreePath }) {
  return [
    "You are the QA reviewer for this three-stage run.",
    `Check the builder output in ${worktreePath} against the architect`,
    `design captured under .tychonic/runs/${runId}/artifacts/.`,
    "",
    "Report a semantic review verdict with status, summary, and findings.",
    "Each finding needs severity, title, and actionable detail.",
    "Add target or target_session_id only when you can identify one.",
    "Use status pass only when findings is empty. Use status fail when any actionable finding exists."
  ].join("\n");
}
