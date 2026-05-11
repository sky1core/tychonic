// Example Tychonic workflow bundle: 7-stage pipeline with two review instances
// of the same TYPE.

import { proxyActivities } from "@temporalio/workflow";
import { createTychonicWorkflowContext, validateTaskWorkflowInput } from "tychonic/workflow";

const act = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 3 }
});

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    work: {
      type: "work",
      agent: "kiro",
      model: "claude-opus-4.6",
      trust_all_tools: true,
      sandbox: "workspace-write",
      approval: "never"
    },
    static: { type: "verify", command: "npm run lint" },
    unit: { type: "verify", command: "npm test" },
    review_1: {
      type: "review",
      agent: "claude",
      model: "claude-opus-4-7",
      reasoning_effort: "max",
      permission_mode: "plan"
    },
    integration: { type: "verify", command: "npm run test:integration" },
    review_2: {
      type: "review",
      agent: "codex",
      model: "gpt-5.5",
      reasoning_effort: "xhigh",
      approval: "never"
    },
    security: { type: "verify", command: "./scripts/security-gate.sh" }
  },
  policies: {}
};

export async function pipelineWorkflow(input) {
  validateTaskWorkflowInput(input);
  const ctx = createTychonicWorkflowContext({
    input,
    template: "pipeline_7stage",
    activities: act
  });

  await ctx.start();
  await ctx.createWorktree();
  ctx.apply(await act.collectGitFactsActivity({ run: ctx.run(), cwd: input.cwd }));

  const work = await ctx.work(
    "work",
    withPromptAddition(input.goal ?? "", input, "work")
  );
  if (!work.passed) return ctx.finish("stage 1 work failed");

  for (const stateName of ["static", "unit"]) {
    const verify = await ctx.verify(stateName);
    if (!verify.passed) return ctx.finish(`stage ${stateName} failed`);
  }

  const review1 = await ctx.review(
    "review_1",
    withPromptAddition(structuredReviewPrompt("work stages 1-3"), input, "review_1")
  );
  const review1Gate = gateReviewStage(review1, "review_1");
  if (review1Gate.item) ctx.addInboxItem(review1Gate.item);
  if (review1Gate.done) return ctx.finish(review1Gate.summary);

  const integration = await ctx.verify("integration");
  if (!integration.passed) return ctx.finish("stage integration failed");

  const review2 = await ctx.review(
    "review_2",
    withPromptAddition(
      structuredReviewPrompt("integration and prior review follow-up"),
      input,
      "review_2"
    )
  );
  const review2Gate = gateReviewStage(review2, "review_2");
  if (review2Gate.item) ctx.addInboxItem(review2Gate.item);
  if (review2Gate.done) return ctx.finish(review2Gate.summary);

  const security = await ctx.verify("security");
  if (!security.passed) return ctx.finish("stage security failed");

  return ctx.finish();
}

function gateReviewStage(result, stateName) {
  const state = result.state;
  if (!state) {
    return { done: true, summary: `${stateName} produced no state` };
  }
  if (state.status === "succeeded") {
    return { done: false, summary: "" };
  }
  if (result.activityResult?.reviewOutcome?.kind === "unparseable") {
    return {
      item: reviewTriageInboxItem(state, result.activityResult.reviewOutcome.detail),
      done: true,
      summary: `${stateName} requires triage`
    };
  }
  return { done: true, summary: `${stateName} ${state.status}` };
}

function reviewTriageInboxItem(state, detail) {
  return {
    id: `inbox_review_${state.id}`,
    status: "open",
    title: `${state.name} requires triage`,
    detail,
    action: { kind: "triage", reason: detail },
    created_at: state.finished_at ?? state.started_at ?? new Date().toISOString()
  };
}

function withPromptAddition(basePrompt, input, stateName) {
  const addition = input.promptAdditions?.[stateName];
  if (addition === undefined) return basePrompt;
  return `${basePrompt}\n\n[additional ${stateName} instructions]\n${addition}\n[/additional ${stateName} instructions]`;
}

function structuredReviewPrompt(scope) {
  return [
    `Review ${scope} for correctness, regressions, missing tests, and risky assumptions.`,
    "",
    "Report a semantic review verdict with status, summary, and findings.",
    "Each finding needs severity, title, and actionable detail.",
    "Add target or target_session_id only when you can identify one.",
    "Use status pass only when findings is empty. Use status fail when any actionable finding exists."
  ].join("\n");
}
