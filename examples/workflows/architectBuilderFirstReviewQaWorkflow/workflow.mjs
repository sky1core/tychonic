// architectBuilderFirstReviewQaWorkflow — Claude plans, Kiro builds and performs
// the first normalized review, Codex runs only the final structured QA gate.

import { proxyActivities } from "@temporalio/workflow";
import { createTychonicWorkflowContext } from "tychonic/workflow";

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

export async function architectBuilderFirstReviewQaWorkflow(input) {
  const ctx = createTychonicWorkflowContext({
    input,
    template: "architect_builder_first_review_qa",
    activities: act
  });

  await ctx.start();
  await ctx.createWorktree();

  const architect = await ctx.work(
    "architect",
    architectStageInstructions(input.goal ?? "")
  );
  if (!architect.passed) return ctx.finish(architect.summary ?? "architect failed");

  const builder = await ctx.work(
    "builder",
    builderStageInstructions({
      runId: ctx.run().id,
      workflowId: ctx.workflowId(),
      worktreePath: ctx.worktreePath()
    })
  );
  if (!builder.passed) return ctx.finish(builder.summary ?? "builder failed");

  const firstReview = await ctx.review(
    "first_review",
    firstReviewStageInstructions({
      runId: ctx.run().id,
      workflowId: ctx.workflowId(),
      worktreePath: ctx.worktreePath()
    })
  );
  if (firstReview.halted) return ctx.finish(firstReview.summary);
  if (!firstReview.passed) {
    return ctx.finish(firstReview.summary ?? "first_review did not pass; final_qa was not run");
  }

  const finalQa = await ctx.review(
    "final_qa",
    finalQaStageInstructions({
      runId: ctx.run().id,
      workflowId: ctx.workflowId(),
      worktreePath: ctx.worktreePath()
    })
  );
  if (!finalQa.passed) return ctx.finish(finalQa.summary ?? "final_qa did not pass");

  return ctx.finish();
}

function architectStageInstructions(goal) {
  return [
    "You are the architect stage.",
    "",
    "Goal:",
    goal || "(no explicit goal supplied; infer from the project state)",
    "",
    "Before planning, inspect the target project's applicable rules,",
    "specifications, and guardrails. Treat relevant constraints as part of",
    "the plan input, and mention the constraints you applied in the plan.",
    "Do not invent constraints that are not present.",
    "",
    "Write a concrete implementation plan for the Kiro builder. Do not implement."
  ].join("\n");
}

function builderStageInstructions({ runId, workflowId, worktreePath }) {
  return [
    "You are the Kiro builder stage. Implement the architect output for this run.",
    "",
    `Worktree: ${worktreePath}`,
    ...evidenceCommandInstructions({ workflowId, runId }),
    "",
    "Before editing, inspect the target project's applicable rules and",
    "specifications. Follow relevant constraints while implementing, and",
    "include the constraints you checked plus compliance status in your",
    "final note.",
    "",
    "Apply the architect plan as code changes and tests. Do not expand scope beyond the plan."
  ].join("\n");
}

function firstReviewStageInstructions({ runId, workflowId, worktreePath }) {
  return [
    "You are the first QA reviewer for this run.",
    ...evidenceCommandInstructions({ workflowId, runId }),
    `Review the Kiro builder output in ${worktreePath}.`,
    "Use Tychonic artifact evidence as context.",
    "",
    "Include compliance with the target project's applicable rules,",
    "specifications, and guardrails in the review scope. Verify that the",
    "goal, plan, implementation, and tests follow relevant constraints.",
    "Findings for violations must identify the violated constraint and",
    "concrete evidence.",
    "",
    "Filter out clear correctness issues before Codex final QA runs.",
    "Report concrete regressions, missing tests, unsafe assumptions, and scope drift.",
    "Do not repair code in this stage. The normalizer will structure only your review."
  ].join("\n");
}

function finalQaStageInstructions({ runId, workflowId, worktreePath }) {
  return [
    "You are the final Codex QA reviewer for this run.",
    ...evidenceCommandInstructions({ workflowId, runId }),
    `Check the final worktree in ${worktreePath}.`,
    "Use Tychonic artifact evidence as context, including Kiro's first review.",
    "",
    "Include compliance with the target project's applicable rules,",
    "specifications, and guardrails in the review scope. Verify that the",
    "goal, plan, implementation, first review result, and tests follow",
    "relevant constraints. Findings for violations must identify the",
    "violated constraint and concrete evidence.",
    "",
    "Report a semantic review verdict with status, summary, and findings.",
    "Each finding needs severity, title, and actionable detail.",
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
