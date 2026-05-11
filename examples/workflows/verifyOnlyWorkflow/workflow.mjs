// Example Tychonic workflow bundle: verifyOnlyWorkflow.
//
// Smallest runnable example: one deterministic verify state and no external AI
// agent dependency.

import { proxyActivities } from "@temporalio/workflow";
import { createTychonicWorkflowContext, validateTaskWorkflowInput } from "tychonic/workflow";

const act = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 3 }
});

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    verify: {
      type: "verify",
      command: `git status --short
git diff --check`
    }
  },
  policies: {}
};

export async function verifyOnlyWorkflow(input) {
  validateTaskWorkflowInput(input);
  const ctx = createTychonicWorkflowContext({
    input,
    template: "verify_only",
    activities: act
  });

  await ctx.start();
  ctx.apply(await act.collectGitFactsActivity({ run: ctx.run(), cwd: input.cwd }));
  await ctx.verify("verify");
  return ctx.finish();
}
