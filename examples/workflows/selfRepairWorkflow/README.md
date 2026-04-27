# selfRepairWorkflow

## Overview

`selfRepairWorkflow` runs a fixed six-state loop to detect bugs, write
regression tests, review those tests, fix the code, verify, and then
final-review. The loop iterates until the final review passes or the
iteration budget runs out.

## States declared

`selfRepairWorkflow` calls these state names. The authoritative source is
`workflow.mjs`'s `defaultProfile.states`; run `tychonic config show
--workflow-name selfRepairWorkflow` to see the live values.

- `detect_bugs` — `review`
- `write_regression_tests` — `work`
- `review_regression_tests` — `review`
- `fix_bugs` — `work`
- `verify` — `verify`
- `final_review` — `review`

## Input shape

`tychonic run selfRepairWorkflow --input-file <file>` passes the JSON file
straight to the workflow as its Temporal input. Recognised fields:

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository working directory the workflow records on the run record. |
| `profile` | no | Profile object (`tychonic.config.v1` shape) overriding the bundle's `defaultProfile` for this run. |
| `goal` | no | Free-text goal passed to the worker states. |

Unknown input fields are rejected at workflow start with the error
`unsupported input field: <name>`.

`cwd` must point at a git repository. This workflow creates an isolated
worker worktree from `cwd`; an arbitrary scratch directory will fail before
the repair pass runs.

This workflow does not expose an outer `maxIterations` input field; its
iteration budget is `policies.self_repair_workflow.max_iterations` (default
`3`) inside `profile`.

## Default profile

The bundle's `defaultProfile` declares the six state blocks listed above
plus `policies.self_repair_workflow` (iteration budget). Inspect the live
values with:

```sh
tychonic config show --workflow-name selfRepairWorkflow --format yaml
```

## Policies this workflow reads

`selfRepairWorkflow` reads `policies.self_repair_workflow` (its iteration
budget). The bundle does not gate states through `waitForStateApproval`,
so `policies.interaction` has no effect on this workflow's loop.

## Signal handlers

This bundle's `workflow.mjs` registers no signal handlers. The loop runs
end-to-end without external signals; recovery happens at workflow-start
time (see "Recovery flow" below), not through signals into a running
workflow.

## Recovery flow

When the iteration budget runs out without a passing `final_review`, the
workflow records the unresolved findings as evidence and finishes with the
last review's status. To recover, start a fresh `selfRepairWorkflow` run
against the same project, optionally pointing the worker states at the
previous run's worktree and findings (see SKILL.md → "Carrying Work
Forward From A Failed Run"). This bundle does not register a continuation
signal of its own.

## Overriding the profile

For a one-off override on a single invocation, pass a YAML or JSON file
through `--config <file>`. The override replaces the bundle's
`defaultProfile` as a single whole object and must include every block the
workflow needs. There is no field-level merge.

For a permanent change, edit the bundle source, run `npm install` in the
bundle directory if dependencies changed, and reinstall it
(`tychonic workflows install <directory>`).
