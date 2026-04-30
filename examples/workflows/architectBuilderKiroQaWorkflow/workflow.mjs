// architectBuilderKiroQaWorkflow — architect/build pipeline with Kiro as the
// primary QA reviewer and a lightweight structured-output normalizer.

import { proxyActivities } from "@temporalio/workflow";
import { createTychonicRunState } from "tychonic/workflow";

const {
  startRunActivity,
  createWorktreeActivity,
  runWorkerActivity,
  runReviewActivity,
  finalizeRunActivity
} = proxyActivities({
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
  const runState = createTychonicRunState();
  let worktreePath;
  const updateRun = (next) => runState.update(next, worktreePath ? { worktreePath } : {});
  const profile = input.profile;
  let run = await startRunActivity({
    template: "architect_builder_kiro_qa",
    cwd: input.cwd,
    ...(profile ? { profile } : {}),
    ...(input.goal ? { goal: input.goal } : {})
  });
  run = updateRun({ ...run, status: "running" });

  const wt = await createWorktreeActivity({ run, cwd: input.cwd });
  worktreePath = wt.worktreePath;
  run = updateRun(run);

  const architect = await runWorkerActivity({
    stateName: "architect",
    run,
    cwd: input.cwd,
    profile,
    worktreePath,
    prompt: input.architectPrompt ?? architectPrompt(input.goal ?? "")
  });
  run = updateRun(apply(run, architect));
  if (architect.workerOutcome?.status !== "succeeded") {
    return done(run, input.cwd, "architect failed", runState, worktreePath);
  }

  const builder = await runWorkerActivity({
    stateName: "builder",
    run,
    cwd: input.cwd,
    profile,
    worktreePath,
    prompt: input.builderPrompt ?? builderPrompt({ cwd: input.cwd, runId: run.id, worktreePath })
  });
  run = updateRun(apply(run, builder));
  if (builder.workerOutcome?.status !== "succeeded") {
    return done(run, input.cwd, "builder failed", runState, worktreePath);
  }

  const qa = await runReviewActivity({
    stateName: "qa",
    run,
    cwd: input.cwd,
    profile,
    worktreePath,
    prompt: input.qaPrompt ?? qaPrompt({ cwd: input.cwd, runId: run.id, worktreePath })
  });
  run = updateRun(apply(run, qa));

  return done(run, input.cwd, "architectBuilderKiroQaWorkflow completed", runState, worktreePath);
}

function apply(run, result) {
  let next = applyDelta(run, result?.delta ?? {});
  if (result?.commandOutcome) {
    next = { ...next, artifacts: [...next.artifacts, result.commandOutcome.artifact] };
  }
  if (result?.reviewOutcome && result.reviewOutcome.kind !== "skipped") {
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

async function done(run, cwd, summary, runState, worktreePath) {
  const final = await finalizeRunActivity({ run, summary });
  run = apply(run, final);
  return runState.result(run, { artifactRoot: `${cwd}/.tychonic/runs/${run.id}`, worktreePath });
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
