import { collectGitFacts } from "../facts/gitFacts.js";
import type { WorkflowRunRecord } from "../domain/types.js";
import type { ActivityResult } from "../temporal/types.js";

export interface CollectGitFactsActivityInput {
  run: WorkflowRunRecord;
  cwd: string;
}

export type CollectGitFactsActivityResult = ActivityResult;

/**
 * Runs deterministic git-fact collection and returns the result as a
 * `WorkflowRunDelta.facts` patch. Does not create a state — fact
 * collection is a run-level attribute, not a workflow state. The caller
 * merges the delta through `applyRunDelta`.
 */
export async function collectGitFactsActivity(
  input: CollectGitFactsActivityInput
): Promise<CollectGitFactsActivityResult> {
  const result = await collectGitFacts(input.cwd);
  return {
    delta: { facts: result.facts }
  };
}
