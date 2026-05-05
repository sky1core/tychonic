// Example Tychonic workflow bundle: verifyOnlyWorkflow.
//
// Smallest runnable example: one deterministic verify state and no external AI
// agent dependency.

import { proxyActivities } from "@temporalio/workflow";
import { createTychonicWorkflowContext } from "tychonic/workflow";

const act = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
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

const VERIFY_ONLY_INPUT_FIELDS = new Set(["cwd", "profile"]);

function rejectUnknownInputFields(input) {
  if (!input || typeof input !== "object") return;
  for (const field of Object.keys(input)) {
    if (!VERIFY_ONLY_INPUT_FIELDS.has(field)) {
      throw new Error(`unsupported input field: ${field}`);
    }
  }
}

export async function verifyOnlyWorkflow(input) {
  rejectUnknownInputFields(input);
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
