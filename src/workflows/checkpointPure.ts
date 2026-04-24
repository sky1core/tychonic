import type { TychonicConfig } from "../catalog/types.js";
import type { RunFacts } from "../facts/gitFacts.js";
import type { WorkflowRunRecord, WorkflowStateRecord } from "../domain/types.js";

/**
 * Pure helpers the Stage 5 `checkpoint` workflow uses to drive its
 * activity orchestration. Isolated in this file (no fs, no spawn, no
 * network) so Temporal's workflow sandbox can load them.
 */

const EMPTY_FACTS: RunFacts = {
  changed_files: [],
  has_changes: false,
  has_source: false,
  only_docs: false,
  tests_changed: false,
  frontend_changed: false,
  docs_changed: false
};

export function factsForRun(run: WorkflowRunRecord): RunFacts {
  if (run.facts && typeof run.facts === "object" && !Array.isArray(run.facts)) {
    return { ...EMPTY_FACTS, ...(run.facts as Partial<RunFacts>) };
  }
  return { ...EMPTY_FACTS };
}

export function integrationPosition(profile: TychonicConfig): "before_ai_review" | "after_ai_review" | "final_gate" {
  return profile.policies?.integration?.position ?? "final_gate";
}

export function reviewPrompt(run: WorkflowRunRecord): string {
  const facts = factsForRun(run);
  const changedFiles =
    facts.changed_files.length > 0
      ? facts.changed_files
          .map((file) => `- ${file.path}${file.categories.length > 0 ? ` [${file.categories.join(",")}]` : ""}`)
          .join("\n")
      : "- no changed files detected";

  return [
    "Review the current working tree changes for correctness, regressions, missing tests, and risky assumptions.",
    "",
    "Return only one JSON object matching this contract. Do not wrap it in markdown.",
    "{",
    '  "schema_version": "tychonic.review.v1",',
    '  "status": "pass|fail",',
    '  "summary": "short result summary",',
    '  "findings": [',
    '    {"severity": "critical|high|medium|low", "title": "finding title", "detail": "actionable explanation", "target": "file, state, or session", "target_session_id": "worker session id when the finding should resume prior work"}',
    "  ]",
    "}",
    "Use status pass only when findings is empty. Use status fail when any actionable finding exists.",
    "",
    "Changed files:",
    changedFiles,
    run.target_session_id ? `\nTarget worker session for continuation: ${run.target_session_id}` : "",
    ""
  ].join("\n");
}

export const TEST_REVIEW_PROMPT =
  "Review the changed tests for behavior coverage, false confidence, and maintainability.\n";

/**
 * Builds a skipped `WorkflowStateRecord` in-line. Used by the workflow
 * when a deterministic skip condition (autonomy, missing block, facts)
 * applies without running any command. Produces a state with a terminal
 * lifecycle (`succeeded_at` / `finished_at` both set) per SPEC §State
 * lifecycle.
 */
export function skippedState(input: {
  id: string;
  stateName: string;
  reason: string;
  now: string;
}): WorkflowStateRecord {
  return {
    id: input.id,
    name: input.stateName,
    status: "skipped",
    reason: input.reason,
    activity_attempt_ids: [],
    artifact_ids: [],
    finding_ids: [],
    started_at: input.now,
    finished_at: input.now
  };
}

export function nextSequentialId(prefix: string, existingIds: readonly string[]): string {
  let max = 0;
  const pattern = new RegExp(`^${escapeRegex(prefix)}_(\\d+)$`);
  for (const id of existingIds) {
    const match = pattern.exec(id);
    if (!match) continue;
    max = Math.max(max, Number(match[1]));
  }
  return `${prefix}_${max + 1}`;
}

export function appendInboxForActionableSkippedReviews(run: WorkflowRunRecord, now: string): WorkflowRunRecord {
  const existingInboxIds = new Set(run.inbox.map((item) => item.id));
  const nextInbox = [...run.inbox];
  for (const state of run.states) {
    if (!isActionableSkippedReview(state)) continue;
    const inboxId = `inbox_skipped_${state.id}`;
    if (existingInboxIds.has(inboxId)) continue;
    existingInboxIds.add(inboxId);
    nextInbox.push({
      id: inboxId,
      status: "open",
      title: `${state.name} skipped`,
      detail: state.reason,
      action: { kind: "triage", reason: state.reason },
      created_at: now
    });
  }
  return { ...run, inbox: nextInbox };
}

export function shouldRunDeterministicCommand(
  autonomy: "observe" | "check" | "review",
  blockMissing: boolean,
  facts: RunFacts,
  stateName: "lint" | "unit_test"
): { run: boolean; skipReason?: string } {
  if (autonomy === "observe") {
    return { run: false, skipReason: `autonomy ${autonomy} does not run deterministic commands` };
  }
  if (blockMissing) {
    return { run: false, skipReason: `${stateName} command is not configured` };
  }
  if (stateName === "unit_test" && facts.only_docs) {
    return { run: false, skipReason: "diff only changes docs" };
  }
  return { run: true };
}

export function shouldRunSemanticReview(
  autonomy: "observe" | "check" | "review",
  blockMissing: boolean,
  failedEarlier: boolean,
  facts: RunFacts
): { run: boolean; skipReason?: string } {
  if (autonomy === "observe") {
    return { run: false, skipReason: "autonomy observe does not run semantic review" };
  }
  if (blockMissing) {
    return { run: false, skipReason: "activity 'semantic_review' is not configured" };
  }
  if (failedEarlier) {
    return { run: false, skipReason: "previous required state failed" };
  }
  if (facts.only_docs || !facts.has_source) {
    return { run: false, skipReason: "no source changes requiring review" };
  }
  return { run: true };
}

export function shouldRunTestReview(
  autonomy: "observe" | "check" | "review",
  blockMissing: boolean,
  failedEarlier: boolean,
  facts: RunFacts
): { run: boolean; skipReason?: string } {
  if (autonomy !== "review") {
    return { run: false, skipReason: `autonomy ${autonomy} does not run test-review` };
  }
  if (failedEarlier) {
    return { run: false, skipReason: "previous required state failed" };
  }
  if (!facts.tests_changed) {
    return { run: false, skipReason: "no test files changed" };
  }
  if (blockMissing) {
    return { run: false, skipReason: "activity 'test_review' is not configured" };
  }
  return { run: true };
}

export function hasFailedOrTimedOutState(run: WorkflowRunRecord): boolean {
  return run.states.some((state) => state.status === "failed" || state.status === "timed_out");
}

export function summarizeRun(run: WorkflowRunRecord): string {
  const failed = run.states.filter((state) => state.status === "failed").length;
  const succeeded = run.states.filter((state) => state.status === "succeeded").length;
  const skipped = run.states.filter((state) => state.status === "skipped").length;
  const blocked = run.states.filter((state) => state.status === "blocked").length;
  const timedOut = run.states.filter((state) => state.status === "timed_out").length;
  const parts: string[] = [];
  if (succeeded > 0) parts.push(`${succeeded} succeeded`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (blocked > 0) parts.push(`${blocked} blocked`);
  if (timedOut > 0) parts.push(`${timedOut} timed_out`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.length > 0 ? parts.join(", ") : "no states recorded";
}

function isActionableSkippedReview(state: WorkflowStateRecord): boolean {
  if (state.status !== "skipped") {
    return false;
  }
  if (state.name !== "semantic_review" && state.name !== "test_review") {
    return false;
  }
  return /^activity '.*' is not configured$/.test(state.reason);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
