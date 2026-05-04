// Example Tychonic workflow bundle: simpleWorkflow.
//
// Install with:
//
//   tychonic workflows install ./examples/workflows/simpleWorkflow
//
// Operational installs refresh the LaunchAgent worker when one is installed.
// Isolated-instance installs require restarting that instance's runtime.
// See docs/plugin-workflows.md for the authoring guide.
//
// This bundle composes per-TYPE activities the way pipelineWorkflow does
// and owns its own auto-continue loop bookkeeping. The workflow returns
// once it reaches a Tychonic terminal status (succeeded / waiting_user /
// failed); terminal waiting_user recovery is a fresh run with adjusted input
// or config.

import { proxyActivities } from "@temporalio/workflow";
import { createTychonicRunState } from "tychonic/workflow";
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

/**
 * `simpleWorkflow` — work / verify / review loop.
 *
 * Input shape:
 *   {
 *     cwd: string,
 *     goal?: string
 *   }
 * Host-injected: profile?: TychonicConfig
 */
const SIMPLE_WORKFLOW_INPUT_FIELDS = new Set([
  "cwd",
  "goal",
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
  const runState = createTychonicRunState();

  const publishRun = (run, worktreePath) => {
    const published = runState.update(run, worktreePath ? { worktreePath } : {});
    return published;
  };

  // Run work -> verify -> review with optional auto-continue. The
  // workflow returns once it reaches a Tychonic terminal status.
  let latestResult = await runMainPipeline({ ...input, profile: profileSnapshot }, runState, publishRun);
  runState.update(latestResult.run, {
    artifactRoot: latestResult.artifactRoot,
    worktreePath: latestResult.worktreePath,
    summary: latestResult.summary
  });
  latestResult = runState.current() ?? latestResult;

  return latestResult;
}

async function runMainPipeline(input, runState, publishRun) {
  const profile = input.profile;
  let worktreePath;
  const updateRun = (next) => publishRun(next, worktreePath);
  let run = await startRunActivity({
    template: "simple_workflow",
    cwd: input.cwd,
    ...(profile ? { profile } : {}),
    ...(input.goal ? { goal: input.goal } : {})
  });
  run = updateRun({ ...run, status: "running" });

  const wt = await createWorktreeActivity({ run, cwd: input.cwd });
  worktreePath = wt.worktreePath;
  run = updateRun(run);

  // Stage: work
  const workRes = await runWorkerActivity({
    stateName: "work",
    run,
    ...(profile ? { profile } : {}),
    cwd: input.cwd,
    worktreePath,
    ...(input.goal ? { goal: input.goal } : {})
  });
  run = updateRun(applyResult(run, workRes));
  const workSession = workRes.workerOutcome?.kind === "executed"
    ? workRes.workerOutcome.agentSessions[0]
    : undefined;

  if (workRes.delta?.states?.[0]?.status !== "succeeded") {
    return finalize(run, input.cwd, worktreePath, runState, "work failed");
  }

  // Stage: verify
  const verifyRes = await runVerifyActivity({
    stateName: "verify",
    run,
    ...(profile ? { profile } : {}),
    cwd: input.cwd,
    worktreePath
  });
  run = updateRun(applyResult(run, verifyRes));
  if (verifyRes.delta?.states?.[0]?.status !== "succeeded") {
    return finalize(run, input.cwd, worktreePath, runState, "verify failed");
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
    run = updateRun(applyResult(run, reviewRes));
    run = updateRun(appendReviewFindingsAndInbox(run, reviewRes));

    if (profile?.policies?.loop?.auto_continue) {
      const maxIter = normalizeMaxIterations(
        profile?.policies?.loop?.max_review_iterations
      );
      run = await runAutoContinueLoop({
        input,
        run,
        worktreePath,
        workSession,
        maxIterations: maxIter,
        activities: defaultActivities(),
        onRunUpdate: updateRun
      });
    }
  }

  return finalize(run, input.cwd, worktreePath, runState);
}

function defaultActivities() {
  return {
    runWorker: runWorkerActivity,
    runVerify: runVerifyActivity,
    runReview: runReviewActivity
  };
}

async function finalize(run, cwd, worktreePath, runState, summary) {
  const fin = await finalizeRunActivity({ run, ...(summary ? { summary } : {}) });
  run = applyResult(run, fin);
  return runState.result(run, { artifactRoot: `${cwd}/.tychonic/runs/${run.id}`, worktreePath });
}
