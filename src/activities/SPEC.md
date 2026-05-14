# Activities Module SPEC

This file applies to Temporal activity functions under `src/activities/` and to
shared activity body behavior used by those functions.

## States And Activities

Tychonic separates the **workflow state machine** (runtime positions) from the
**backend activity** (code that executes work). These are different categories.
Every other term must reduce to one of them.

- **State** — a position in a workflow's state machine. Each state has a NAME
  (unique within the workflow run), a status drawn from `pending | running |
  succeeded | failed | skipped | blocked | timed_out`, attempts, and artifacts.
  An activity produces one or more states per invocation. The runtime record
  type is `WorkflowStateRecord` and the record array is `run.states[]`.
- **Activity** — a Temporal activity function registered on the Tychonic
  worker. State-producing TYPE activities are `runWorkerActivity`,
  `runVerifyActivity`, and `runReviewActivity`. An activity takes a state NAME
  as a parameter, reads the state config block under that NAME from the
  effective profile, validates that the block's `type` matches the activity's
  TYPE, runs its TYPE contract, and returns a `WorkflowRunDelta` plus
  TYPE-specific outcome fields. Temporal records each call as an activity task
  in workflow history.

NAME is a property of the state, not of the activity function. The same
activity function is called with many distinct state NAMEs per run; the states
those calls produce sit side by side in `run.states[]`. TYPE is a property of
both the activity function (fixed per function) and each state config block
(declared by the user so the schema validator can accept or reject the block for
that function).

No third concept exists at runtime. Terms like "step activity", "workflow step",
"named activity instance", or "activity binding" are not product concepts; use
"state" (machine position / record) or "activity" (backend function) as
appropriate.

## Activity Result And Evidence Invariants

The product run id is `WorkflowRunRecord.id`. Temporal workflow ids and Temporal
run ids are SDK identifiers; they are not the surfaced Tychonic run id used for
artifact paths, inbox references, or user-facing run records.
`WorkflowRunRecord.id` is a single path segment: no slash, path traversal, or
empty value is valid.

An activity that receives an existing `WorkflowRunRecord` treats `input.run` as
an immutable snapshot. It does not push into, splice, or otherwise mutate
`input.run.states`, `input.run.activity_attempts`, `input.run.artifacts`,
`input.run.findings`, `input.run.inbox`, or `input.run.agent_sessions`.
Filesystem writes are allowed activity effects, but the corresponding product
records must be returned through `WorkflowRunDelta` and TYPE-specific outcome
fields. Workflow code owns the live run record and applies returned deltas to
its own copy.

An activity invocation that starts a `WorkflowStateRecord` or an
`ActivityAttemptRecord` must return it in a terminal state before the activity
call completes. The workflow record must not contain activity-produced
`running` states or unfinished attempts after an activity result has been
merged. Review, worker, and deterministic command body invocations each produce
exactly one state record and one activity attempt record for that body call;
lifecycle or fact-gathering activities that do not enter a workflow state
return only run-level deltas.

External agent session references are evidence. When an external agent
invocation yields a session reference, the activity result records it as an
`AgentSessionRecord` and links the relevant attempt to that session.
`AgentSessionRecord.id` is that session reference. Tychonic does not store a
second session id beside it.

Activity-produced artifact records use the state NAME in their `kind` so the
artifact can be traced back without inspecting the file path. The kind format is
`<NAME>_<role>` (for example `<NAME>_prompt`, `<NAME>_output`,
`<NAME>_parsed`). The corresponding artifact file name is
`<kind>-<attemptId>.<ext>`. Run-level artifacts that are not produced by a state
attempt may use their own documented names.

Review TYPE maps reviewer execution and parse outcomes to state status as
follows:

| Outcome | State status |
| --- | --- |
| execution prevented by config or missing block | `skipped` |
| reviewer command exits non-zero | `failed` |
| reviewer command times out | `timed_out` |
| reviewer output is malformed for `tychonic.review.v1` | `blocked` |
| parsed `fail` verdict | `failed` |
| parsed `pass` verdict | `succeeded` |

Reviewer command failure, timeout, and malformed output are never a pass. Each
must leave prompt/output artifact evidence for triage.
Review states may inspect files and run checks, but must not modify the source
worktree or act as hidden repair. When the execution cwd is a git worktree, the
review activity compares git status before and after the reviewer command; a
net worktree mutation fails the activity.
Review findings and triage inbox items are appended by workflow code after it
merges the review activity result; the shared activity body does not mutate the
caller-owned run record to add them.

Retries that change product state belong in workflow code with explicit state
NAMEs, not in Temporal activity proxy retry.

An explicit state rerun is a new workflow decision to invoke the same state NAME
again. It appends a new state record and activity attempt record. It does not
rewrite, delete, or reinterpret the prior failed/timed-out/blocked attempt.

## Activity Timing

When a state config block omits `timeout`, Tychonic applies the per-TYPE default
below. An explicit `timeout` on the block overrides that per-TYPE default.

| Type | Default timeout |
| --- | --- |
| `verify` | 30 minutes |
| `work` | 120 minutes |
| `review` | 45 minutes |

Temporal activity envelopes and worker drain defaults are intentionally more
generous than these command defaults so long-running local checks can finish or
hit their own configured timeout.

Heartbeat timeout is a liveness contract, not a normal failure mode. Any
activity that Temporal runs with a heartbeat timeout must send heartbeats for
the full wall-clock lifetime of the activity, from command launch through output
capture, artifact writes, session-id extraction, and every other
post-processing step. This is especially required for long-running `work` and
structured `review` activities.

A healthy long-running activity may finish successfully, fail its command, or
hit its configured command `timeout`. It must **not** fail merely because
Tychonic stopped heartbeating while the underlying agent/process was still doing
valid work. If an activity hits Temporal heartbeat timeout before its own
command timeout, treat that as a product bug in Tychonic orchestration.

Heartbeats must not depend on child-process stdout/stderr traffic.
Silent-but-healthy commands, quiet model turns, and post-command bookkeeping
still require periodic heartbeats. The heartbeat path must therefore be wired at
the activity entrypoint and remain active even when the child emits no output.

Multi-line commands run in fail-fast shell mode. If any line exits non-zero, the
activity fails immediately and later lines do not run.

## Verification Boundary

Verification splits along the worktree boundary. Worker activities run in an
isolated worktree and must only perform checks that complete inside that
worktree. Release-gate checks that require external network or machine state
belong on the operator side, after the operator applies a patch to the source
tree.

- **Worker-side verification** (`npm run verify:worker`): typecheck, unit
  tests, build, and example validation. Runs end-to-end without network access
  and without touching the user's machine-level state.
- **Release verification** (`npm run verify`): extends worker-side with
  `npm audit`, `npm publish --dry-run`, and the package smoke install. These
  steps require network access to the public registry and are only meaningful
  against the applied source tree; they are not attempted inside the worker
  sandbox.

Worker instructions must reference `verify:worker` as the in-sandbox gate.
Calling the full `verify` command from a worker activity is a contract violation
— the sandbox cannot satisfy it, and workarounds (conditional skips, offline
shims, silenced registry failures) weaken the release gate. If a check cannot
run inside the worker, the product splits the check into worker and operator
variants with distinct names; it never makes a required gate conditional on the
environment.
