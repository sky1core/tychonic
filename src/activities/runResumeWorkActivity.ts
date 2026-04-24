import type { ActivityResult, ActivityInput } from "../temporal/types.js";
import { runWorkerActivity } from "./runWorkerActivity.js";

export type RunResumeWorkActivityInput = ActivityInput<"work">;
export type RunResumeWorkActivityResult = ActivityResult;

/**
 * Compatibility wrapper for explicit resume calls. The product surface no
 * longer models `resume_work` as a distinct activity type; callers that
 * already know which session to continue can route through `work` with
 * `extras.sessionId`.
 */
export async function runResumeWorkActivity(
  input: RunResumeWorkActivityInput
): Promise<RunResumeWorkActivityResult> {
  return runWorkerActivity(input);
}
