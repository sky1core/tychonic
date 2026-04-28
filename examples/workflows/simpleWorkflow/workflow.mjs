// Example Tychonic workflow bundle: simpleWorkflow.
//
// Install with:
//
//   (cd examples/workflows/simpleWorkflow && npm install)
//   tychonic workflows install ./examples/workflows/simpleWorkflow
//
// Operational installs refresh the LaunchAgent worker when one is installed.
// Isolated-instance installs require restarting that instance's runtime.
// See docs/plugin-workflows.md for the authoring guide.
//
// This bundle composes per-TYPE activities the way pipelineWorkflow does
// and owns its own auto-continue loop bookkeeping. The workflow returns
// once it reaches a Tychonic terminal status (succeeded / waiting_user /
// failed); recovery is sent via `tychonic signal` from a separate process
// when the user wants async signal-driven follow-ups.

import { defineQuery, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";

const act = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
});

const {
  startRunActivity,
  createWorktreeActivity,
  runWorkerActivity,
  runVerifyActivity,
  runReviewActivity,
  finalizeRunActivity
} = act;

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    work: {
      type: "work",
      agent: "claude",
      resume: 3,
      permission_mode: "acceptEdits",
      timeout: "45m"
    },
    verify: {
      type: "verify",
      command: `npm run typecheck
npm run build
npm test
npm run validate:examples`,
      timeout: "20m"
    },
    review: {
      type: "review",
      agent: "claude",
      permission_mode: "plan",
      timeout: "20m"
    }
  },
  policies: { loop: { auto_continue: true, max_review_iterations: 3 } }
};

const RESUME_CAP_DEFAULT = 0;
const DEFAULT_AUTO_CONTINUE_MAX_ITERATIONS = 5;

const workflowStateQuery = defineQuery("tychonic.workflow_state");
const registerSessionSignal = defineSignal("tychonic.simple_workflow.register_session");

/**
 * Validate the bundle-owned `policies.loop` block. The host config
 * schema treats `policies` as opaque; this workflow validates the keys
 * it actually consumes.
 *
 * Rules:
 *  - unknown keys under `policies.loop` are rejected
 *  - `max_review_iterations` is a positive integer when present
 *  - `max_review_iterations` requires `auto_continue: true`
 *
 * The same-session resume cap is per-state and lives at
 * `states.work.resume` (host schema enforces non-negative integer); it is
 * not validated here.
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

/**
 * `simpleWorkflow` — work / verify / review loop.
 *
 * Input shape:
 *   {
 *     cwd: string,
 *     goal?: string,
 *     autoContinue?: boolean,
 *     maxIterations?: number
 *   }
 * Host-injected: profile?: TychonicConfig
 */
const SIMPLE_WORKFLOW_INPUT_FIELDS = new Set([
  "cwd",
  "goal",
  "autoContinue",
  "maxIterations",
  "profile"
]);

function rejectUnknownInputFields(input) {
  if (!input || typeof input !== "object") return;
  for (const field of Object.keys(input)) {
    if (!SIMPLE_WORKFLOW_INPUT_FIELDS.has(field)) {
      throw new Error(`unsupported input field: ${field}`);
    }
  }
}

export async function simpleWorkflow(input) {
  rejectUnknownInputFields(input);
  validateLoopPolicy(input.profile?.policies);
  // Snapshot the effective profile at workflow start. The cap loop reads
  // caps from this snapshot, never from a re-read of the input — a mid-run
  // "reinstall" of the bundle does not change the running cap values.
  const profileSnapshot = input.profile;
  let latestResult;
  const sessionRegistrationQueue = [];

  setHandler(workflowStateQuery, () => latestResult);
  // The host's worker activity registers each spawned agent session with
  // the workflow via this signal as the run progresses. The handler queues
  // registrations until a result snapshot exists, then folds them in.
  setHandler(registerSessionSignal, (registration) => {
    sessionRegistrationQueue.push(registration);
    if (latestResult) {
      applySessionRegistrations(latestResult, sessionRegistrationQueue);
    }
  });

  // Run work -> verify -> review with optional auto-continue. The
  // workflow returns once it reaches a Tychonic terminal status.
  latestResult = await runMainPipeline({ ...input, profile: profileSnapshot });
  applySessionRegistrations(latestResult, sessionRegistrationQueue);

  return latestResult;
}

async function runMainPipeline(input) {
  const profile = input.profile;
  let run = await startRunActivity({
    template: "simple_workflow",
    cwd: input.cwd,
    ...(profile ? { profile } : {}),
    ...(input.goal ? { goal: input.goal } : {})
  });
  run = { ...run, status: "running" };

  const wt = await createWorktreeActivity({ run, cwd: input.cwd });
  const worktreePath = wt.worktreePath;

  // Stage: work
  const workRes = await runWorkerActivity({
    stateName: "work",
    run,
    ...(profile ? { profile } : {}),
    cwd: input.cwd,
    worktreePath,
    ...(input.goal ? { goal: input.goal } : {})
  });
  run = applyResult(run, workRes);
  const workSession = workRes.workerOutcome?.kind === "executed"
    ? workRes.workerOutcome.agentSessions[0]
    : undefined;

  if (workRes.delta?.states?.[0]?.status !== "succeeded") {
    return finalize(run, input.cwd, worktreePath, "work failed");
  }

  // Stage: verify
  const verifyRes = await runVerifyActivity({
    stateName: "verify",
    run,
    ...(profile ? { profile } : {}),
    cwd: input.cwd,
    worktreePath
  });
  run = applyResult(run, verifyRes);
  if (verifyRes.delta?.states?.[0]?.status !== "succeeded") {
    return finalize(run, input.cwd, worktreePath, "verify failed");
  }

  // Stage: review (optional)
  if (profile?.states?.review) {
    const reviewRes = await runReviewActivity({
      stateName: "review",
      run,
      ...(profile ? { profile } : {}),
      cwd: input.cwd,
      worktreePath,
      prompt: buildReviewPrompt(run, "initial work output"),
      verificationCommands: verificationCommands(profile)
    });
    run = applyResult(run, reviewRes);
    run = appendReviewFindingsAndInbox(run, reviewRes);

    if (input.autoContinue || profile?.policies?.loop?.auto_continue) {
      const maxIter = normalizeMaxIterations(
        input.maxIterations ?? profile?.policies?.loop?.max_review_iterations
      );
      run = await runAutoContinueLoop({
        input,
        run,
        worktreePath,
        workSession,
        maxIterations: maxIter,
        activities: defaultActivities()
      });
    }
  }

  return finalize(run, input.cwd, worktreePath);
}

/**
 * Activity-side dispatch surface. Test-only export — integration tests inject
 * mock activity bodies here so the cap loop can be exercised without a real
 * Temporal worker. Workflow-side production code passes
 * `defaultActivities()` so dispatch goes through the proxied Temporal
 * activities.
 */
export function defaultActivities() {
  return {
    runWorker: runWorkerActivity,
    runVerify: runVerifyActivity,
    runReview: runReviewActivity
  };
}

/**
 * Test-only export: the auto-continue cap loop body. Exposed so integration
 * tests can drive the full state-machine transitions (counters, inbox writes)
 * by injecting `activities` stubs that return pre-baked `ActivityResult`
 * shapes. Production code calls this via `runMainPipeline` with
 * `defaultActivities()`.
 *
 * Reads the same-session resume cap from the start-time effective profile
 * snapshot. The counter starts at zero on every entry to
 * this loop; once it reaches `maxResume`, the workflow appends a triage
 * inbox item titled `Resume cap exhausted with unresolved findings` and
 * stops the loop.
 */
export async function runAutoContinueLoop({
  input,
  run,
  worktreePath,
  workSession,
  maxIterations,
  activities
}) {
  const profile = input.profile;
  const maxResume = profile?.states?.work?.resume ?? RESUME_CAP_DEFAULT;

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
      run = appendInboxItem(run, {
        id: nextLocalId(run, "inbox_cap"),
        status: "open",
        title: "Resume cap exhausted with unresolved findings",
        detail: `states.work.resume (${maxResume}) reached without a passing review`,
        action: {
          kind: "triage",
          reason: "auto-continue loop stopped after resume cap fired"
        },
        created_at: nowIso()
      });
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
    run = applyResult(run, resumeRes);
    resumeConsumed += 1;
    run = markInboxResolved(run, resumeItem.id);

    const verifyRes = await activities.runVerify({
      stateName: "verify",
      run,
      ...(profile ? { profile } : {}),
      cwd: input.cwd,
      worktreePath
    });
    run = applyResult(run, verifyRes);
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
    run = applyResult(run, reviewRes);
    if (reviewRes.delta?.states?.[0]?.status === "succeeded") {
      break;
    }
    run = appendReviewFindingsAndInbox(run, reviewRes);
  }
  return run;
}

function verificationCommands(profile) {
  const command = profile?.states?.verify?.command;
  return command ? [command] : [];
}

function applySessionRegistrations(result, queue) {
  while (queue.length > 0) {
    const registration = queue.shift();
    if (!registration) continue;
    const existing = result.run.agent_sessions.find((s) => s.id === registration.id);
    if (existing) {
      existing.agent = registration.agent;
      existing.role = registration.role;
      existing.cwd = registration.cwd;
      existing.status = registration.status ?? existing.status;
      existing.started_at = registration.startedAt;
      existing.resumable = registration.resumable ?? existing.resumable;
    } else {
      result.run.agent_sessions.push({
        id: registration.id,
        agent: registration.agent,
        role: registration.role,
        cwd: registration.cwd,
        status: registration.status ?? "unknown",
        ...(registration.resumable ? { resumable: true } : {}),
        started_at: registration.startedAt
      });
    }
  }
}

async function finalize(run, cwd, worktreePath, summary) {
  const fin = await finalizeRunActivity({ run, ...(summary ? { summary } : {}) });
  run = applyResult(run, fin);
  return {
    runId: run.id,
    status: run.status,
    run,
    artifactRoot: `${cwd}/.tychonic/runs/${run.id}`,
    worktreePath
  };
}

// Pure merge of an ActivityResult into the local run record.
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

function appendInboxItem(run, item) {
  return { ...run, inbox: [...run.inbox, item] };
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

/**
 * After a review activity returns a `parsed` outcome with `status === "fail"`,
 * append one `FindingRecord` per review finding plus one
 * `DecisionInboxItemRecord` per finding. Inbox items resolve to:
 *   - `action.kind: "resume_work"` — when the finding's `target_session_id`
 *     matches a resumable worker session in `run.agent_sessions`. The cap
 *     loop consumes these.
 *   - `action.kind: "triage"` — otherwise.
 *
 * A finding without `target_session_id` is routed to triage. The workflow
 * does not guess a worker session from surrounding context.
 */
function appendReviewFindingsAndInbox(run, reviewRes) {
  const outcome = reviewRes?.reviewOutcome;
  if (!outcome || outcome.kind !== "parsed") return run;
  if (outcome.result.status !== "fail") return run;
  const sourceState = reviewRes.delta?.states?.[0];
  const sourceStateId = sourceState?.id ?? "";
  const sourceReviewSessionId = outcome.reviewerSessionId;
  let next = run;
  for (const finding of outcome.result.findings) {
    const targetSessionId = finding.target_session_id;
    const targetSession = targetSessionId
      ? next.agent_sessions.find((s) => s.id === targetSessionId)
      : undefined;
    const isResumable = Boolean(targetSession?.resumable);

    const findingId = nextLocalId(next, "finding");
    const findingRecord = {
      id: findingId,
      status: "new",
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      ...(finding.target ? { target: finding.target } : {}),
      source_state_id: sourceStateId,
      ...(sourceReviewSessionId ? { source_review_session_id: sourceReviewSessionId } : {}),
      ...(targetSessionId ? { target_work_session_id: targetSessionId } : {}),
      created_at: nowIso()
    };
    next = { ...next, findings: [...next.findings, findingRecord] };

    const inboxItem = isResumable
      ? {
          id: nextLocalId(next, "inbox"),
          status: "open",
          title: `Resume work: ${finding.title}`,
          detail: `resume prior worker session ${targetSession.id}`,
          finding_id: findingId,
          target_session_id: targetSession.id,
          action: {
            kind: "resume_work",
            prompt_artifact_id: ""
          },
          created_at: nowIso()
        }
      : {
          id: nextLocalId(next, "inbox"),
          status: "open",
          title: `Triage finding: ${finding.title}`,
          detail: targetSessionId
            ? `target worker session is not resumable: ${targetSessionId}`
            : "review finding does not identify a target worker session",
          finding_id: findingId,
          ...(targetSessionId ? { target_session_id: targetSessionId } : {}),
          action: {
            kind: "triage",
            reason: targetSessionId
              ? `target worker session is not resumable: ${targetSessionId}`
              : "review finding does not identify a target worker session"
          },
          created_at: nowIso()
        };
    next = { ...next, inbox: [...next.inbox, inboxItem] };
  }
  return next;
}

function normalizeMaxIterations(value) {
  if (value === undefined || value === null) return DEFAULT_AUTO_CONTINUE_MAX_ITERATIONS;
  if (!Number.isFinite(value) || value < 1) return DEFAULT_AUTO_CONTINUE_MAX_ITERATIONS;
  return Math.floor(value);
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Generate a deterministic-ish id local to the workflow run record. Counts
 * over states + activity_attempts + artifacts + findings + inbox +
 * agent_sessions so back-to-back appends never collide. Mirrors the
 * `nextIdFromRun` pattern host activities use.
 */
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

/**
 * Test-only export: makes the inbox-item construction logic that turns
 * a `parsed` review fail outcome into `FindingRecord` + `DecisionInboxItemRecord`
 * entries reachable from integration tests without driving a real review
 * activity.
 */
export function appendReviewFindingsAndInboxForTests(run, reviewRes) {
  return appendReviewFindingsAndInbox(run, reviewRes);
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

/**
 * Build the prompt fed to `runReviewActivity`. The host activity rejects
 * empty prompts (`review_activity_missing_prompt`); the workflow is the
 * only place that knows what to ask the reviewer for. The prompt embeds
 * the structured-review JSON contract plus a short scope label so the
 * reviewer knows which slice of the run it is reviewing.
 *
 * Test-only export.
 */
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
