// Example Tychonic workflow bundle: checkpointWorkflow.
//
// Single-pass deterministic gates (lint -> unit_test -> integration) plus two
// structured reviews (semantic_review, test_review). Deterministic gates all
// use the `verify` TYPE; their state NAMEs carry workflow-specific meaning.

import { proxyActivities } from "@temporalio/workflow";
import { createTychonicWorkflowContext } from "tychonic/workflow";
import { validateIntegrationPolicy } from "./integrationPolicy.mjs";

const act = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
});

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    lint: { type: "verify", command: "npm run lint", timeout: "10m" },
    unit_test: { type: "verify", command: "npm test", timeout: "30m" },
    integration: { type: "verify", command: "npm run integration", timeout: "45m" },
    semantic_review: {
      type: "review",
      agent: "codex",
      approval: "never",
      timeout: "20m"
    },
    test_review: {
      type: "review",
      agent: "claude",
      permission_mode: "plan",
      timeout: "20m"
    }
  },
  policies: { integration: { position: "final_gate" } }
};

const CHECKPOINT_WORKFLOW_INPUT_FIELDS = new Set(["cwd", "profile", "goal"]);

function rejectUnknownInputFields(input) {
  if (!input || typeof input !== "object") return;
  for (const field of Object.keys(input)) {
    if (!CHECKPOINT_WORKFLOW_INPUT_FIELDS.has(field)) {
      throw new Error(`unsupported input field: ${field}`);
    }
  }
}

export async function checkpointWorkflow(input) {
  rejectUnknownInputFields(input);
  validateIntegrationPolicy(input.profile?.policies);

  const ctx = createTychonicWorkflowContext({
    input,
    template: "checkpoint",
    activities: act
  });
  const profile = input.profile;
  const integrationPosition = profile?.policies?.integration?.position ?? "final_gate";

  await ctx.start();
  ctx.apply(await act.collectGitFactsActivity({ run: ctx.run(), cwd: input.cwd }));

  if (profile?.states?.lint) {
    await ctx.verify("lint");
  }
  if (profile?.states?.unit_test) {
    await ctx.verify("unit_test");
  }
  if (integrationPosition === "before_ai_review" && profile?.states?.integration) {
    await ctx.verify("integration");
  }
  if (profile?.states?.semantic_review) {
    await ctx.review("semantic_review", structuredReviewPrompt("changes", input.goal));
  }
  if (integrationPosition === "after_ai_review" && profile?.states?.integration) {
    await ctx.verify("integration");
  }
  if (profile?.states?.test_review) {
    await ctx.review("test_review", structuredReviewPrompt("test coverage", input.goal));
  }
  if (integrationPosition === "final_gate" && profile?.states?.integration) {
    await ctx.verify("integration");
  }

  return ctx.finish("checkpointWorkflow completed");
}

function structuredReviewPrompt(scope, goal) {
  const lines = [
    `Review ${scope} for correctness, regressions, missing tests, and risky assumptions.`,
    "",
    ...(goal ? ["Workflow goal and review scope:", goal, ""] : []),
    "Report a semantic review verdict with status, summary, and findings.",
    "Each finding needs severity, title, and actionable detail.",
    "Add target only when you can identify a file or state.",
    "Use status pass only when findings is empty. Use status fail when any actionable finding exists."
  ];
  return lines.join("\n");
}
