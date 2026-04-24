import { defineQuery, proxyActivities, setHandler } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";
import type {
  SelfRepairWorkflowInput,
  SelfRepairWorkflowResult
} from "../temporal/types.js";
import { tychonicWorkflowStateQueryName } from "../temporal/types.js";
import {
  runSelfRepairWorkflowLoop,
  type SelfRepairWorkflowActivities
} from "./selfRepairWorkflowLoop.js";
import {
  registerInteractionSignals,
  setInteractionPolicy
} from "./interactionHook.js";

const act = proxyActivities<typeof activities>({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
});

const workflowStateQuery = defineQuery<SelfRepairWorkflowResult | undefined>(tychonicWorkflowStateQueryName);

export const requires = {
  states: [
    { name: "detect_bugs", type: "review" },
    { name: "write_regression_tests", type: "work" },
    { name: "review_regression_tests", type: "review" },
    { name: "fix_bugs", type: "work" },
    { name: "verify", type: "verify" },
    { name: "final_review", type: "review" }
  ]
} as const;

export async function selfRepairWorkflow(
  input: SelfRepairWorkflowInput
): Promise<SelfRepairWorkflowResult> {
  let latestResult: SelfRepairWorkflowResult | undefined;
  setHandler(workflowStateQuery, () => latestResult);

  // Register interactive signals and cache the policy before the first
  // `await`. Auto-mode runs resolve `waitForStateApproval` immediately
  // with no signal wait, leaving the Temporal history unchanged.
  registerInteractionSignals();
  setInteractionPolicy(input.profile?.policies?.interaction);

  const activitySet: SelfRepairWorkflowActivities = {
    startRunActivity: act.startRunActivity,
    createWorktreeActivity: act.createWorktreeActivity,
    runWorkerActivity: act.runWorkerActivity,
    runReviewActivity: act.runReviewActivity,
    runVerifyActivity: act.runVerifyActivity,
    finalizeRunActivity: act.finalizeRunActivity
  };

  latestResult = await runSelfRepairWorkflowLoop(input, activitySet, {
    onUpdate: (result) => {
      latestResult = result;
    }
  });
  return latestResult;
}
