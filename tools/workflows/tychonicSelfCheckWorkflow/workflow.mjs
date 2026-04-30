import { proxyActivities } from "@temporalio/workflow";
import { createTychonicRunState } from "tychonic/workflow";

const {
  startRunActivity,
  collectGitFactsActivity,
  runVerifyActivity,
  finalizeRunActivity
} = proxyActivities({
  startToCloseTimeout: "6 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
});

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    bootstrap: {
      type: "verify",
      command: "node scripts/tychonic-bootstrap-check.mjs",
      timeout: "6h"
    }
  },
  policies: {}
};

const ALLOWED_INPUT_FIELDS = new Set(["cwd", "profile"]);

export async function tychonicSelfCheckWorkflow(input) {
  rejectUnknownInputFields(input);
  const cwd = requireString(input?.cwd, "cwd");
  const runState = createTychonicRunState();
  const profile = input.profile ?? defaultProfile;
  let run = await startRunActivity({
    template: "tychonicSelfCheckWorkflow",
    cwd,
    goal: "Run the Tychonic bootstrap self-check workflow."
  });
  run = runState.update({ ...run, status: "running" });
  const facts = await collectGitFactsActivity({ run, cwd });
  run = runState.update(applyResult(run, facts));
  const result = await runVerifyActivity({
    profile,
    stateName: "bootstrap",
    run,
    cwd
  });
  run = runState.update(applyResult(run, result));
  const final = await finalizeRunActivity({ run });
  run = applyResult(run, final);
  return runState.result(run);
}

function rejectUnknownInputFields(input) {
  if (!input || typeof input !== "object") return;
  for (const field of Object.keys(input)) {
    if (!ALLOWED_INPUT_FIELDS.has(field)) {
      throw new Error(`unsupported input field: ${field}`);
    }
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`input.${field} is required`);
  }
  return value;
}

function applyResult(run, result) {
  let next = applyDelta(run, result?.delta || {});
  if (result?.commandOutcome) {
    next = { ...next, artifacts: [...next.artifacts, result.commandOutcome.artifact] };
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
