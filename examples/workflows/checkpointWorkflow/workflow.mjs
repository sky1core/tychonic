// Example Tychonic workflow bundle: checkpointWorkflow.
//
// Install with:
//
//   (cd examples/workflows/checkpointWorkflow && npm install)
//   tychonic workflows install ./examples/workflows/checkpointWorkflow
//
// Operational installs refresh the LaunchAgent worker when one is installed.
// Isolated-instance installs require restarting that instance's runtime.
// See docs/plugin-workflows.md for the authoring guide.
//
// Single-pass deterministic gates (lint -> unit_test -> integration) plus
// two structured reviews (semantic_review, test_review). Composes the
// host's per-TYPE activities the same way pipelineWorkflow does.

import { proxyActivities } from "@temporalio/workflow";

const act = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
});

const {
  startRunActivity,
  collectGitFactsActivity,
  runLintActivity,
  runUnitTestActivity,
  runIntegrationActivity,
  runReviewActivity,
  finalizeRunActivity
} = act;

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    lint: { type: "lint", command: "npm run lint", timeout: "10m" },
    unit_test: { type: "unit_test", command: "npm test", timeout: "30m" },
    integration: { type: "integration", command: "npm run integration", timeout: "45m" },
    semantic_review: {
      type: "review",
      agent: "codex",
      sandbox: "read-only",
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
  policies: { integration: { mode: "required", position: "final_gate" } }
};

/**
 * Validate the bundle-owned `policies.integration` block. The host
 * config schema treats `policies` as opaque; this workflow validates
 * the keys it actually consumes.
 *
 * Rules:
 *  - unknown keys under `policies.integration` are rejected
 *  - `mode` must be one of disabled / manual / auto_on_relevant_changes / required
 *  - `position` must be one of before_ai_review / after_ai_review / final_gate
 *  - both `mode` and `position` are required when the block is present
 */
export function validateIntegrationPolicy(policies) {
  if (!policies || policies.integration === undefined) return;
  const block = policies.integration;
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new Error("policies.integration must be an object");
  }
  const allowedKeys = new Set(["mode", "position"]);
  for (const key of Object.keys(block)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `policies.integration.${key} is not a recognised key for checkpointWorkflow`
      );
    }
  }
  const allowedModes = new Set([
    "disabled",
    "manual",
    "auto_on_relevant_changes",
    "required"
  ]);
  if (block.mode === undefined) {
    throw new Error("policies.integration.mode is required when the block is present");
  }
  if (!allowedModes.has(block.mode)) {
    throw new Error(
      `policies.integration.mode must be one of ${[...allowedModes].join(", ")}; got ${JSON.stringify(block.mode)}`
    );
  }
  const allowedPositions = new Set([
    "before_ai_review",
    "after_ai_review",
    "final_gate"
  ]);
  if (block.position === undefined) {
    throw new Error(
      "policies.integration.position is required when the block is present"
    );
  }
  if (!allowedPositions.has(block.position)) {
    throw new Error(
      `policies.integration.position must be one of ${[...allowedPositions].join(", ")}; got ${JSON.stringify(block.position)}`
    );
  }
}

/**
 * `checkpointWorkflow` — deterministic gates plus structured reviews.
 *
 * Input: { cwd, profile?, goal? }
 */
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
  const profile = input.profile;
  let run = await startRunActivity({
    template: "checkpoint",
    cwd: input.cwd,
    ...(profile ? { profile } : {}),
    ...(input.goal ? { goal: input.goal } : {})
  });
  run = { ...run, status: "running" };

  // Collect git facts to drive skip decisions.
  const facts = await collectGitFactsActivity({ run, cwd: input.cwd });
  run = applyResult(run, facts);

  const integrationPosition = profile?.policies?.integration?.position ?? "final_gate";

  // Stage: lint
  if (profile?.states?.lint) {
    const res = await runLintActivity({
      stateName: "lint", run,
      ...(profile ? { profile } : {}),
      cwd: input.cwd
    });
    run = applyResult(run, res);
  }

  // Stage: unit_test
  if (profile?.states?.unit_test) {
    const res = await runUnitTestActivity({
      stateName: "unit_test", run,
      ...(profile ? { profile } : {}),
      cwd: input.cwd
    });
    run = applyResult(run, res);
  }

  // Stage: integration (pre-review when policy says before_ai_review)
  if (integrationPosition === "before_ai_review" && profile?.states?.integration) {
    const res = await runIntegrationActivity({
      stateName: "integration", run,
      ...(profile ? { profile } : {}),
      cwd: input.cwd
    });
    run = applyResult(run, res);
  }

  // Stage: semantic_review
  if (profile?.states?.semantic_review) {
    const res = await runReviewActivity({
      stateName: "semantic_review", run,
      ...(profile ? { profile } : {}),
      cwd: input.cwd,
      prompt: structuredReviewPrompt("changes")
    });
    run = applyResult(run, res);
  }

  // Stage: test_review
  if (profile?.states?.test_review) {
    const res = await runReviewActivity({
      stateName: "test_review", run,
      ...(profile ? { profile } : {}),
      cwd: input.cwd,
      prompt: structuredReviewPrompt("test coverage")
    });
    run = applyResult(run, res);
  }

  // Stage: integration (final_gate, the default)
  if (integrationPosition === "final_gate" && profile?.states?.integration) {
    const res = await runIntegrationActivity({
      stateName: "integration", run,
      ...(profile ? { profile } : {}),
      cwd: input.cwd
    });
    run = applyResult(run, res);
  }

  const fin = await finalizeRunActivity({ run });
  run = applyResult(run, fin);

  return {
    runId: run.id,
    status: run.status,
    run,
    artifactRoot: `${input.cwd}/.tychonic/runs/${run.id}`
  };
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

function structuredReviewPrompt(scope) {
  return [
    `Review ${scope} for correctness, regressions, missing tests, and risky assumptions.`,
    "",
    "Return only one JSON object matching this contract. Do not wrap it in markdown.",
    "{",
    '  "schema_version": "tychonic.review.v1",',
    '  "status": "pass|fail",',
    '  "summary": "short result summary",',
    '  "findings": [',
    '    {"severity": "critical|high|medium|low", "title": "finding title", "detail": "actionable explanation", "target": "file or state"}',
    "  ]",
    "}",
    "Use status pass only when findings is empty. Use status fail when any actionable finding exists."
  ].join("\n");
}
