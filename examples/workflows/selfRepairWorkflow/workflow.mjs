// Example Tychonic workflow bundle: selfRepairWorkflow.
//
// Install with:
//
//   (cd examples/workflows/selfRepairWorkflow && npm install)
//   tychonic workflows install ./examples/workflows/selfRepairWorkflow
//
// Operational installs refresh the LaunchAgent worker when one is installed.
// Isolated-instance installs require restarting that instance's runtime.
// See docs/plugin-workflows.md for the authoring guide.
//
// Detect bugs, write regression tests, review regression tests, fix bugs,
// verify, final review. Composes the host's per-TYPE activities the same
// way pipelineWorkflow does.

import { defineQuery, proxyActivities, setHandler } from "@temporalio/workflow";

const act = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
});

const {
  startRunActivity,
  createWorktreeActivity,
  runWorkerActivity,
  runReviewActivity,
  runVerifyActivity,
  finalizeRunActivity
} = act;

const workflowStateQuery = defineQuery("tychonic.workflow_state");

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    detect_bugs: {
      type: "review",
      agent: "codex",
      sandbox: "read-only",
      approval: "never",
      timeout: "20m"
    },
    write_regression_tests: {
      type: "work",
      agent: "codex",
      resume: 0,
      sandbox: "workspace-write",
      approval: "never",
      timeout: "30m"
    },
    review_regression_tests: {
      type: "review",
      agent: "codex",
      sandbox: "read-only",
      approval: "never",
      timeout: "20m"
    },
    fix_bugs: {
      type: "work",
      agent: "claude",
      resume: 3,
      permission_mode: "acceptEdits",
      timeout: "45m"
    },
    verify: {
      type: "verify",
      command: `npm run typecheck
npm run build
npm test
npm run validate:examples`,
      timeout: "30m"
    },
    final_review: {
      type: "review",
      agent: "codex",
      sandbox: "read-only",
      approval: "never",
      timeout: "20m"
    }
  },
  policies: { self_repair_workflow: { max_iterations: 3 } }
};

/**
 * Validate the bundle-owned `policies.self_repair_workflow` block. The
 * host config schema treats `policies` as opaque; this workflow
 * validates the keys it actually consumes.
 *
 * Rules:
 *  - unknown keys under `policies.self_repair_workflow` are rejected
 *  - `max_iterations` is a positive integer when present
 */
export function validateSelfRepairPolicy(policies) {
  if (!policies || policies.self_repair_workflow === undefined) return;
  const block = policies.self_repair_workflow;
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new Error("policies.self_repair_workflow must be an object");
  }
  const allowed = new Set(["max_iterations"]);
  for (const key of Object.keys(block)) {
    if (!allowed.has(key)) {
      throw new Error(
        `policies.self_repair_workflow.${key} is not a recognised key for selfRepairWorkflow`
      );
    }
  }
  if (block.max_iterations !== undefined) {
    if (!Number.isInteger(block.max_iterations) || block.max_iterations <= 0) {
      throw new Error(
        "policies.self_repair_workflow.max_iterations must be a positive integer"
      );
    }
  }
}

/**
 * `selfRepairWorkflow` — sequential bug-detect / regression-test /
 * fix / verify / final review.
 */
const SELF_REPAIR_WORKFLOW_INPUT_FIELDS = new Set(["cwd", "profile", "goal"]);

function rejectUnknownInputFields(input) {
  if (!input || typeof input !== "object") return;
  for (const field of Object.keys(input)) {
    if (!SELF_REPAIR_WORKFLOW_INPUT_FIELDS.has(field)) {
      throw new Error(`unsupported input field: ${field}`);
    }
  }
}

export async function selfRepairWorkflow(input) {
  rejectUnknownInputFields(input);
  validateSelfRepairPolicy(input.profile?.policies);
  let latestResult;
  setHandler(workflowStateQuery, () => latestResult);

  const profile = input.profile;
  let run = await startRunActivity({
    template: "self_repair_workflow",
    cwd: input.cwd,
    ...(profile ? { profile } : {}),
    ...(input.goal ? { goal: input.goal } : {})
  });
  run = { ...run, status: "running" };

  const wt = await createWorktreeActivity({ run, cwd: input.cwd });
  const worktreePath = wt.worktreePath;

  // Stage 1: detect_bugs
  const detect = await runReviewActivity({
    stateName: "detect_bugs", run,
    ...(profile ? { profile } : {}),
    cwd: input.cwd,
    worktreePath,
    prompt: detectBugsPrompt(input.goal)
  });
  run = applyResult(run, detect);

  // Stage 2: write_regression_tests
  const writeTests = await runWorkerActivity({
    stateName: "write_regression_tests", run,
    ...(profile ? { profile } : {}),
    cwd: input.cwd,
    worktreePath,
    prompt: writeRegressionTestsPrompt()
  });
  run = applyResult(run, writeTests);

  // Stage 3: review_regression_tests
  const reviewTests = await runReviewActivity({
    stateName: "review_regression_tests", run,
    ...(profile ? { profile } : {}),
    cwd: input.cwd,
    worktreePath,
    prompt: reviewRegressionTestsPrompt()
  });
  run = applyResult(run, reviewTests);

  // Stage 4: fix_bugs
  const fix = await runWorkerActivity({
    stateName: "fix_bugs", run,
    ...(profile ? { profile } : {}),
    cwd: input.cwd,
    worktreePath,
    prompt: fixBugsPrompt()
  });
  run = applyResult(run, fix);

  // Stage 5: verify
  const verify = await runVerifyActivity({
    stateName: "verify", run,
    ...(profile ? { profile } : {}),
    cwd: input.cwd,
    worktreePath
  });
  run = applyResult(run, verify);

  // Stage 6: final_review
  const finalReview = await runReviewActivity({
    stateName: "final_review", run,
    ...(profile ? { profile } : {}),
    cwd: input.cwd,
    worktreePath,
    prompt: finalReviewPrompt()
  });
  run = applyResult(run, finalReview);

  const fin = await finalizeRunActivity({ run });
  run = applyResult(run, fin);

  latestResult = {
    runId: run.id,
    status: run.status,
    run,
    artifactRoot: `${input.cwd}/.tychonic/runs/${run.id}`,
    worktreePath
  };
  return latestResult;
}

function applyResult(run, result) {
  let next = applyDelta(run, result?.delta || {});
  if (result?.commandOutcome) {
    next = { ...next, artifacts: [...next.artifacts, result.commandOutcome.artifact] };
  }
  if (result?.reviewOutcome && (result.reviewOutcome.kind === "parsed" || result.reviewOutcome.kind === "unparseable")) {
    next = {
      ...next,
      artifacts: [...next.artifacts, ...result.reviewOutcome.artifacts],
      agent_sessions: [...next.agent_sessions, ...result.reviewOutcome.agentSessions]
    };
  }
  if (result?.workerOutcome?.kind === "executed") {
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

function detectBugsPrompt(goal) {
  return [
    `Inspect the workspace and identify candidate bugs${goal ? ` in service of: ${goal}` : ""}.`,
    "",
    "Return only one JSON object matching this contract:",
    "{",
    '  "status": "pass|fail",',
    '  "summary": "short summary",',
    '  "findings": [',
    '    {"severity": "critical|high|medium|low", "title": "finding title", "detail": "actionable explanation"}',
    "  ]",
    "}",
    "Add target only when you can identify a file or symbol.",
    "Use status fail when at least one bug-shaped finding exists."
  ].join("\n");
}

function writeRegressionTestsPrompt() {
  return "Add regression tests that fail today against the bugs detected in the previous stage. Do not fix the bugs yet.";
}

function reviewRegressionTestsPrompt() {
  return "Review the newly added regression tests for correctness and coverage. Return one semantic review JSON object with status, summary, and findings.";
}

function fixBugsPrompt() {
  return "Fix the bugs covered by the regression tests so the entire test suite passes.";
}

function finalReviewPrompt() {
  return "Final review: confirm the bugs are fixed, regression tests pass, and no regressions are introduced. Return semantic review JSON with status, summary, and findings.";
}
