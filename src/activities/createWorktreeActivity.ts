import { createIsolatedWorktree } from "../bootstrap/worktree.js";
import type { WorkflowRunRecord } from "../domain/types.js";

export interface CreateWorktreeActivityInput {
  run: WorkflowRunRecord;
  cwd: string;
}

export interface CreateWorktreeActivityResult {
  worktreePath: string;
  mode: "git_worktree" | "directory_copy_no_head";
  reason: string;
}

/**
 * Creates the isolated worktree a `simple_workflow` run mutates. Returns the
 * path + the creation mode (git worktree vs directory copy when no HEAD
 * exists). The calling workflow passes `worktreePath` into subsequent
 * worker / verify / review activities through the explicit
 * `worktreePath` call field.
 *
 * SPEC §Workflow Loop Semantics: "Background mutation must use an
 * isolated worktree." This activity is the single place that creates
 * one.
 */
export async function createWorktreeActivity(
  input: CreateWorktreeActivityInput
): Promise<CreateWorktreeActivityResult> {
  const isolated = await createIsolatedWorktree({ cwd: input.cwd, runId: input.run.id });
  return {
    worktreePath: isolated.path,
    mode: isolated.mode,
    reason: isolated.reason
  };
}
