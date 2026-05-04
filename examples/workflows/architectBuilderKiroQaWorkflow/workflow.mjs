// architectBuilderKiroQaWorkflow — architect/build pipeline with Kiro as the
// primary QA reviewer and a lightweight structured-output normalizer.

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
    qa: {
      type: "review",
      agent: "kiro",
      model: "claude-sonnet-4.5",
      normalizer: "codex",
      trust_all_tools: true,
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
  "qaPrompt"
]);

function rejectUnknownInputFields(input) {
  if (!input || typeof input !== "object") return;
  for (const field of Object.keys(input)) {
    if (!INPUT_FIELDS.has(field)) {
      throw new Error(`unsupported input field: ${field}`);
    }
  }
}

export async function architectBuilderKiroQaWorkflow(input) {
  rejectUnknownInputFields(input);
  const ctx = createTychonicWorkflowContext({
    input,
    template: "architect_builder_kiro_qa",
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

  await ctx.review(
    "qa",
    input.qaPrompt ?? qaPrompt({
      cwd: input.cwd,
      runId: ctx.run().id,
      worktreePath: ctx.worktreePath()
    })
  );

  return ctx.finish("architectBuilderKiroQaWorkflow completed");
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

function qaPrompt({ cwd, runId, worktreePath }) {
  return [
    "You are the Kiro QA reviewer for this run.",
    `Check the builder output in ${worktreePath}.`,
    `Use artifacts under ${cwd}/.tychonic/runs/${runId}/artifacts/ as context.`,
    "",
    "Report concrete correctness issues, regressions, missing tests, and risky assumptions.",
    "The normalizer will structure your review; do not invent pass/fail criteria beyond the work."
  ].join("\n");
}
