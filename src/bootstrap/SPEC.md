# Bootstrap Module SPEC

This file applies to shared activity bodies, command execution, and worktree
helpers under `src/bootstrap/`.

## Activity Bodies

The shared body functions implement one activity invocation body. They are not
workflow orchestration and they are not new activity TYPEs.

Each worker, review, or deterministic command body produces exactly one
`WorkflowStateRecord` and one `ActivityAttemptRecord` for that body call. It
does not mutate `input.run`. Filesystem writes are allowed body effects, but the
corresponding product records must be returned through `WorkflowRunDelta` and
the TYPE-specific outcome payload.

Skip conditions, policy routing, multi-iteration loops, mixed inbox
orchestration, and finding/inbox routing belong to the caller workflow or
activity entrypoint. A body runs the command it was asked to run, captures
evidence, and reports the result.

## Command Runner

Multi-line commands run in fail-fast shell mode. If any line exits non-zero, the
activity fails immediately and later lines do not run.

Command timeout is the command's own wall-clock budget. Heartbeat timeout is a
liveness contract around the whole activity and must not become the normal way a
healthy command ends.

Heartbeats must cover command launch, stdout/stderr capture, artifact writes,
session-id extraction, and post-processing. Heartbeats must not depend on child
process output; silent-but-healthy commands still require periodic heartbeats.

## Worktree Helpers

Background mutation must use an isolated worktree. Worktree helpers create or
describe that isolated path; they do not make workflow state decisions.

Isolated worktrees live under the user-home worktree root
`~/.tychonic/worktrees/`, not under `/tmp`, not under the target project's
`.tychonic/` directory, and not under the runtime state directory. Tychonic
evidence files live under the user-home run evidence root `~/.tychonic/runs/`,
not under the target project's `.tychonic/` directory, so ordinary repo
inspection and review do not traverse accumulated Tychonic byproducts.

When the target repository has `HEAD`, worktree helpers use Git's linked
worktree mechanism under that Tychonic-owned worktree root. Failed creation
removes any partial checkout and prunes stale Git metadata. Terminal workflows
capture an applicable `worktree_patch` artifact through
`extractWorktreePatchActivity` and leave the isolated worktree directory in
place for the operator to inspect or remove with standard tools; Tychonic
itself does not remove worktree directories on any finish, cancel, or recovery
path.

After a successful `git worktree add`, `createIsolatedWorktree` runs
`git submodule update --init --recursive` inside the new worktree so any
submodules the source repository tracks are populated. The call is
unconditional: a repository with no `.gitmodules` exits with nothing to do, so
the same code path works for repos with and without submodules and `work`
commands can read submodule files immediately.
