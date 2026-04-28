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
// two structured reviews (semantic_review, test_review). Deterministic gates
// all use the `verify` TYPE; their state NAMEs carry the workflow-specific
// meaning.

import { proxyActivities } from "@temporalio/workflow";
import { validateIntegrationPolicy } from "./integrationPolicy.mjs";

const act = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
});

const {
  startRunActivity,
  collectGitFactsActivity,
  runVerifyActivity,
  runReviewActivity,
  finalizeRunActivity
} = act;

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    lint: { type: "verify", command: "npm run lint", timeout: "10m" },
    unit_test: { type: "verify", command: "npm test", timeout: "30m" },
    integration: { type: "verify", command: "npm run integration", timeout: "45m" },
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
  policies: { integration: { position: "final_gate" } }
};

/**
 * `checkpointWorkflow` — deterministic gates plus structured reviews.
 *
 * Input: { cwd, goal? }
 * Host-injected: profile?: TychonicConfig
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
    const res = await runVerifyActivity({
      stateName: "lint", run,
      ...(profile ? { profile } : {}),
      cwd: input.cwd
    });
    run = applyResult(run, res);
  }

  // Stage: unit_test
  if (profile?.states?.unit_test) {
    const res = await runVerifyActivity({
      stateName: "unit_test", run,
      ...(profile ? { profile } : {}),
      cwd: input.cwd
    });
    run = applyResult(run, res);
  }

  // Stage: integration (pre-review when policy says before_ai_review)
  if (integrationPosition === "before_ai_review" && profile?.states?.integration) {
    const res = await runVerifyActivity({
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

  // Stage: integration (after semantic review, before test review).
  if (integrationPosition === "after_ai_review" && profile?.states?.integration) {
    const res = await runVerifyActivity({
      stateName: "integration", run,
      ...(profile ? { profile } : {}),
      cwd: input.cwd
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
    const res = await runVerifyActivity({
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
    next = appendReviewFindings(next, result);
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

function appendReviewFindings(run, result) {
  const outcome = result?.reviewOutcome;
  if (!outcome || outcome.kind !== "parsed" || outcome.result.status !== "fail") return run;
  const sourceState = result.delta?.states?.[0];
  if (!sourceState) return run;

  let next = run;
  const findingIds = [];
  for (const finding of outcome.result.findings) {
    const id = nextLocalId(next, "finding");
    findingIds.push(id);
    next = {
      ...next,
      findings: [
        ...next.findings,
        {
          id,
          status: "new",
          severity: finding.severity,
          title: finding.title,
          detail: finding.detail,
          ...(finding.target ? { target: finding.target } : {}),
          source_state_id: sourceState.id,
          ...(outcome.reviewerSessionId ? { source_review_session_id: outcome.reviewerSessionId } : {}),
          ...(finding.target_session_id ? { target_work_session_id: finding.target_session_id } : {}),
          created_at: nowIso()
        }
      ]
    };
  }

  return {
    ...next,
    states: next.states.map((state) =>
      state.id === sourceState.id
        ? { ...state, finding_ids: [...state.finding_ids, ...findingIds] }
        : state
    )
  };
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

function nextLocalId(run, prefix) {
  const counter =
    run.states.length +
    run.activity_attempts.length +
    run.artifacts.length +
    run.findings.length +
    run.inbox.length +
    run.agent_sessions.length;
  return `${prefix}_${counter + 1}`;
}

function nowIso() {
  return new Date().toISOString();
}

function structuredReviewPrompt(scope) {
  return [
    `Review ${scope} for correctness, regressions, missing tests, and risky assumptions.`,
    "",
    "Report a semantic review verdict with status, summary, and findings.",
    "Each finding needs severity, title, and actionable detail.",
    "Add target only when you can identify a file or state.",
    "Use status pass only when findings is empty. Use status fail when any actionable finding exists."
  ].join("\n");
}
