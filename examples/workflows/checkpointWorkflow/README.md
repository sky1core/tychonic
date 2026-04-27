# checkpointWorkflow

## Overview

`checkpointWorkflow` runs deterministic gates (`lint`, `unit_test`,
`integration`) and structured reviews (`semantic_review`, `test_review`)
through a single pass that computes skip/blocked decisions inline. There
is no retry loop; the workflow finishes after one pass with the
accumulated state records.

## States declared

`checkpointWorkflow` calls these state names. The authoritative source is
`workflow.mjs`'s `defaultProfile.states`; run `tychonic config show
--workflow-name checkpointWorkflow` to see the live values.

- `lint` — `lint`
- `unit_test` — `unit_test`
- `integration` — `integration`
- `semantic_review` — `review`
- `test_review` — `review`

## Input shape

`tychonic run checkpointWorkflow --input-file <file>` passes the JSON file
straight to the workflow as its Temporal input. Recognised fields:

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository working directory the workflow records on the run record. |
| `profile` | no | Profile object (`tychonic.config.v1` shape) overriding the bundle's `defaultProfile` for this run. |
| `goal` | no | Free-text goal passed to the gate states. |

Unknown input fields are rejected at workflow start with the error
`unsupported input field: <name>`.

`cwd` must point at a git repository. This workflow collects git facts from
`cwd`; an arbitrary scratch directory will fail before the gate states run.

The bundle runs a single pass and does not expose an outer iteration budget
input field — there is no auto-continue loop to bound.

## Default profile

The bundle's `defaultProfile` declares the five state blocks listed above
plus `policies.integration`. Inspect the live values with:

```sh
tychonic config show --workflow-name checkpointWorkflow --format yaml
```

## Policies this workflow reads

`checkpointWorkflow` reads `policies.integration` (integration gate position
and mode).

## Signal handlers

This bundle's `workflow.mjs` registers no signal handlers. The pass runs
end-to-end without external signals.

## Recovery flow

The workflow does not enter `waiting_user`. A failed `lint` / `unit_test` /
`integration` / review state finishes the pass with that state recorded as
the corresponding terminal status; recovery is start a fresh run with the
input or profile adjusted.

## Overriding the profile

For a one-off override on a single invocation, pass a YAML or JSON file
through `--config <file>`. The override replaces the bundle's
`defaultProfile` as a single whole object and must include every block
the workflow needs. There is no field-level merge.

For a permanent change, edit the bundle source, run `npm install` in the
bundle directory if dependencies changed, and reinstall it
(`tychonic workflows install <directory>`).
