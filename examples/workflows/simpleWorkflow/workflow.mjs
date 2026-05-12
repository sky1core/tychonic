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
import {
  createTychonicInteraction,
  createTychonicRunState,
  latestStateByName,
  promptWithAddition,
  validateTaskWorkflowInput
} from "tychonic/workflow";
import { validateLoopPolicy } from "./loopPolicy.mjs";
import {
  applyResult,
  appendReviewFindingsAndInbox,
  buildReviewPrompt,
  normalizeMaxIterations,
  runActivityWithRecovery,
  runAutoContinueLoop,
  verificationCommands
} from "./reviewLoop.mjs";

const act = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 3 }
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
      agent: "codex",
      model: "gpt-5.5",
      reasoning_effort: "xhigh",
      approval: "never",
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
export async function simpleWorkflow(input) {
  validateTaskWorkflowInput(input);
  validateLoopPolicy(input.profile?.policies);
  // Snapshot the effective profile at workflow start. The cap loop reads
  // caps from this snapshot, never from a re-read of the input — a mid-run
  // "reinstall" of the bundle does not change the running cap values.
  const profileSnapshot = input.profile;
  const runState = createTychonicRunState();
  const interaction = createTychonicInteraction();

  const publishRun = (run, worktreePath) => {
    const published = runState.update(run, worktreePath ? { worktreePath } : {});
    return published;
  };

  // Run work -> verify -> review with optional auto-continue. The
  // workflow returns once it reaches a Tychonic terminal status.
  let latestResult = await runMainPipeline({ ...input, profile: profileSnapshot }, runState, publishRun, interaction);
  runState.update(latestResult.run, {
    artifactRoot: latestResult.artifactRoot,
    worktreePath: latestResult.worktreePath,
    summary: latestResult.summary
  });
  latestResult = runState.current() ?? latestResult;

  return latestResult;
}

async function runMainPipeline(input, runState, publishRun, interaction) {
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
  const workCall = await runActivityWithRecovery({
    run,
    stateName: "work",
    kind: "work",
    cwd: worktreePath ?? input.cwd,
    interaction,
    onRunUpdate: updateRun,
    invoke: (currentRun) => runWorkerActivity({
      stateName: "work",
      run: currentRun,
      ...(profile ? { profile } : {}),
      cwd: input.cwd,
      worktreePath,
      prompt: promptWithAddition(buildWorkPrompt(input.goal), input, "work")
    })
  });
  run = workCall.run;
  const workRes = workCall.result;
  const workSession = workRes?.workerOutcome?.kind === "executed"
    ? workRes.workerOutcome.agentSessions[0]
    : undefined;

  if (latestStateByName(run, "work")?.status !== "succeeded") {
    return finalize(run, input.cwd, worktreePath, runState, "work failed");
  }

  // Stage: verify
  const verifyCall = await runActivityWithRecovery({
    run,
    stateName: "verify",
    kind: "verify",
    cwd: worktreePath ?? input.cwd,
    interaction,
    onRunUpdate: updateRun,
    invoke: (currentRun) => runVerifyActivity({
      stateName: "verify",
      run: currentRun,
      ...(profile ? { profile } : {}),
      cwd: input.cwd,
      worktreePath
    })
  });
  run = verifyCall.run;
  if (latestStateByName(run, "verify")?.status !== "succeeded") {
    return finalize(run, input.cwd, worktreePath, runState, "verify failed");
  }

  // Stage: review (optional)
  if (profile?.states?.review) {
    const reviewCall = await runActivityWithRecovery({
      run,
      stateName: "review",
      kind: "review",
      cwd: worktreePath ?? input.cwd,
      interaction,
      onRunUpdate: updateRun,
      invoke: (currentRun) => runReviewActivity({
        stateName: "review",
        run: currentRun,
        ...(profile ? { profile } : {}),
        cwd: input.cwd,
        worktreePath,
        prompt: promptWithAddition(buildReviewPrompt(currentRun, "initial work output"), input, "review"),
        verificationCommands: verificationCommands(profile)
      })
    });
    run = reviewCall.run;
    const reviewRes = reviewCall.result;
    if (reviewRes) {
      run = updateRun(appendReviewFindingsAndInbox(run, reviewRes));
    }

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
        onRunUpdate: updateRun,
        interaction
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

function buildWorkPrompt(goal) {
  return [
    "Complete the requested work in the target project.",
    "",
    "Goal:",
    goal || "(no explicit goal supplied; infer from the project state)",
    "",
    "Before editing, inspect the target project's applicable rules and",
    "specifications. Follow relevant constraints while working, and include",
    "the constraints you checked plus compliance status in your final note."
  ].join("\n");
}

async function finalize(run, cwd, worktreePath, runState, summary) {
  const fin = await finalizeRunActivity({ run, ...(summary ? { summary } : {}) });
  run = applyResult(run, fin);
  return runState.result(run, { artifactRoot: `${cwd}/.tychonic/runs/${run.id}`, worktreePath });
}
