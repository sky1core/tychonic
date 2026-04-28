// Example Tychonic workflow bundle: verifyOnlyWorkflow.
//
// Install with:
//
//   (cd examples/workflows/verifyOnlyWorkflow && npm install)
//   tychonic workflows install ./examples/workflows/verifyOnlyWorkflow
//
// This is the smallest runnable example: one deterministic verify state and
// no external AI agent dependency.

import { proxyActivities } from "@temporalio/workflow";

const {
  startRunActivity,
  collectGitFactsActivity,
  runVerifyActivity,
  finalizeRunActivity
} = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
});

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    verify: {
      type: "verify",
      command: `git status --short
git diff --check`
    }
  },
  policies: {}
};

const VERIFY_ONLY_INPUT_FIELDS = new Set(["cwd", "profile"]);

function rejectUnknownInputFields(input) {
  if (!input || typeof input !== "object") return;
  for (const field of Object.keys(input)) {
    if (!VERIFY_ONLY_INPUT_FIELDS.has(field)) {
      throw new Error(`unsupported input field: ${field}`);
    }
  }
}

export async function verifyOnlyWorkflow(input) {
  rejectUnknownInputFields(input);
  const profile = input.profile;
  let run = await startRunActivity({
    template: "verify_only",
    cwd: input.cwd,
    ...(profile ? { profile } : {})
  });
  run = { ...run, status: "running" };

  const facts = await collectGitFactsActivity({ run, cwd: input.cwd });
  run = apply(run, facts);

  const verify = await runVerifyActivity({
    stateName: "verify",
    run,
    cwd: input.cwd,
    ...(profile ? { profile } : {})
  });
  run = apply(run, verify);

  const final = await finalizeRunActivity({ run });
  run = apply(run, final);

  return {
    runId: run.id,
    status: run.status,
    run,
    artifactRoot: `${input.cwd}/.tychonic/runs/${run.id}`
  };
}

function apply(run, result) {
  const delta = result?.delta ?? {};
  let next = {
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
  if (result?.commandOutcome) {
    next = { ...next, artifacts: [...next.artifacts, result.commandOutcome.artifact] };
  }
  return next;
}
