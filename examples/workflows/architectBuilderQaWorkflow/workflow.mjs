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
import { validateLoopPolicy } from "./workflowPolicies.mjs";

const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

const act = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 3 }
});

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    architect: {
      type: "work",
      agent: "claude",
      model: "claude-opus-4-7",
      reasoning_effort: "max",
      timeout: "30m",
      permission_mode: "plan"
    },
    builder: {
      type: "work",
      agent: "kiro",
      model: "claude-opus-4.6",
      resume: 2,
      timeout: "60m",
      trust_all_tools: true,
      sandbox: "workspace-write",
      approval: "never"
    },
    qa: {
      type: "review",
      agent: "codex",
      model: "gpt-5.5",
      reasoning_effort: "xhigh",
      approval: "never",
      timeout: "30m"
    }
  },
  policies: {
    interaction: { mode: "auto" },
    loop: { max_review_iterations: 3 }
  }
};

export async function architectBuilderQaWorkflow(input) {
  const ctx = createTychonicWorkflowContext({
    input,
    template: "architect_builder_qa",
    activities: act
  });
  validateLoopPolicy(input.profile?.policies);

  await ctx.start();
  await ctx.createWorktree();

  const architect = await ctx.work(
    "architect",
    architectStageInstructions(input.goal ?? "")
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
        builderStageInstructions({
          runId: ctx.run().id,
          workflowId: ctx.workflowId(),
          worktreePath: ctx.worktreePath()
        }),
        qaFeedbacks
      )
    );
    if (!builder.passed) return ctx.finish(builder.summary ?? "builder failed");

    const qa = await ctx.review(
      "qa",
      qaStageInstructions({
        runId: ctx.run().id,
        workflowId: ctx.workflowId(),
        worktreePath: ctx.worktreePath()
      })
    );
    if (qa.halted) return ctx.finish(qa.summary);

    if (ctx.isInteractive()) {
      if (!qa.passed) return ctx.finish(qa.summary ?? "qa did not pass");
      break;
    }

    if (qa.passed) {
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

  return ctx.finish();
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

function architectStageInstructions(goal) {
  return [
    "You are the architect stage of a three-stage delegated-work pipeline.",
    "",
    "Goal:",
    goal || "(no explicit goal supplied; infer from the project state)",
    "",
    "Before designing, inspect the target project's applicable rules,",
    "specifications, and guardrails. Treat relevant constraints as part of",
    "the design input, and mention the constraints you applied in the design",
    "output. Do not invent constraints that are not present.",
    "",
    "Deliver a concrete design: file changes to make, public APIs to add or",
    "remove, validation steps, and explicit risks. Do NOT implement yet.",
    "Write the design as files in the current worktree (or as a structured",
    "Markdown document). The builder stage will consume your output directly."
  ].join("\n");
}

function builderStageInstructions({ runId, workflowId, worktreePath }) {
  return [
    "You are the builder stage. Implement the design produced by the",
    "architect stage of this run.",
    "",
    `Worktree:  ${worktreePath}`,
    ...evidenceCommandInstructions({ workflowId, runId }),
    "",
    "Before editing, inspect the target project's applicable rules and",
    "specifications. Follow relevant constraints while implementing, and",
    "include the constraints you checked plus compliance status in your",
    "final note.",
    "",
    "Apply the architect's design as code changes in the worktree. Write",
    "or update tests where the design calls for them. Do not expand the",
    "scope beyond the architect's instructions; if you discover a gap,",
    "describe it in a short note and stop so the reviewer stage can flag",
    "it back to the architect."
  ].join("\n");
}

function qaStageInstructions({ runId, workflowId, worktreePath }) {
  return [
    "You are the QA reviewer for this three-stage run.",
    ...evidenceCommandInstructions({ workflowId, runId }),
    `Check the builder output in ${worktreePath} against the architect`,
    "design captured in Tychonic artifact evidence.",
    "",
    "Include compliance with the target project's applicable rules,",
    "specifications, and guardrails in the review scope. Verify that the",
    "goal, architect design, builder output, and tests follow relevant",
    "constraints. Findings for violations must identify the violated",
    "constraint and concrete evidence.",
    "",
    "Report a semantic review verdict with status, summary, and findings.",
    "Each finding needs severity, title, and actionable detail.",
    "Add target or target_session_id only when you can identify one.",
    "Use status pass only when findings is empty. Use status fail when any actionable finding exists."
  ].join("\n");
}

function evidenceCommandInstructions({ workflowId, runId }) {
  const workflowArg = shellArg(workflowId);
  return [
    `Workflow: ${workflowId}`,
    `Run: ${runId}`,
    `Status command: tychonic status --workflow-id ${workflowArg}`,
    `Artifact command: tychonic artifacts --workflow-id ${workflowArg}`
  ];
}

function shellArg(value) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
