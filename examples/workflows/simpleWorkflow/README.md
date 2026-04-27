# simpleWorkflow

## Overview

`simpleWorkflow` is a work / verify / review development loop. Each iteration
runs the `work` state, then the deterministic `verify` state, then the
structured `review` state. On a `fail` verdict the loop resumes the same
worker session (when the agent CLI exposes one) and continues until review
passes or the configured iteration budget runs out. When the budget is
exhausted with findings still open, the run promotes to `waiting_user` with
inbox items describing the unresolved findings, and the workflow terminates.

## States declared

`simpleWorkflow` calls these state names. The authoritative source is
`workflow.mjs`'s `defaultProfile.states`; run `tychonic config show
--workflow-name simpleWorkflow` to see the live values.

- `work` — `work`
- `verify` — `verify`
- `review` — `review`

## Default profile

The bundle's `defaultProfile` declares `states.work`, `states.verify`,
`states.review`, and `policies.loop` (auto-continue caps). Inspect the live
values with:

```sh
tychonic config show --workflow-name simpleWorkflow --format yaml
```

Override for a single invocation through `--config <file>`; the override
replaces the profile as one whole object (no merge).

## Input shape

`tychonic run simpleWorkflow --input-file <file>` passes the JSON file
straight to the workflow as its Temporal input. Recognised fields:

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository working directory the workflow records on the run record. The actual worker steps run in an isolated worktree derived from this path. |
| `goal` | no | Free-text goal passed to the worker. |
| `autoContinue` | no | Set `true` to enable the auto-continue loop. Required for any cap to fire. |
| `maxIterations` | no | Outer auto-continue iteration budget. **Takes precedence over `profile.policies.loop.max_review_iterations`.** When both are omitted the workflow uses its built-in default (`5`). |
| `profile` | no | Profile object (`tychonic.config.v1` shape) overriding the installed bundle's `defaultProfile` for this run. |

Work, verify, and review execution settings come from
`profile.states.*`. To change a command or agent for one run, pass a whole
replacement profile with `--config <file>` or `input.profile`; do not put
execution selectors in task input.

`cwd` must point at a git repository, including a freshly initialized repo
with no HEAD. It is not an arbitrary scratch directory; worktree creation
uses git to snapshot tracked and untracked files into the isolated worker
directory.

The outer auto-continue budget resolves in this order: `input.maxIterations`,
then `input.profile.policies.loop.max_review_iterations`, then the workflow
default (`5`). The same-session resume cap is read from
`profile.states.work.resume` (numeric, default `0` when omitted; this
bundle's `defaultProfile` sets it to `3`).

Unknown input fields are rejected at workflow start with the error
`unsupported input field: <name>`.

## What the review state must emit

The `review` state must emit one `tychonic.review.v1` JSON object. Plain
shell exit codes (`true`, `false`) are not enough — the activity treats
unparseable output as `blocked`, not as a clean `pass`/`fail`, and the run
lands in a triage state instead of the auto-continue loop. The reviewer must
print an object of exactly this shape (see SPEC §"Structured Reviewer
Contract"):

```json
{
  "schema_version": "tychonic.review.v1",
  "status": "pass",
  "summary": "all checks satisfied",
  "findings": []
}
```

```json
{
  "schema_version": "tychonic.review.v1",
  "status": "fail",
  "summary": "verify exited 1; the worker did not create the marker file",
  "findings": [
    {
      "severity": "high",
      "title": "Missing done.txt",
      "detail": "The worker step did not create /worktree/done.txt; verify failed with exit code 1.",
      "target": "done.txt",
      "target_session_id": "session_w0"
    }
  ]
}
```

Rules: `status` is `pass` or `fail`; `pass` requires an empty `findings`;
`fail` requires at least one finding; `severity` is `critical` / `high` /
`medium` / `low`. Any other shape (or no output at all) is treated as
malformed and routed to triage rather than to the loop.

For a finding to enter the same-session resume loop, `target_session_id`
must name a worker session already recorded in the run. A finding without
`target_session_id` is triage, not an inferred resume target.
The target session must also be resumable through a built-in adapter path.
Custom `command` worker sessions are recorded as evidence but are not
resumable, so findings against them route to triage instead of the
same-session loop.

To wire a real reviewer, use the bundle's `states.review` config block. The
reviewer can be a built-in review-capable adapter or an explicit state-block
`command` as long as it emits the contract object.

## Auto-continue loop caps

The auto-continue loop caps how many same-session resumes the workflow
stacks before promoting the run to `waiting_user`. The cap behavior is a
`simpleWorkflow` contract — other Tychonic workflows do not read these
knobs. To check which keys a given workflow respects, read its bundle
README and inspect its `defaultProfile`.

| Knob | Default | Behavior |
|---|---|---|
| `states.work.resume` | `3` in this bundle profile; `0` if omitted | Maximum same-session resumes before the run lands in `waiting_user`. Set to `0` to disable in-session resume entirely (every iteration starts a fresh session). |
| `policies.loop.auto_continue` | `false` | Must be `true` for the workflow to loop on review `fail`. Without it the workflow stops after the first review verdict. |
| `policies.loop.max_review_iterations` | workflow-defined | Outer review-iteration budget. |

`policies.loop.max_review_iterations` requires `auto_continue: true`.
`tychonic workflows validate` enforces the dependency; run it against any
hand-written profile before installing.

Profile fragment (not a complete `--config` file):

```yaml
states:
  work:
    type: work
    agent: claude
    resume: 5
policies:
  loop:
    auto_continue: true
    max_review_iterations: 8
```

When `states.work.resume` is exhausted, the workflow records the unresolved
findings and lands in `waiting_user` with an inbox item titled
`Resume cap exhausted with unresolved findings`. Recovery means starting a
fresh `simpleWorkflow` run with adjusted input, optionally referencing the
previous run's artifacts in the new brief.

## Recovery flow

A `simpleWorkflow` run lands in `waiting_user` when either:

- `states.work.resume` is exhausted (inbox item: `Resume cap exhausted
  with unresolved findings`), or
- `policies.loop.max_review_iterations` is reached with the last review
  still failing.

In both cases the workflow emits inbox items describing the unresolved
findings and terminates. To recover:

1. Inspect: `tychonic inbox --workflow-id <id>` and `tychonic artifacts
   --workflow-id <id>`.
2. Start a fresh `simpleWorkflow` run with adjusted input — for example
   a tighter `goal` or a higher `maxIterations` budget. Reference the
   previous run's artifacts in the new brief if useful.

Synchronous vs asynchronous invocation:

- `tychonic run simpleWorkflow --input-file <file> --wait` blocks the CLI
  until the workflow reaches a terminal status and returns the run result.
  Use this when a single CLI call should produce the final outcome.
- Omit `--wait` to dispatch the run asynchronously. The CLI returns the
  workflow id immediately; query progress with `tychonic status`,
  `tychonic inbox`, etc.

## Writing development briefs

When using `simpleWorkflow` as the development workflow, the brief must say
exactly what the worker should do. The issue is not "narrow vs broad" — it
is whether the brief states the desired contract precisely enough that the
worker cannot reinterpret product direction on its own.

A development brief for `simpleWorkflow` must include all of these:

- current canonical product names that must remain unchanged during the task
- exact feature/fix to implement
- exact file or module scope to edit
- explicit do-not-touch surface
- exact verification command or failing test to make pass
- explicit stop condition if the worker discovers a broader naming/spec
  issue

```text
Implement exactly X.
Current canonical names are A/B/C; do not rename product surfaces.
Only edit files under Y.
Do not modify Z.
Make this verification pass: <command>.
If the task appears to require broader product renaming or spec
reinterpretation, stop and report instead of making repo-wide changes.
```

Vague goals such as "audit recent changes", "clean up naming", or "improve
the workflow changes" let the worker reinterpret the product surface and
are likely to produce unrelated renames. Use them only when the task really
is an explicitly approved repo-wide audit.

## Overriding the profile

For a one-off override on a single invocation or signal, pass a YAML or
JSON file through `--config <file>`. The override replaces the bundle's
`defaultProfile` as a single whole object and must include every block
the workflow needs (no field-level merge): to change a single
`policies.loop` knob you still copy the full `states` section.
The file must also include `version: tychonic.config.v1`.

For a permanent change, edit the bundle source, run `npm install` in the
bundle directory if dependencies changed, and reinstall it
(`tychonic workflows install <directory>`).
