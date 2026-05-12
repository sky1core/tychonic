// architectBuilderFinalQaWorkflow — Claude plans, Kiro builds, Codex performs
// the final structured QA gate.

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
  policies: {}
};

export async function architectBuilderFinalQaWorkflow(input) {
  const ctx = createTychonicWorkflowContext({
    input,
    template: "architect_builder_final_qa",
    activities: act
  });

  await ctx.start();
  await ctx.createWorktree();

  const architect = await ctx.work(
    "architect",
    architectStageInstructions(input.goal ?? "")
  );
  if (!architect.passed) return ctx.finish("architect failed");

  const builder = await ctx.work(
    "builder",
    builderStageInstructions({
      cwd: input.cwd,
      runId: ctx.run().id,
      worktreePath: ctx.worktreePath()
    })
  );
  if (!builder.passed) return ctx.finish("builder failed");

  const qa = await ctx.review(
    "qa",
    qaStageInstructions({
      cwd: input.cwd,
      runId: ctx.run().id,
      worktreePath: ctx.worktreePath()
    })
  );
  if (!qa.passed) return ctx.finish(qa.summary ?? "qa did not pass");

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
    "Before editing, inspect the target project's applicable rules and",
    "specifications. Follow relevant constraints while implementing, and",
    "include the constraints you checked plus compliance status in your",
    "final note.",
    "",
    "Apply the plan as code changes and tests. Do not expand scope beyond the plan."
  ].join("\n");
}

function qaStageInstructions({ cwd, runId, worktreePath }) {
  return [
    "You are the final Codex QA reviewer for this run.",
    `Check the builder output in ${worktreePath}.`,
    `Use artifacts under ${cwd}/.tychonic/runs/${runId}/artifacts/ as context.`,
    "",
    "Include compliance with the target project's applicable rules,",
    "specifications, and guardrails in the review scope. Verify that the",
    "goal, plan, implementation, and tests follow relevant constraints.",
    "Findings for violations must identify the violated constraint and",
    "concrete evidence.",
    "",
    "Report concrete correctness issues, regressions, missing tests, and risky assumptions.",
    "Return the structured pass/fail review verdict for this workflow."
  ].join("\n");
}
