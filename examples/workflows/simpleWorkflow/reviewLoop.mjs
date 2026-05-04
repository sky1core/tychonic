import {
  addRunInboxItem,
  applyActivityResult,
  nextRunLocalId
} from "tychonic/workflow";

const RESUME_CAP_DEFAULT = 0;
const DEFAULT_AUTO_CONTINUE_MAX_ITERATIONS = 5;

/**
 * Validate the bundle-owned `policies.loop` block. The host config
 * schema treats `policies` as opaque; this workflow validates the keys
 * it actually consumes.
 */
export function validateLoopPolicy(policies) {
  if (!policies || policies.loop === undefined) return;
  const loop = policies.loop;
  if (typeof loop !== "object" || loop === null || Array.isArray(loop)) {
    throw new Error("policies.loop must be an object");
  }
  const allowed = new Set(["auto_continue", "max_review_iterations"]);
  for (const key of Object.keys(loop)) {
    if (!allowed.has(key)) {
      throw new Error(`policies.loop.${key} is not a recognised key for simpleWorkflow`);
    }
  }
  if (loop.auto_continue !== undefined && typeof loop.auto_continue !== "boolean") {
    throw new Error("policies.loop.auto_continue must be a boolean");
  }
  if (loop.max_review_iterations !== undefined) {
    if (!Number.isInteger(loop.max_review_iterations) || loop.max_review_iterations <= 0) {
      throw new Error("policies.loop.max_review_iterations must be a positive integer");
    }
    if (!loop.auto_continue) {
      throw new Error("policies.loop.max_review_iterations requires policies.loop.auto_continue");
    }
  }
}

export async function runAutoContinueLoop({
  input,
  run,
  worktreePath,
  workSession,
  maxIterations,
  activities,
  onRunUpdate
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

    const resumeRes = await activities.runWorker({
      stateName: "work",
      run,
      ...(profile ? { profile } : {}),
      cwd: input.cwd,
      worktreePath,
      sessionId: currentSession.id,
      prompt: buildResumePrompt(run)
    });
    run = updateRun(applyResult(run, resumeRes));
    resumeConsumed += 1;
    run = updateRun(markInboxResolved(run, resumeItem.id));

    const verifyRes = await activities.runVerify({
      stateName: "verify",
      run,
      ...(profile ? { profile } : {}),
      cwd: input.cwd,
      worktreePath
    });
    run = updateRun(applyResult(run, verifyRes));
    if (verifyRes.delta?.states?.[0]?.status !== "succeeded") {
      break;
    }

    const reviewRes = await activities.runReview({
      stateName: "review",
      run,
      ...(profile ? { profile } : {}),
      cwd: input.cwd,
      worktreePath,
      prompt: buildReviewPrompt(run, "auto-continue iteration"),
      verificationCommands: verificationCommands(profile)
    });
    run = updateRun(applyResult(run, reviewRes));
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
