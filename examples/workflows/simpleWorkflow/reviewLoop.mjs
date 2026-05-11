import {
  addRunInboxItem,
  applyActivityResult,
  latestStateByName,
  recoverableActivityFailureResult,
  nextRunLocalId,
  promptWithAddition
} from "tychonic/workflow";
export { validateLoopPolicy } from "./loopPolicy.mjs";

const RESUME_CAP_DEFAULT = 0;
const DEFAULT_AUTO_CONTINUE_MAX_ITERATIONS = 5;

export async function runAutoContinueLoop({
  input,
  run,
  worktreePath,
  workSession,
  maxIterations,
  activities,
  onRunUpdate,
  interaction
}) {
  const profile = input.profile;
  const maxResume = profile?.states?.work?.resume ?? RESUME_CAP_DEFAULT;
  const updateRun = (next) => (onRunUpdate ? onRunUpdate(next) : next);

  let resumeConsumed = 0;
  const currentSession = workSession;

  for (let iter = 0; iter < maxIterations; iter++) {
    const openItems = run.inbox.filter((item) => item.status === "open");
    if (openItems.length === 0) break;

    const resumeItem = openItems.find(
      (item) =>
        item.action.kind === "resume_work" &&
        currentSession &&
        item.target_session_id === currentSession.id
    );
    if (!resumeItem || !currentSession?.resumable) {
      break;
    }

    if (resumeConsumed >= maxResume) {
      run = updateRun(addRunInboxItem(run, {
        id: nextRunLocalId(run, "inbox_cap"),
        status: "open",
        title: "Resume cap exhausted with unresolved findings",
        detail: `states.work.resume (${maxResume}) reached without a passing review`,
        action: {
          kind: "triage",
          reason: "auto-continue loop stopped after resume cap fired"
        },
        created_at: nowIso()
      }));
      break;
    }

    const resumeCall = await runActivityWithRecovery({
      run,
      stateName: "work",
      kind: "work",
      cwd: worktreePath ?? input.cwd,
      interaction,
      onRunUpdate: updateRun,
      invoke: (currentRun) => activities.runWorker({
        stateName: "work",
        run: currentRun,
        ...(profile ? { profile } : {}),
        cwd: input.cwd,
        worktreePath,
        sessionId: currentSession.id,
        prompt: promptWithAddition(buildResumePrompt(currentRun), input, "work")
      })
    });
    run = resumeCall.run;
    if (latestStateByName(run, "work")?.status !== "succeeded") {
      break;
    }
    resumeConsumed += 1;
    run = updateRun(markInboxResolved(run, resumeItem.id));

    const verifyCall = await runActivityWithRecovery({
      run,
      stateName: "verify",
      kind: "verify",
      cwd: worktreePath ?? input.cwd,
      interaction,
      onRunUpdate: updateRun,
      invoke: (currentRun) => activities.runVerify({
        stateName: "verify",
        run: currentRun,
        ...(profile ? { profile } : {}),
        cwd: input.cwd,
        worktreePath
      })
    });
    run = verifyCall.run;
    if (latestStateByName(run, "verify")?.status !== "succeeded") {
      break;
    }

    const reviewCall = await runActivityWithRecovery({
      run,
      stateName: "review",
      kind: "review",
      cwd: worktreePath ?? input.cwd,
      interaction,
      onRunUpdate: updateRun,
      invoke: (currentRun) => activities.runReview({
        stateName: "review",
        run: currentRun,
        ...(profile ? { profile } : {}),
        cwd: input.cwd,
        worktreePath,
        prompt: promptWithAddition(buildReviewPrompt(currentRun, "auto-continue iteration"), input, "review"),
        verificationCommands: verificationCommands(profile)
      })
    });
    run = reviewCall.run;
    const reviewRes = reviewCall.result;
    if (!reviewRes) {
      break;
    }
    if (reviewRes.delta?.states?.[0]?.status === "succeeded") {
      break;
    }
    run = updateRun(appendReviewFindingsAndInbox(run, reviewRes));
  }
  return run;
}

export function verificationCommands(profile) {
  const command = profile?.states?.verify?.command;
  return command ? [command] : [];
}

export function applyResult(run, result) {
  return applyActivityResult(run, result);
}

export async function runActivityWithRecovery({
  run,
  stateName,
  kind,
  cwd,
  interaction,
  onRunUpdate,
  invoke
}) {
  const updateRun = (next) => (onRunUpdate ? onRunUpdate(next) : next);
  while (true) {
    let result;
    try {
      result = await invoke(run);
    } catch (error) {
      result = recoverableActivityFailureResult({
        run,
        stateName,
        kind,
        cwd,
        error
      });
    }
    run = updateRun(applyResult(run, result));
    if (!interaction || !isRecoverableResult(kind, result, latestStateByName(run, stateName))) {
      return { run, result };
    }
    run = updateRun({ ...run, status: "waiting_user" });
    const decision = await interaction.waitForStateRecovery(stateName);
    if (decision.kind === "rerun" || decision.kind === "reject") {
      run = updateRun({ ...run, status: "running" });
      continue;
    }
    if (decision.kind === "modify") {
      run = updateRun({ ...interaction.applyApprovalDecision(run, stateName, decision), status: "running" });
      return { run, result: undefined };
    }
    run = updateRun({ ...run, status: "running" });
    return { run, result };
  }
}

function isRecoverableResult(_kind, result, state) {
  if (!state || !["failed", "timed_out", "blocked"].includes(state.status)) {
    return false;
  }
  return result.recoverableFailure?.kind === "activity_exception";
}

function markInboxResolved(run, inboxItemId) {
  return {
    ...run,
    inbox: run.inbox.map((item) =>
      item.id === inboxItemId
        ? { ...item, status: "resolved", resolved_at: nowIso() }
        : item
    )
  };
}

export function appendReviewFindingsAndInbox(run, reviewRes) {
  const outcome = reviewRes?.reviewOutcome;
  if (!outcome || outcome.kind !== "parsed") return run;
  if (outcome.result.status !== "fail") return run;
  const sourceState = reviewRes.delta?.states?.[0];
  const sourceStateId = sourceState?.id ?? "";
  let next = run;
  const appliedState = next.states.find((state) => state.id === sourceStateId);
  const appliedFindingIds = new Set(appliedState?.finding_ids ?? []);
  const appliedFindings = next.findings.filter(
    (finding) => finding.source_state_id === sourceStateId && appliedFindingIds.has(finding.id)
  );
  if (outcome.result.findings.length > 0 && appliedFindings.length === 0) {
    throw new Error("appendReviewFindingsAndInbox requires applyResult(run, reviewRes) before inbox routing");
  }

  for (const findingRecord of appliedFindings) {
    if (next.inbox.some((item) => item.finding_id === findingRecord.id)) {
      continue;
    }
    const targetSessionId = findingRecord.target_work_session_id;
    const targetSession = targetSessionId
      ? next.agent_sessions.find((s) => s.id === targetSessionId)
      : undefined;
    const isResumable = Boolean(targetSession?.resumable);

    const inboxItem = isResumable
      ? {
          id: nextRunLocalId(next, "inbox"),
          status: "open",
          title: `Resume work: ${findingRecord.title}`,
          detail: `resume prior worker session ${targetSession.id}`,
          finding_id: findingRecord.id,
          target_session_id: targetSession.id,
          action: {
            kind: "resume_work",
            prompt_artifact_id: ""
          },
          created_at: nowIso()
        }
      : {
          id: nextRunLocalId(next, "inbox"),
          status: "open",
          title: `Triage finding: ${findingRecord.title}`,
          detail: targetSessionId
            ? `target worker session is not resumable: ${targetSessionId}`
            : "review finding does not identify a target worker session",
          finding_id: findingRecord.id,
          ...(targetSessionId ? { target_session_id: targetSessionId } : {}),
          action: {
            kind: "triage",
            reason: targetSessionId
              ? `target worker session is not resumable: ${targetSessionId}`
              : "review finding does not identify a target worker session"
          },
          created_at: nowIso()
        };
    next = addRunInboxItem(next, inboxItem);
  }
  return next;
}

export function appendReviewFindingsAndInboxForTests(run, reviewRes) {
  return appendReviewFindingsAndInbox(run, reviewRes);
}

export function normalizeMaxIterations(value) {
  if (value === undefined || value === null) return DEFAULT_AUTO_CONTINUE_MAX_ITERATIONS;
  if (!Number.isFinite(value) || value < 1) return DEFAULT_AUTO_CONTINUE_MAX_ITERATIONS;
  return Math.floor(value);
}

function nowIso() {
  return new Date().toISOString();
}

function buildResumePrompt(run) {
  const findings = collectOpenFindings(run);
  const findingLines = findings.length > 0
    ? findings.map((f) => `- [${f.severity}] ${f.title}: ${f.detail}`).join("\n")
    : "(no findings recorded)";
  return [
    "The previous review surfaced unresolved findings. Continue working on them in this same agent session.",
    "",
    "Findings:",
    findingLines
  ].join("\n");
}

function collectOpenFindings(run) {
  const ids = new Set();
  const out = [];
  for (const f of run.findings) {
    if (!ids.has(f.id)) {
      ids.add(f.id);
      out.push(f);
    }
  }
  return out;
}

export function buildReviewPrompt(run, scope) {
  const lastWorker = [...run.agent_sessions]
    .reverse()
    .find((s) => s.role === "worker");
  const sessionLabel = lastWorker ? lastWorker.id : "(no worker session recorded)";
  const openFindings = run.findings.filter((f) => f.status !== "resolved" && f.status !== "dismissed");
  const findingsLine =
    openFindings.length > 0
      ? openFindings
          .map((f) => `- [${f.severity}] ${f.title}: ${f.detail}`)
          .join("\n")
      : "(no prior findings recorded)";

  return [
    `Review the worker output in scope: ${scope}.`,
    `Worker session under review: ${sessionLabel}.`,
    "",
    "Prior findings on this run (oldest first):",
    findingsLine,
    "",
    "Inspect the worktree, validate the worker's claimed result, and decide pass/fail.",
    "Report a semantic review verdict with status, summary, and findings.",
    "Each finding needs severity, title, and actionable detail.",
    "Add target when you can identify a file, state, or session.",
    "Use status pass only when findings is empty. Use status fail when any actionable finding exists.",
    lastWorker
      ? `For findings about the worker output under review, set target_session_id to "${lastWorker.id}".`
      : "Omit target_session_id when no worker session can be targeted."
  ].join("\n");
}
