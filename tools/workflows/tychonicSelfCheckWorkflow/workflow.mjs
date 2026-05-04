import { proxyActivities } from "@temporalio/workflow";
import { createTychonicWorkflowContext } from "tychonic/workflow";

const {
  startRunActivity,
  collectGitFactsActivity,
  runVerifyActivity,
  finalizeRunActivity
} = proxyActivities({
  startToCloseTimeout: "6 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
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

const ALLOWED_INPUT_FIELDS = new Set(["cwd", "profile"]);

export async function tychonicSelfCheckWorkflow(input) {
  rejectUnknownInputFields(input);
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
  return ctx.finish("tychonicSelfCheckWorkflow completed");
}

function rejectUnknownInputFields(input) {
  if (!input || typeof input !== "object") return;
  for (const field of Object.keys(input)) {
    if (!ALLOWED_INPUT_FIELDS.has(field)) {
      throw new Error(`unsupported input field: ${field}`);
    }
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`input.${field} is required`);
  }
  return value;
}
