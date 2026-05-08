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
  "promptAdditions"
]);
const PROMPT_ADDITION_STATES = new Set(["architect", "builder", "qa"]);

function rejectUnknownInputFields(input) {
  if (!input || typeof input !== "object") return;
  for (const field of Object.keys(input)) {
    if (!INPUT_FIELDS.has(field)) {
      throw new Error(`unsupported input field: ${field}`);
    }
  }
  validatePromptAdditions(input, PROMPT_ADDITION_STATES);
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

  const qa = await ctx.review(
    "qa",
    withPromptAddition(
      qaStageInstructions({
        cwd: input.cwd,
        runId: ctx.run().id,
        worktreePath: ctx.worktreePath()
      }),
      input,
      "qa"
    )
  );
  if (!qa.passed) return ctx.finish(qa.summary ?? "qa did not pass");

  return ctx.finish();
}

function validatePromptAdditions(input, allowedStates) {
  const additions = input.promptAdditions;
  if (additions === undefined) return;
  if (!additions || typeof additions !== "object" || Array.isArray(additions)) {
    throw new Error("promptAdditions must be an object keyed by state name");
  }
  for (const stateName of Object.keys(additions)) {
    if (!allowedStates.has(stateName)) {
      throw new Error(`unsupported promptAdditions state: ${stateName}`);
    }
    if (
      input.profile?.states &&
      !Object.prototype.hasOwnProperty.call(input.profile.states, stateName)
    ) {
      throw new Error(`promptAdditions.${stateName} does not match a configured state`);
    }
    if (typeof additions[stateName] !== "string" || additions[stateName].trim() === "") {
      throw new Error(`promptAdditions.${stateName} must be a non-empty string`);
    }
  }
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

function qaStageInstructions({ cwd, runId, worktreePath }) {
  return [
    "You are the Kiro QA reviewer for this run.",
    `Check the builder output in ${worktreePath}.`,
    `Use artifacts under ${cwd}/.tychonic/runs/${runId}/artifacts/ as context.`,
    "",
    "Report concrete correctness issues, regressions, missing tests, and risky assumptions.",
    "The normalizer will structure your review; do not invent pass/fail criteria beyond the work."
  ].join("\n");
}
