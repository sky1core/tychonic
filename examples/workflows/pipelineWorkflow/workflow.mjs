// Example Tychonic workflow bundle: 7-stage pipeline with two review
// instances of the same TYPE.
//
// Install with:
//
//   (cd examples/workflows/pipelineWorkflow && npm install)
//   tychonic workflows install ./examples/workflows/pipelineWorkflow
//
// Operational installs refresh the LaunchAgent worker when one is installed.
// Isolated-instance installs require restarting that instance's runtime.
// See docs/plugin-workflows.md for the authoring guide.

import { proxyActivities } from "@temporalio/workflow";

const act = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
});

const {
  startRunActivity,
  createWorktreeActivity,
  collectGitFactsActivity,
  runWorkerActivity,
  runReviewActivity,
  runVerifyActivity,
  finalizeRunActivity
} = act;

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    work: {
      type: "work",
      agent: "claude",
      resume: 0,
      permission_mode: "acceptEdits"
    },
    static: { type: "verify", command: "npm run lint" },
    unit: { type: "verify", command: "npm test" },
    review_1: {
      type: "review",
      agent: "claude",
      permission_mode: "plan"
    },
    integration: { type: "verify", command: "npm run test:integration" },
    review_2: {
      type: "review",
      agent: "codex",
      sandbox: "read-only",
      approval: "never"
    },
    security: { type: "verify", command: "./scripts/security-gate.sh" }
  },
  policies: {}
};

/**
 * 7-stage pipeline. Two states named `review_1` and `review_2` are
 * instances of the same TYPE `review` calling the same
 * `runReviewActivity` function with different NAMEs. SPEC §State
 * Identity And Activity TYPE.
 *
 * Input:
 *   { cwd, goal?, prompt?, reviewPrompt?, reviewPrompt2? }
 * Host-injected:
 *   { profile?: TychonicConfig }
 *
 * Result:
 *   { runId, status, run, artifactRoot, summary? }
 */
const PIPELINE_WORKFLOW_INPUT_FIELDS = new Set([
  "cwd",
  "profile",
  "goal",
  "prompt",
  "reviewPrompt",
  "reviewPrompt2"
]);

function rejectUnknownInputFields(input) {
  if (!input || typeof input !== "object") return;
  for (const field of Object.keys(input)) {
    if (!PIPELINE_WORKFLOW_INPUT_FIELDS.has(field)) {
      throw new Error(`unsupported input field: ${field}`);
    }
  }
}

export async function pipelineWorkflow(input) {
  rejectUnknownInputFields(input);
  const profile = input.profile;
  let run = await startRunActivity({
    template: "pipeline_7stage",
    cwd: input.cwd,
    ...(profile ? { profile } : {}),
    ...(input.goal ? { goal: input.goal } : {})
  });

  const wt = await createWorktreeActivity({ run, cwd: input.cwd });
  const worktreePath = wt.worktreePath;

  run = apply(run, await collectGitFactsActivity({ run, cwd: input.cwd }));

  // Stage 1: work (worker invocation, single call).
  const work = await runWorkerActivity({
    stateName: "work",
    run,
    cwd: input.cwd,
    profile,
    worktreePath,
    prompt: input.prompt ?? input.goal ?? ""
  });
  run = apply(run, work);
  if (work.workerOutcome?.status !== "succeeded") {
    return done(run, input.cwd, "stage 1 work failed");
  }

  // Stages 2-3: deterministic checks.
  for (const stateName of ["static", "unit"]) {
    const res = await runVerifyActivity({
      stateName,
      run,
      cwd: input.cwd,
      profile,
      worktreePath
    });
    run = apply(run, res);
    if (res.delta.states?.[0]?.status !== "succeeded") {
      return done(run, input.cwd, `stage ${stateName} failed`);
    }
  }

  // Stage 4: review_1 (review TYPE, first NAME).
  const review1 = await runReviewActivity({
    stateName: "review_1",
    run,
    cwd: input.cwd,
    profile,
    worktreePath,
    prompt: input.reviewPrompt ?? structuredReviewPrompt("work stages 1-3")
  });
  run = apply(run, review1);
  const review1Decision = gateReviewStage(run, review1, "review_1");
  run = review1Decision.run;
  if (review1Decision.done) {
    return done(run, input.cwd, review1Decision.summary);
  }

  // Stage 5: integration.
  run = apply(run, await runVerifyActivity({
    stateName: "integration",
    run,
    cwd: input.cwd,
    profile,
    worktreePath
  }));

  // Stage 6: review_2 (review TYPE, second NAME — same activity function).
  const review2 = await runReviewActivity({
    stateName: "review_2",
    run,
    cwd: input.cwd,
    profile,
    worktreePath,
    prompt: input.reviewPrompt2 ?? structuredReviewPrompt("integration and prior review follow-up")
  });
  run = apply(run, review2);
  const review2Decision = gateReviewStage(run, review2, "review_2");
  run = review2Decision.run;
  if (review2Decision.done) {
    return done(run, input.cwd, review2Decision.summary);
  }

  // Stage 7: security gate (verify TYPE, user-chosen NAME).
  run = apply(run, await runVerifyActivity({
    stateName: "security",
    run,
    cwd: input.cwd,
    profile,
    worktreePath
  }));

  return done(run, input.cwd, `pipeline_7stage finished: ${run.states.map((s) => `${s.name}=${s.status}`).join(", ")}`);
}

// Pure merge of an ActivityResult into the local run record.
// Equivalent to `applyActivityResult` in src/workflows/runMerge.ts
// — inlined so the example is fully self-contained.
function apply(run, result) {
  let next = applyDelta(run, result.delta || {});
  if (result.commandOutcome) {
    next = { ...next, artifacts: [...next.artifacts, result.commandOutcome.artifact] };
  }
  if (result.reviewOutcome && (result.reviewOutcome.kind === "parsed" || result.reviewOutcome.kind === "unparseable")) {
    next = {
      ...next,
      artifacts: [...next.artifacts, ...result.reviewOutcome.artifacts],
      agent_sessions: [...next.agent_sessions, ...result.reviewOutcome.agentSessions]
    };
  }
  if (result.workerOutcome?.kind === "executed") {
    next = {
      ...next,
      artifacts: [...next.artifacts, ...result.workerOutcome.artifacts],
      agent_sessions: [...next.agent_sessions, ...result.workerOutcome.agentSessions]
    };
  }
  return next;
}

function applyDelta(run, delta) {
  const next = {
    ...run,
    states: delta.states ? [...run.states, ...delta.states] : [...run.states],
    activity_attempts: delta.activityAttempts
      ? [...run.activity_attempts, ...delta.activityAttempts]
      : [...run.activity_attempts],
    facts: delta.facts ? { ...(run.facts ?? {}), ...delta.facts } : run.facts,
    status: delta.status ?? run.status,
    agent_sessions: [...run.agent_sessions],
    artifacts: [...run.artifacts],
    findings: [...run.findings],
    inbox: [...run.inbox]
  };
  if (delta.summary !== undefined) next.summary = delta.summary;
  else if (run.summary !== undefined) next.summary = run.summary;
  return next;
}

async function done(run, cwd, summary) {
  const fin = await finalizeRunActivity({ run, summary });
  run = apply(run, fin);
  return {
    runId: run.id,
    status: run.status,
    run,
    artifactRoot: `${cwd}/.tychonic/runs/${run.id}`,
    ...(run.summary ? { summary: run.summary } : {})
  };
}

function gateReviewStage(run, result, stateName) {
  const state = result.delta?.states?.[0];
  if (!state) {
    return { run, done: true, summary: `${stateName} produced no state` };
  }
  if (state.status === "succeeded") {
    return { run, done: false, summary: "" };
  }
  if (result.reviewOutcome?.kind === "unparseable") {
    return {
      run: addReviewTriageInbox(run, state, result.reviewOutcome.detail),
      done: true,
      summary: `${stateName} requires triage`
    };
  }
  return { run, done: true, summary: `${stateName} ${state.status}` };
}

function addReviewTriageInbox(run, state, detail) {
  const inboxId = `inbox_review_${state.id}`;
  if (run.inbox.some((item) => item.id === inboxId)) {
    return run;
  }
  return {
    ...run,
    inbox: [
      ...run.inbox,
      {
        id: inboxId,
        status: "open",
        title: `${state.name} requires triage`,
        detail,
        action: { kind: "triage", reason: detail },
        created_at: state.finished_at ?? state.started_at ?? new Date().toISOString()
      }
    ]
  };
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
