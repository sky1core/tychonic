import { createIsolatedWorktree } from "../bootstrap/worktree.js";
import type { WorkflowRunRecord } from "../domain/types.js";
import { tychonicWorktreeParentDir } from "../runtime/worktreeDirs.js";

export interface CreateWorktreeActivityInput {
  run: WorkflowRunRecord;
  cwd: string;
}

export interface CreateWorktreeActivityResult {
  worktreePath: string;
  worktreeParentDir: string;
  mode: "git_worktree" | "directory_copy_no_head";
  reason: string;
  baseHead: string;
}

/**
 * Creates the isolated worktree a `simple_workflow` run mutates. Returns the
 * path + the creation mode (git worktree vs directory copy when no HEAD
 * exists). The calling workflow passes `worktreePath` into subsequent
 * worker / verify / review activities through the explicit
 * `worktreePath` call field.
 *
 * src/workflows/SPEC.md §Workflow Loop Semantics: "Background mutation must use an
 * isolated worktree." This activity is the single place that creates
 * one.
 */
export async function createWorktreeActivity(
  input: CreateWorktreeActivityInput
): Promise<CreateWorktreeActivityResult> {
  const isolated = await createIsolatedWorktree({
    cwd: input.cwd,
    runId: input.run.id,
    worktreeParentDir: worktreeParentDir()
  });
  return {
    worktreePath: isolated.path,
    worktreeParentDir: isolated.worktreeParentDir,
    mode: isolated.mode,
    reason: isolated.reason,
    baseHead: isolated.baseHead
  };
}

function worktreeParentDir(): string {
  return tychonicWorktreeParentDir();
}
