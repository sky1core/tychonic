// architectBuilderQaWorkflow — interactive 3-stage delegated-work pipeline.
//
// Stages:
//   1. architect (work)   — an agent drafts the design / plan.
//   2. builder   (work)   — a second agent implements it.
//   3. qa        (review) — a reviewer returns `tychonic.review.v1`.
//
// Under `policies.interaction.mode: interactive` every stage pauses after
// the activity finishes and waits for the standard Tychonic interaction
// commands. The public `tychonic/workflow` helper registers those signal/query
// handlers and exposes the state approval gate.
//
// Reject attempts per stage are capped by
// `policies.interaction.max_reject_iterations` (default 5). At the cap
// the run is promoted to `waiting_user` with an inbox item.
//
// Install (from the project that will host the run):
//
//   tychonic workflows install ./examples/workflows/architectBuilderQaWorkflow

import { proxyActivities } from "@temporalio/workflow";
import { createTychonicInteraction, createTychonicRunState } from "tychonic/workflow";
import {
  validateInteractionPolicy,
  validateLoopPolicy
} from "./workflowPolicies.mjs";

const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

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
  finalizeRunActivity
} = act;

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    architect: {
      type: "work",
      agent: "claude",
      timeout: "30m",
      permission_mode: "plan"
    },
    builder: {
      type: "work",
      agent: "codex",
      resume: 2,
      timeout: "60m",
      sandbox: "workspace-write",
      approval: "never"
    },
    qa: {
      type: "review",
      agent: "claude",
      permission_mode: "plan",
      timeout: "30m"
    }
  },
  policies: {
    interaction: { mode: "auto" },
    loop: { max_review_iterations: 3 }
  }
};

const ARCHITECT_BUILDER_QA_INPUT_FIELDS = new Set([
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
    if (!ARCHITECT_BUILDER_QA_INPUT_FIELDS.has(field)) {
      throw new Error(`unsupported input field: ${field}`);
    }
  }
}

export async function architectBuilderQaWorkflow(input) {
  rejectUnknownInputFields(input);
  validateInteractionPolicy(input.profile?.policies);
  validateLoopPolicy(input.profile?.policies);
  const runState = createTychonicRunState();
  const interaction = createTychonicInteraction(input.profile?.policies?.interaction);
  let worktreePath;
  const updateRun = (next) => runState.update(next, worktreePath ? { worktreePath } : {});

  const interactive = interaction.mode() === "interactive";
  const maxReject = interaction.rejectCap();

  let run = await startRunActivity({
    template: "architect_builder_qa",
    cwd: input.cwd,
    ...(input.profile ? { profile: input.profile } : {}),
    goal: input.goal
  });
  run = updateRun({ ...run, status: "running" });

  const wt = await createWorktreeActivity({ run, cwd: input.cwd });
  worktreePath = wt.worktreePath;
  run = updateRun(run);

  const rejectCounts = new Map();

  const architect = await runStage({
    stateName: "architect",
    activity: runWorkerActivity,
    basePrompt: input.architectPrompt ?? architectPrompt(input.goal ?? ""),
    run, input, worktreePath, rejectCounts, maxReject, interaction, updateRun
  });
  if (architect.halted) return done(architect.run, input.cwd, interaction, architect.summary, runState, worktreePath);
  run = architect.run;

  // builder <-> qa review loop.
  //
  // - Interactive mode: each stage's inner gate already handles rerun via
  //   `rejectState` on that same stage, so we run builder + qa exactly once
  //   here; when qa is approved the workflow exits.
  // - Auto mode (no external gating): if qa reports `fail` (state.status =
  //   "failed" per SPEC §Activity Result And Evidence Invariants), loop
  //   back to builder with the qa reason threaded into the next prompt. Capped by
  //   `policies.loop.max_review_iterations` (default 3). At the cap the run
  //   enters terminal `waiting_user`; recovery is a fresh run with adjusted
  //   input/config, not another signal into this completed workflow.
  const maxReviewIterations =
    input.profile?.policies?.loop?.max_review_iterations ?? DEFAULT_MAX_REVIEW_ITERATIONS;
  const qaFeedbacks = [];
  let reviewIteration = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    reviewIteration += 1;

    const builderBase = input.builderPrompt ?? builderPrompt({ runId: run.id, worktreePath });
    const builderBaseWithFeedback =
      qaFeedbacks.length > 0
        ? `${builderBase}\n\n[qa findings from previous iteration(s)]\n${qaFeedbacks
            .map((f, i) => `${i + 1}. ${f}`)
            .join("\n")}\n[/qa findings]`
        : builderBase;

    const builder = await runStage({
      stateName: "builder",
      activity: runWorkerActivity,
      basePrompt: builderBaseWithFeedback,
      run, input, worktreePath, rejectCounts, maxReject, interaction, updateRun
    });
    if (builder.halted) return done(builder.run, input.cwd, interaction, builder.summary, runState, worktreePath);
    run = builder.run;

    const qa = await runStage({
      stateName: "qa",
      activity: runReviewActivity,
      basePrompt: input.qaPrompt ?? qaPrompt({ runId: run.id, worktreePath }),
      run, input, worktreePath, rejectCounts, maxReject, interaction, updateRun
    });
    if (qa.halted) return done(qa.run, input.cwd, interaction, qa.summary, runState, worktreePath);
    run = qa.run;

    if (interactive) {
      // Interactive gating already decided pass/rerun per stage; exit the
      // outer loop after one builder+qa round.
      break;
    }

    const latestQa = findLastStateByName(run, "qa");
    if (latestQa?.status === "succeeded") {
      break;
    }
    if (reviewIteration >= maxReviewIterations) {
      run = updateRun(addInboxItem(run, reviewCapInboxItem()));
      run = updateRun({ ...run, status: "waiting_user" });
      return done(
        run,
        input.cwd,
        interaction,
        `qa review did not pass within ${maxReviewIterations} iterations`,
        runState,
        worktreePath
      );
    }
    qaFeedbacks.push(
      `QA iteration ${reviewIteration} verdict: ${latestQa?.reason ?? "(no reason recorded)"}`
    );
  }

  return done(run, input.cwd, interaction, "architectBuilderQaWorkflow completed", runState, worktreePath);
}

function findLastStateByName(run, name) {
  for (let i = run.states.length - 1; i >= 0; i -= 1) {
    if (run.states[i].name === name) return run.states[i];
  }
  return undefined;
}

async function runStage({
  stateName,
  activity,
  basePrompt,
  run,
  input,
  worktreePath,
  rejectCounts,
  maxReject,
  interaction,
  updateRun
}) {
  const feedbacks = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const prompt = feedbacks.length > 0
      ? `${basePrompt}\n\n[reviewer feedback from previous attempts]\n${feedbacks
          .map((f, i) => `${i + 1}. ${f}`)
          .join("\n")}\n[/reviewer feedback]`
      : basePrompt;
    const result = await activity({
      stateName,
      run,
      cwd: input.cwd,
      profile: input.profile,
      worktreePath,
      prompt
    });
    run = updateRun(apply(run, result));

    const decision = await interaction.waitForStateApproval(stateName);
    if (decision.kind === "approve") {
      return { run, halted: false };
    }
    if (decision.kind === "modify") {
      run = updateRun(interaction.applyApprovalDecision(run, stateName, decision));
      return { run, halted: false };
    }
    const nextCount = (rejectCounts.get(stateName) ?? 0) + 1;
    rejectCounts.set(stateName, nextCount);
    if (nextCount >= maxReject) {
      run = updateRun(
        addInboxItem(
          run,
          interaction.rejectCapInboxItem(stateName, {
            id: `inbox_reject_cap_${stateName}`,
            createdAt: nowIso()
          })
        )
      );
      run = updateRun({ ...run, status: "waiting_user" });
      return { run, halted: true, summary: `${stateName} reached reject cap` };
    }
    feedbacks.push(decision.feedback);
  }
}

function apply(run, result) {
  let next = applyDelta(run, result.delta || {});
  if (result.commandOutcome) {
    next = { ...next, artifacts: [...next.artifacts, result.commandOutcome.artifact] };
  }
  if (result.reviewOutcome && result.reviewOutcome.kind !== "skipped") {
    next = {
      ...next,
      artifacts: [...next.artifacts, ...result.reviewOutcome.artifacts],
      agent_sessions: [...next.agent_sessions, ...result.reviewOutcome.agentSessions]
    };
    next = appendReviewFindings(next, result);
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

function addInboxItem(run, item) {
  if (run.inbox.some((existing) => existing.id === item.id)) {
    return run;
  }
  return { ...run, inbox: [...run.inbox, item] };
}

function reviewCapInboxItem() {
  return {
    id: "inbox_review_cap",
    status: "open",
    title: "Auto-mode review iteration cap reached",
    detail:
      "qa stage did not report pass within policies.loop.max_review_iterations; builder did not converge. " +
      "Inspect run.states and run.findings, then start a fresh run with adjusted input/config.",
    action: { kind: "triage", reason: "qa review loop cap reached in auto mode" },
    created_at: nowIso()
  };
}

async function done(run, cwd, interaction, summary, runState, worktreePath) {
  let finalRun = run;
  const straySignals = interaction.drainStraySignals();
  if (straySignals.length > 0) {
    straySignals.forEach((entry, index) => {
      finalRun = addInboxItem(
        finalRun,
        interaction.strayInteractionSignalInboxItem(entry, {
          id: `inbox_stray_${entry.kind}_${entry.state}_${index}`,
          createdAt: nowIso()
        })
      );
    });
    finalRun = runState.update(finalRun, { worktreePath });
  }
  const fin = await finalizeRunActivity({ run: finalRun, summary });
  finalRun = apply(finalRun, fin);
  return runState.result(finalRun, { artifactRoot: `${cwd}/.tychonic/runs/${finalRun.id}`, worktreePath });
}

function architectPrompt(goal) {
  return [
    "You are the architect stage of a three-stage delegated-work pipeline.",
    "",
    "Goal:",
    goal || "(no explicit goal supplied; infer from the project state)",
    "",
    "Deliver a concrete design: file changes to make, public APIs to add or",
    "remove, validation steps, and explicit risks. Do NOT implement yet.",
    "Write the design as files in the current worktree (or as a structured",
    "Markdown document). The builder stage will consume your output directly."
  ].join("\n");
}

function builderPrompt({ runId, worktreePath }) {
  return [
    "You are the builder stage. Implement the design produced by the",
    "architect stage of this run.",
    "",
    `Worktree:  ${worktreePath}`,
    `Artifacts: .tychonic/runs/${runId}/artifacts/`,
    "",
    "Apply the architect's design as code changes in the worktree. Write",
    "or update tests where the design calls for them. Do not expand the",
    "scope beyond the architect's instructions; if you discover a gap,",
    "describe it in a short note and stop so the reviewer stage can flag",
    "it back to the architect."
  ].join("\n");
}

function qaPrompt({ runId, worktreePath }) {
  return [
    "You are the QA reviewer for this three-stage run.",
    `Check the builder output in ${worktreePath} against the architect`,
    `design captured under .tychonic/runs/${runId}/artifacts/.`,
    "",
    "Report a semantic review verdict with status, summary, and findings.",
    "Each finding needs severity, title, and actionable detail.",
    "Add target or target_session_id only when you can identify one.",
    "Use status pass only when findings is empty. Use status fail when any actionable finding exists."
  ].join("\n");
}
