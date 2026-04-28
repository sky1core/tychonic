// architectBuilderKiroRepairQaWorkflow — Kiro pre-review and repair before a
// structured final QA gate.

import { proxyActivities } from "@temporalio/workflow";

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
    kiro_pre_review: {
      type: "work",
      agent: "kiro",
      trust_all_tools: true,
      timeout: "30m"
    },
    kiro_fix: {
      type: "work",
      agent: "kiro",
      trust_all_tools: true,
      sandbox: "workspace-write",
      approval: "never",
      timeout: "45m"
    },
    final_qa: {
      type: "review",
      agent: "claude",
      permission_mode: "plan",
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
  "kiroPreReviewPrompt",
  "kiroFixPrompt",
  "finalQaPrompt"
]);

function rejectUnknownInputFields(input) {
  if (!input || typeof input !== "object") return;
  for (const field of Object.keys(input)) {
    if (!INPUT_FIELDS.has(field)) {
      throw new Error(`unsupported input field: ${field}`);
    }
  }
}

export async function architectBuilderKiroRepairQaWorkflow(input) {
  rejectUnknownInputFields(input);
  const profile = input.profile;
  let run = await startRunActivity({
    template: "architect_builder_kiro_repair_qa",
    cwd: input.cwd,
    ...(profile ? { profile } : {}),
    ...(input.goal ? { goal: input.goal } : {})
  });

  const wt = await createWorktreeActivity({ run, cwd: input.cwd });
  const worktreePath = wt.worktreePath;

  const architect = await runWorkerActivity({
    stateName: "architect",
    run,
    cwd: input.cwd,
    profile,
    worktreePath,
    prompt: input.architectPrompt ?? architectPrompt(input.goal ?? "")
  });
  run = apply(run, architect);
  if (architect.workerOutcome?.status !== "succeeded") {
    return done(run, input.cwd, "architect failed");
  }

  const builder = await runWorkerActivity({
    stateName: "builder",
    run,
    cwd: input.cwd,
    profile,
    worktreePath,
    prompt: input.builderPrompt ?? builderPrompt({ cwd: input.cwd, runId: run.id, worktreePath })
  });
  run = apply(run, builder);
  if (builder.workerOutcome?.status !== "succeeded") {
    return done(run, input.cwd, "builder failed");
  }

  const preReview = await runWorkerActivity({
    stateName: "kiro_pre_review",
    run,
    cwd: input.cwd,
    profile,
    worktreePath,
    prompt: input.kiroPreReviewPrompt ?? kiroPreReviewPrompt({ cwd: input.cwd, runId: run.id, worktreePath })
  });
  run = apply(run, preReview);
  if (preReview.workerOutcome?.status !== "succeeded") {
    return done(run, input.cwd, "kiro pre-review failed");
  }

  const repair = await runWorkerActivity({
    stateName: "kiro_fix",
    run,
    cwd: input.cwd,
    profile,
    worktreePath,
    prompt: input.kiroFixPrompt ?? kiroFixPrompt({ cwd: input.cwd, runId: run.id, worktreePath })
  });
  run = apply(run, repair);
  if (repair.workerOutcome?.status !== "succeeded") {
    return done(run, input.cwd, "kiro repair failed");
  }

  const finalQa = await runReviewActivity({
    stateName: "final_qa",
    run,
    cwd: input.cwd,
    profile,
    worktreePath,
    prompt: input.finalQaPrompt ?? finalQaPrompt({ cwd: input.cwd, runId: run.id, worktreePath })
  });
  run = apply(run, finalQa);

  return done(run, input.cwd, "architectBuilderKiroRepairQaWorkflow completed");
}

function apply(run, result) {
  let next = applyDelta(run, result?.delta ?? {});
  if (result?.commandOutcome) {
    next = { ...next, artifacts: [...next.artifacts, result.commandOutcome.artifact] };
  }
  if (
    result?.reviewOutcome &&
    (result.reviewOutcome.kind === "parsed" || result.reviewOutcome.kind === "unparseable")
  ) {
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

async function done(run, cwd, summary) {
  const final = await finalizeRunActivity({ run, summary });
  run = apply(run, final);
  return {
    runId: run.id,
    status: run.status,
    run,
    artifactRoot: `${cwd}/.tychonic/runs/${run.id}`,
    ...(run.summary ? { summary: run.summary } : {})
  };
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

function kiroPreReviewPrompt({ cwd, runId, worktreePath }) {
  return [
    "You are the Kiro pre-review stage.",
    `Review the current worktree: ${worktreePath}`,
    `Use artifacts under ${cwd}/.tychonic/runs/${runId}/artifacts/ as context.`,
    "",
    "Do not edit files in this stage.",
    "Write a concise prose review listing only clear, actionable issues.",
    "If there are no clear issues, say that explicitly."
  ].join("\n");
}

function kiroFixPrompt({ cwd, runId, worktreePath }) {
  return [
    "You are the Kiro repair stage.",
    `Worktree: ${worktreePath}`,
    `Read the Kiro pre-review output under ${cwd}/.tychonic/runs/${runId}/artifacts/.`,
    "",
    "Fix only clear issues from that pre-review. If it found no clear issues, make no changes and say so.",
    "Do not expand scope beyond the architect plan and Kiro pre-review."
  ].join("\n");
}

function finalQaPrompt({ cwd, runId, worktreePath }) {
  return [
    "You are the final structured QA reviewer.",
    `Check the final worktree in ${worktreePath}.`,
    `Use artifacts under ${cwd}/.tychonic/runs/${runId}/artifacts/ as context, including Kiro pre-review and Kiro repair output.`,
    "",
    "Report a semantic review verdict with status, summary, and findings.",
    "Each finding needs severity, title, and actionable detail.",
    "Use status pass only when findings is empty. Use status fail when any actionable finding exists."
  ].join("\n");
}
