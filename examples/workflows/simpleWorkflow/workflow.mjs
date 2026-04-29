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
import {
  applyResult,
  appendReviewFindingsAndInbox,
  buildReviewPrompt,
  normalizeMaxIterations,
  runAutoContinueLoop,
  validateLoopPolicy,
  verificationCommands
} from "./reviewLoop.mjs";

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
npm test`,
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

const workflowStateQuery = defineQuery("tychonic.workflow_state");
const registerSessionSignal = defineSignal("tychonic.simple_workflow.register_session");

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

function defaultActivities() {
  return {
    runWorker: runWorkerActivity,
    runVerify: runVerifyActivity,
    runReview: runReviewActivity
  };
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
