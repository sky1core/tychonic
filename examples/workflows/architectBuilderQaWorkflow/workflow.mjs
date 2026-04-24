// architectBuilderQaWorkflow — interactive 3-stage delegated-work pipeline.
//
// Stages:
//   1. architect (work)   — an agent drafts the design / plan.
//   2. builder   (work)   — a second agent implements it.
//   3. qa        (review) — a reviewer returns `tychonic.review.v1`.
//
// Under `policies.interaction.mode: interactive` every stage pauses after
// the activity finishes and waits for the external caller to send one of
// these signals (payload.state must match the pending stage name):
//
//   tychonic.interaction.approve_state  → advance
//   tychonic.interaction.reject_state   → rerun; reject feedback
//                                          ACCUMULATES across iterations
//                                          and is injected into the next
//                                          prompt as a numbered list.
//   tychonic.interaction.modify_state   → overlay a StateRecordPatch on the
//                                          latest state record, advance.
//                                          Patch fields (all optional):
//                                          status, reason, note,
//                                          artifacts[], findings[].
//                                          Resulting status must be terminal.
//
// Reject attempts per stage are capped by
// `policies.interaction.max_reject_iterations` (default 5). At the cap
// the run is promoted to `waiting_user` with an inbox item.
//
// This file is intentionally self-contained: it imports only
// `@temporalio/workflow`. The interaction signal names below are
// Tychonic's public protocol. Keep them in sync with
// `src/temporal/types.ts` (interactionApproveStateSignalName etc.).
//
// Install (from the project that will host the run):
//
//   tychonic workflows install ./examples/workflows/architectBuilderQaWorkflow

import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler
} from "@temporalio/workflow";

const APPROVE_SIGNAL_NAME = "tychonic.interaction.approve_state";
const REJECT_SIGNAL_NAME = "tychonic.interaction.reject_state";
const MODIFY_SIGNAL_NAME = "tychonic.interaction.modify_state";
const PENDING_QUERY_NAME = "tychonic.interaction.pending_state";
const DEFAULT_MAX_REJECT_ITERATIONS = 5;
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

export const requires = {
  states: [
    { name: "architect", type: "work" },
    { name: "builder", type: "work" },
    { name: "qa", type: "review" }
  ]
};

export async function architectBuilderQaWorkflow(input) {
  const signalQueue = [];
  let pendingStateName;

  const interactionPolicy = input.profile?.policies?.interaction;
  const interactive = interactionPolicy?.mode === "interactive";
  const maxReject = interactive
    ? interactionPolicy?.max_reject_iterations ?? DEFAULT_MAX_REJECT_ITERATIONS
    : Number.POSITIVE_INFINITY;

  if (interactive) {
    const approveSig = defineSignal(APPROVE_SIGNAL_NAME);
    const rejectSig = defineSignal(REJECT_SIGNAL_NAME);
    const modifySig = defineSignal(MODIFY_SIGNAL_NAME);
    setHandler(approveSig, (payload) => signalQueue.push({ kind: "approve", payload }));
    setHandler(rejectSig, (payload) => signalQueue.push({ kind: "reject", payload }));
    setHandler(modifySig, (payload) => signalQueue.push({ kind: "modify", payload }));
    const pendingQuery = defineQuery(PENDING_QUERY_NAME);
    setHandler(pendingQuery, () => pendingStateName);
  }

  async function gate(stateName) {
    if (!interactive) {
      return { kind: "approve" };
    }
    pendingStateName = stateName;
    try {
      const find = () => signalQueue.findIndex((entry) => entry.payload?.state === stateName);
      if (find() < 0) {
        await condition(() => find() >= 0);
      }
      const [entry] = signalQueue.splice(find(), 1);
      if (entry.kind === "approve") {
        return { kind: "approve" };
      }
      if (entry.kind === "reject") {
        const feedback = entry.payload?.feedback;
        if (typeof feedback !== "string" || feedback.length === 0) {
          throw new Error(
            `rejectState for '${stateName}' requires a non-empty feedback string`
          );
        }
        return { kind: "reject", feedback };
      }
      const patch = entry.payload?.patch;
      if (!patch || typeof patch !== "object") {
        throw new Error(`modifyState for '${stateName}' requires a patch object`);
      }
      return { kind: "modify", patch };
    } finally {
      pendingStateName = undefined;
    }
  }

  let run = await startRunActivity({
    template: "architect_builder_qa",
    cwd: input.cwd,
    goal: input.goal,
    ...(input.runId ? { runId: input.runId } : {})
  });

  const wt = await createWorktreeActivity({ run, cwd: input.cwd });
  const worktreePath = wt.worktreePath;

  const rejectCounts = new Map();

  const architect = await runStage({
    stateName: "architect",
    activity: runWorkerActivity,
    basePrompt: input.architectPrompt ?? architectPrompt(input.goal ?? ""),
    run, input, worktreePath, rejectCounts, maxReject, gate
  });
  if (architect.halted) return done(architect.run, input.cwd, signalQueue, architect.summary);
  run = architect.run;

  // builder <-> qa review loop.
  //
  // - Interactive mode: each stage's inner gate already handles rerun via
  //   `rejectState` on that same stage, so we run builder + qa exactly once
  //   here; when qa is approved the workflow exits.
  // - Auto mode (no external gating): if qa reports `fail` (state.status =
  //   "failed" per SPEC §Review state terminal status), loop back to builder
  //   with the qa reason threaded into the next prompt. Capped by
  //   `policies.loop.max_review_iterations` (default 3). At the cap the run
  //   enters `waiting_user` with an inbox item so an operator (or external
  //   agent via one-shot signals) can decide the next step.
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
      run, input, worktreePath, rejectCounts, maxReject, gate
    });
    if (builder.halted) return done(builder.run, input.cwd, signalQueue, builder.summary);
    run = builder.run;

    const qa = await runStage({
      stateName: "qa",
      activity: runReviewActivity,
      basePrompt: input.qaPrompt ?? qaPrompt({ runId: run.id, worktreePath }),
      run, input, worktreePath, rejectCounts, maxReject, gate
    });
    if (qa.halted) return done(qa.run, input.cwd, signalQueue, qa.summary);
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
      run = addInboxItem(run, reviewCapInboxItem());
      run = { ...run, status: "waiting_user" };
      return done(
        run,
        input.cwd,
        signalQueue,
        `qa review did not pass within ${maxReviewIterations} iterations`
      );
    }
    qaFeedbacks.push(
      `QA iteration ${reviewIteration} verdict: ${latestQa?.reason ?? "(no reason recorded)"}`
    );
  }

  return done(run, input.cwd, signalQueue, "architectBuilderQaWorkflow completed");
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
  gate
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
      extras: { worktreePath, prompt }
    });
    run = apply(run, result);

    const decision = await gate(stateName);
    if (decision.kind === "approve") {
      return { run, halted: false };
    }
    if (decision.kind === "modify") {
      run = applyStatePatch(run, stateName, decision.patch);
      return { run, halted: false };
    }
    const nextCount = (rejectCounts.get(stateName) ?? 0) + 1;
    rejectCounts.set(stateName, nextCount);
    if (nextCount >= maxReject) {
      run = addInboxItem(run, rejectCapInboxItem(stateName));
      run = { ...run, status: "waiting_user" };
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
  if (
    result.reviewOutcome &&
    (result.reviewOutcome.kind === "parsed" || result.reviewOutcome.kind === "unparseable")
  ) {
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

const TERMINAL_STATE_STATUSES = ["succeeded", "failed", "skipped", "blocked", "timed_out"];

// Overlay a StateRecordPatch on the latest state record with the given name.
// Mirrors src/workflows/runMerge.ts:applyModifyStateDecision so the plugin
// preserves the same id/attempt/artifact/finding bookkeeping as built-in
// workflows (checkpoint, simple_workflow, self_repair).
function applyStatePatch(run, stateName, patch) {
  let latestIndex = -1;
  for (let i = run.states.length - 1; i >= 0; i -= 1) {
    if (run.states[i].name === stateName) {
      latestIndex = i;
      break;
    }
  }
  if (latestIndex < 0) {
    throw new Error(
      `modifyState cannot patch state '${stateName}' because no state with that name has run yet`
    );
  }
  const original = run.states[latestIndex];
  const nextStatus = patch.status ?? original.status;
  if (!TERMINAL_STATE_STATUSES.includes(nextStatus)) {
    throw new Error(
      `modifyState resulting status must be terminal (one of ${TERMINAL_STATE_STATUSES.join(", ")}), got '${nextStatus}'`
    );
  }
  const baseReason = patch.reason ?? original.reason;
  const nextReason = patch.note
    ? baseReason
      ? `${baseReason} — note: ${patch.note}`
      : patch.note
    : baseReason;
  const addedArtifacts = patch.artifacts ?? [];
  const addedFindings = patch.findings ?? [];
  const patched = {
    ...original,
    status: nextStatus,
    ...(nextReason !== undefined ? { reason: nextReason } : {}),
    artifact_ids: [...original.artifact_ids, ...addedArtifacts.map((a) => a.id)],
    finding_ids: [...original.finding_ids, ...addedFindings.map((f) => f.id)]
  };
  const nextStates = [...run.states];
  nextStates[latestIndex] = patched;
  return {
    ...run,
    states: nextStates,
    artifacts: addedArtifacts.length > 0 ? [...run.artifacts, ...addedArtifacts] : run.artifacts,
    findings: addedFindings.length > 0 ? [...run.findings, ...addedFindings] : run.findings
  };
}

function addInboxItem(run, item) {
  if (run.inbox.some((existing) => existing.id === item.id)) {
    return run;
  }
  return { ...run, inbox: [...run.inbox, item] };
}

function rejectCapInboxItem(stateName) {
  return {
    id: `inbox_reject_cap_${stateName}`,
    status: "open",
    title: "Interactive reject limit reached",
    detail: `state '${stateName}' reached the interactive reject iteration cap; approve or modify to continue`,
    action: { kind: "triage", reason: `interactive reject cap for state '${stateName}'` },
    created_at: new Date().toISOString()
  };
}

function reviewCapInboxItem() {
  return {
    id: "inbox_review_cap",
    status: "open",
    title: "Auto-mode review iteration cap reached",
    detail:
      "qa stage did not report pass within policies.loop.max_review_iterations; builder did not converge. " +
      "Inspect run.states and run.findings, then approve/modify/reject the latest qa state via interactive signals, " +
      "or abandon the run.",
    action: { kind: "triage", reason: "qa review loop cap reached in auto mode" },
    created_at: new Date().toISOString()
  };
}

function strayInboxItem(entry, index) {
  return {
    id: `inbox_stray_${entry.kind}_${entry.payload?.state ?? "unknown"}_${index}`,
    status: "open",
    title: "Stray interaction signal",
    detail: `kind=${entry.kind} state=${entry.payload?.state ?? "(unknown)"} payload=${JSON.stringify(entry.payload)}`,
    action: {
      kind: "triage",
      reason: `stray ${entry.kind} signal for state '${entry.payload?.state ?? "(unknown)"}'`
    },
    created_at: new Date().toISOString()
  };
}

async function done(run, cwd, signalQueue, summary) {
  let finalRun = run;
  if (signalQueue.length > 0) {
    signalQueue.forEach((entry, index) => {
      finalRun = addInboxItem(finalRun, strayInboxItem(entry, index));
    });
    signalQueue.length = 0;
  }
  const fin = await finalizeRunActivity({ run: finalRun, summary });
  finalRun = apply(finalRun, fin);
  return {
    runId: finalRun.id,
    status: finalRun.status,
    run: finalRun,
    artifactRoot: `${cwd}/.tychonic/runs/${finalRun.id}`,
    ...(finalRun.summary ? { summary: finalRun.summary } : {})
  };
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
    "Return only one JSON object matching this contract. Do not wrap it in markdown.",
    "{",
    '  "schema_version": "tychonic.review.v1",',
    '  "status": "pass|fail",',
    '  "summary": "short result summary",',
    '  "findings": [',
    '    {"severity": "critical|high|medium|low", "title": "finding title", "detail": "actionable explanation", "target": "file, state, or session", "target_session_id": ""}',
    "  ]",
    "}",
    "Use status pass only when findings is empty. Use status fail when any actionable finding exists."
  ].join("\n");
}
