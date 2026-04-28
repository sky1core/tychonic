# architectBuilderQaWorkflow

`architectBuilderQaWorkflow` runs an architect → builder → QA pipeline. It can
run with interactive gates or straight through in auto mode, depending on
`policies.interaction`.

## Purpose

Use this as the default reference for staged delegation: one agent plans,
another agent builds, and QA reviews. The bundled default runs in auto mode
with a bounded builder/QA loop. Switch `policies.interaction.mode` to
`interactive` when an operator should approve each stage.

## States

| State | TYPE | Role |
|---|---|---|
| `architect` | `work` | Produce the implementation plan. |
| `builder` | `work` | Implement the plan in the isolated worktree. |
| `qa` | `review` | Return the structured pass/fail review verdict. |

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used to create the isolated worker worktree. |
| `goal` | no | Goal threaded into architect and builder prompts. |
| `architectPrompt` | no | Prompt override for `architect`. |
| `builderPrompt` | no | Prompt override for `builder`. |
| `qaPrompt` | no | Prompt override for `qa`. |

Unknown fields are rejected. `cwd` must be a git repository.

## Policies

The workflow reads:

| Key | Purpose |
|---|---|
| `policies.interaction.mode` | `auto` runs without external gates; `interactive` gates each stage. |
| `policies.interaction.max_reject_iterations` | Reject retry cap per interactive stage. Omit it in auto mode. |
| `policies.loop.max_review_iterations` | Auto-mode builder/QA review-loop cap. |

## Interactive Signals

Interactive mode uses the standard Tychonic interaction commands while the
workflow is parked at a stage:

```sh
tychonic approve <workflow-id>
tychonic reject <workflow-id> --feedback "..."
tychonic modify <workflow-id> --note "..."
```

After the run reaches a terminal `waiting_user` status, those signals no longer
resume it. Recovery is a fresh run with adjusted input or config.

## Config Override

`--config <file>` replaces the bundle `defaultProfile` as one whole object. It
does not merge with the bundle default.
