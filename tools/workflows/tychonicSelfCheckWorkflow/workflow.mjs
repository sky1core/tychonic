import { proxyActivities } from "@temporalio/workflow";
import { createTychonicWorkflowContext, validateTaskWorkflowInput } from "tychonic/workflow";

const {
  startRunActivity,
  collectGitFactsActivity,
  runVerifyActivity,
  finalizeRunActivity
} = proxyActivities({
  startToCloseTimeout: "6 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 3 }
});

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    bootstrap: {
      type: "verify",
      command: "node scripts/tychonic-bootstrap-check.mjs",
      timeout: "6h"
    }
  },
  policies: {}
};

export async function tychonicSelfCheckWorkflow(input) {
  validateTaskWorkflowInput(input);
  const cwd = requireString(input?.cwd, "cwd");
  const ctx = createTychonicWorkflowContext({
    input: {
      cwd,
      profile: input?.profile ?? defaultProfile,
      goal: "Run the Tychonic bootstrap self-check workflow."
    },
    template: "tychonicSelfCheckWorkflow",
    activities: {
      startRunActivity,
      runVerifyActivity,
      finalizeRunActivity
    }
  });

  await ctx.start();
  ctx.apply(await collectGitFactsActivity({ run: ctx.run(), cwd }));
  await ctx.verify("bootstrap");
  return ctx.finish();
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`input.${field} is required`);
  }
  return value;
}
