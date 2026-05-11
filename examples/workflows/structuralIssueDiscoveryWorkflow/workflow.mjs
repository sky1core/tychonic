// structuralIssueDiscoveryWorkflow — deterministic checks plus scoped Claude
// structural reviews with an explicit finding audit gate.

import { proxyActivities } from "@temporalio/workflow";
import { createTychonicWorkflowContext } from "tychonic/workflow";

const act = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 3 }
});

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    contract_checks: {
      type: "verify",
      command: `npm run check:contracts
npm run typecheck
npm run build
npm run validate:examples`,
      timeout: "45m"
    },
    workflow_review: {
      type: "review",
      agent: "claude",
      model: "claude-opus-4-7",
      reasoning_effort: "max",
      permission_mode: "plan",
      timeout: "45m"
    },
    adapter_review: {
      type: "review",
      agent: "claude",
      model: "claude-opus-4-7",
      reasoning_effort: "max",
      permission_mode: "plan",
      timeout: "45m"
    },
    docs_review: {
      type: "review",
      agent: "claude",
      model: "claude-opus-4-7",
      reasoning_effort: "max",
      permission_mode: "plan",
      timeout: "45m"
    },
    finding_audit: {
      type: "review",
      agent: "claude",
      model: "claude-opus-4-7",
      reasoning_effort: "max",
      permission_mode: "plan",
      timeout: "30m"
    }
  },
  policies: {
    interaction: { mode: "auto" }
  }
};

export async function structuralIssueDiscoveryWorkflow(input) {
  const reviewStateNames = new Set([
    "workflow_review",
    "adapter_review",
    "docs_review"
  ]);
  const ctx = createTychonicWorkflowContext({
    input,
    template: "structural_issue_discovery",
    activities: act
  });

  await ctx.start();

  const checks = await ctx.verify("contract_checks");
  if (checks.halted) return ctx.finish(haltedSummary("contract_checks", checks));
  const checkSummary = summarizeChecks(checks);

  const workflowReview = await ctx.review(
    "workflow_review",
    workflowReviewInstructions({
      goal: input.goal,
      checkSummary,
      priorFindings: findingsForReviewStates(ctx.run(), reviewStateNames)
    })
  );
  if (workflowReview.halted) return ctx.finish(haltedSummary("workflow_review", workflowReview));

  const adapterReview = await ctx.review(
    "adapter_review",
    adapterReviewInstructions({
      goal: input.goal,
      checkSummary,
      priorFindings: findingsForReviewStates(ctx.run(), reviewStateNames)
    })
  );
  if (adapterReview.halted) return ctx.finish(haltedSummary("adapter_review", adapterReview));

  const docsReview = await ctx.review(
    "docs_review",
    docsReviewInstructions({
      goal: input.goal,
      checkSummary,
      priorFindings: findingsForReviewStates(ctx.run(), reviewStateNames)
    })
  );
  if (docsReview.halted) return ctx.finish(haltedSummary("docs_review", docsReview));

  const audit = await ctx.review(
    "finding_audit",
    findingAuditPrompt({
      goal: input.goal,
      checkSummary,
      findings: findingsForReviewStates(ctx.run(), reviewStateNames)
    })
  );
  if (audit.halted) return ctx.finish(haltedSummary("finding_audit", audit));

  return ctx.finish(finalSummary({
    checkSummary,
    findings: findingsForReviewStates(ctx.run(), reviewStateNames),
    auditPassed: audit.passed
  }));
}

function summarizeChecks(checks) {
  if (checks.passed) return "contract_checks passed";
  return `contract_checks did not pass: ${checks.state?.reason ?? checks.reason ?? checks.summary ?? "inspect artifacts"}`;
}

function haltedSummary(stateName, result) {
  return result.summary ?? result.state?.reason ?? `${stateName} halted`;
}

function workflowReviewInstructions({ goal, checkSummary, priorFindings }) {
  return commonReviewInstructions({
    stateName: "workflow_review",
    goal,
    checkSummary,
    priorFindings,
    scope: [
      "Scope:",
      "- Temporal workflow control flow, recovery, rerun, interaction gates, state lifecycle, and run-record updates.",
      "- Check SPEC.md, src/workflows/SPEC.md, workflow helper code, and example workflow code.",
      "- Focus on bugs that can leave workflow status, state evidence, rerun, or user-visible wait/status behavior wrong."
    ].join("\n")
  });
}

function adapterReviewInstructions({ goal, checkSummary, priorFindings }) {
  return commonReviewInstructions({
    stateName: "adapter_review",
    goal,
    checkSummary,
    priorFindings,
    scope: [
      "Scope:",
      "- Agent adapters, review parsing, structured output handling, model selection, session ids, and activity execution boundaries.",
      "- Check src/adapters, src/bootstrap, src/review, src/catalog, and related tests.",
      "- Focus on bugs where the wrong terminal source, wrong model, malformed reviewer output, or command-selection ambiguity can pass."
    ].join("\n")
  });
}

function docsReviewInstructions({ goal, checkSummary, priorFindings }) {
  return commonReviewInstructions({
    stateName: "docs_review",
    goal,
    checkSummary,
    priorFindings,
    scope: [
      "Scope:",
      "- Public docs, skills, example bundle docs, run input shape, and naming consistency.",
      "- Check README files, skills, AGENTS/GUARDRAILS, SPEC index references, and examples/workflows docs.",
      "- Focus on contradictions that would make operators run the wrong command, use non-contract fields, or mistake examples for built-in defaults."
    ].join("\n")
  });
}

function commonReviewInstructions({ stateName, goal, checkSummary, priorFindings, scope }) {
  return [
    "You are a structural bug reviewer for this repository.",
    "",
    "Return the Tychonic semantic review payload only. The review activity enforces the structured review schema.",
    "Report only actionable structural bugs or spec violations. Do not report style nits or vague concerns.",
    "Every finding must include the violated contract, exact file/line evidence, impact, and a precise fix direction in detail.",
    "",
    `Review state: ${stateName}`,
    `Goal: ${goal ?? "(no additional goal supplied)"}`,
    `Deterministic check status: ${checkSummary}`,
    "",
    "Already recorded findings in this workflow run:",
    formatFindingLedger(priorFindings),
    "",
    "Do not report an already recorded issue as a new finding. If you discover that a prior finding is broader than recorded, report only the materially new scope.",
    "",
    scope
  ].join("\n");
}

function findingAuditPrompt({ goal, checkSummary, findings }) {
  return [
    "You are the finding audit gate for a structural issue discovery workflow.",
    "",
    "Return pass only when every recorded finding below is actionable, non-duplicate, and supported by concrete file/line evidence.",
    "Return fail with findings only for defects in the recorded finding set itself: duplicate findings, unsupported claims, missing contract evidence, or findings that merely repeat the operator's known issue ledger.",
    "Do not re-review the entire repository for new bugs in this state. Audit the recorded findings only.",
    "",
    `Goal: ${goal ?? "(no additional goal supplied)"}`,
    `Deterministic check status: ${checkSummary}`,
    "",
    "Recorded findings to audit:",
    formatFindingLedger(findings)
  ].join("\n");
}

function findingsForReviewStates(run, reviewStateNames) {
  const reviewStateIds = new Set(run.states
    .filter((state) => reviewStateNames.has(state.name))
    .map((state) => state.id));
  return run.findings.filter((finding) => reviewStateIds.has(finding.source_state_id));
}

function formatFindingLedger(findings) {
  if (findings.length === 0) return "(none)";
  return findings.map((finding, index) => [
    `${index + 1}. ${finding.severity.toUpperCase()} ${finding.title}`,
    `   target: ${finding.target ?? "(none)"}`,
    `   detail: ${finding.detail}`
  ].join("\n")).join("\n");
}

function finalSummary({ checkSummary, findings, auditPassed }) {
  const findingCount = findings.length;
  if (findingCount === 0 && auditPassed) {
    return `structural issue discovery found no actionable findings; ${checkSummary}`;
  }
  if (!auditPassed) {
    return `structural issue discovery found ${findingCount} candidate finding(s), but finding_audit did not pass; inspect audit findings before acting`;
  }
  return `structural issue discovery found ${findingCount} actionable finding(s); ${checkSummary}`;
}
