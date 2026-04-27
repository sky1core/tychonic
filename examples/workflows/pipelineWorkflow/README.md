# pipelineWorkflow

## Overview

A 7-stage operator-supplied workflow bundle that demonstrates installing a
custom workflow through `tychonic workflows install`. The workflow uses two
states of the `review` TYPE (`review_1` and `review_2`) so it doubles as a
reference for the NAME/TYPE contract in SPEC §State Identity And Activity
TYPE. The pipeline runs once end-to-end and short-circuits to a terminal
status as soon as any stage fails.

## States declared

`pipelineWorkflow` calls these state names. The authoritative source is
`workflow.mjs`'s `defaultProfile.states`; run `tychonic config show
--workflow-name pipelineWorkflow` to see the live values.

- `work` — `work`
- `static` — `lint`
- `unit` — `unit_test`
- `review_1` — `review`
- `integration` — `integration`
- `review_2` — `review`
- `security` — `verify`

## Input shape

`tychonic run pipelineWorkflow --input-file <file>` passes the JSON file
straight to the workflow as its Temporal input. Recognised fields:

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository working directory the workflow records on the run record. |
| `profile` | no | Profile object (`tychonic.config.v1` shape) overriding the bundle's `defaultProfile` for this run. |
| `goal` | no | Free-text goal forwarded to the worker stage. |
| `prompt` | no | Prompt passed to the worker stage; defaults to `goal` when omitted. |
| `reviewPrompt` | no | Prompt passed to the `review_1` stage. |
| `reviewPrompt2` | no | Prompt passed to the `review_2` stage. |

Unknown fields are rejected with `unsupported input field: <name>`.

`cwd` must point at a git repository. This workflow snapshots git facts and
creates an isolated worker worktree from `cwd`; an arbitrary scratch
directory will fail before the pipeline stages run.

## Default profile

The bundle's `defaultProfile` declares all seven state blocks listed above
and an empty `policies` object. Inspect the live values with:

```sh
tychonic config show --workflow-name pipelineWorkflow --format yaml
```

## Signal handlers

This bundle's `workflow.mjs` registers no signal handlers. The pipeline
runs end-to-end without external signals.

## Recovery flow

The workflow does not enter `waiting_user`. A failed stage finishes the
pipeline with the failing state's terminal status recorded; recovery is
start a fresh run with adjusted input or profile.

## Install / remove

```sh
cd examples/workflows/pipelineWorkflow
npm install
cd -
tychonic workflows install ./examples/workflows/pipelineWorkflow
tychonic workflows remove  pipelineWorkflow
```

The install command also replaces the local LaunchAgent worker when the
service is installed.

## Overriding the profile

For a one-off override on a single invocation, pass a YAML or JSON file
through `--config <file>`. The override replaces the bundle's
`defaultProfile` as a single whole object and must include every block the
workflow needs. There is no field-level merge.

For a permanent change, edit the bundle source, run `npm install` in this
bundle directory if dependencies changed, and reinstall it
(`tychonic workflows install ./examples/workflows/pipelineWorkflow`).
