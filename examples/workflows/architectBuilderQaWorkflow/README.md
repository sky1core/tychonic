# architectBuilderQaWorkflow

`architectBuilderQaWorkflow` runs an architect → builder → QA pipeline.

## Purpose

Use this as an example staged delegation pipeline: one agent plans,
another agent builds, and QA reviews. The YAML state machine loops failed QA
verdicts back to `builder` until QA passes or `max_steps` is exhausted.

This example profile sets `architect` to Claude `claude-opus-4-7` with
`reasoning_effort: max`, `builder` to Kiro `claude-opus-4.6`, and `qa` to
Codex `gpt-5.5` with `reasoning_effort: xhigh`.
These values are examples; adapt them after checking the target account,
model availability, plan/tier, quota, pricing, region/country access, and
organization policy.
Kiro model availability is account-, tier-, and region-scoped; absence from
`kiro-cli chat --list-models` means unavailable for that account, not that the
documented Kiro model id is globally invalid.

## States

| State | TYPE | Failed review returns to | Role |
|---|---|---|---|
| `architect` | `work` | - | Produce the implementation plan. |
| `builder` | `work` | - | Kiro implements the plan in the isolated worktree. |
| `qa` | `review` | `builder` | Codex returns the structured pass/fail review verdict. |

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used to create the isolated worker worktree. |
| `goal` | no | Goal threaded into architect and builder prompts. |
| `promptAdditions` | no | Object keyed by state NAME. Appends extra instructions to prompts defined by this workflow for `architect`, `builder`, or `qa`. |

Unknown fields are rejected. `promptAdditions` keys must match one of the
promptable state NAMEs listed above; agent names are not valid prompt keys.
`cwd` must be a git repository.

## Minimal Run

```sh
tychonic workflows install ./examples/workflows/architectBuilderQaWorkflow
tychonic runtime up
```

In another terminal:

```sh
cat > ./architect-builder-qa-input.json <<'JSON'
{
  "cwd": "/abs/path/to/project",
  "goal": "Implement the requested change and leave evidence in artifacts."
}
JSON

tychonic run architectBuilderQaWorkflow --input-file ./architect-builder-qa-input.json --wait
```

## Run Mode

Use `tychonic run architectBuilderQaWorkflow --input-file <file> --wait` when
the caller should wait for the pipeline result before doing anything else.

Omit `--wait` when the caller should start the pipeline and continue with other
work. The no-wait response returns a `workflowId`; pass that value to
`tychonic wait <workflow-id>` when you need the next result or action point.

`--wait` returns when the workflow succeeds, fails, is cancelled, or needs
attention.

## Interactive Signals

Interactive mode uses the standard Tychonic interaction commands while the
workflow is parked at a stage:

```sh
tychonic approve <workflow-id> --state <state>
tychonic reject <workflow-id> --state <state> --feedback "..."
tychonic modify <workflow-id> --state <state> --note "..."
tychonic rerun <workflow-id> --state <state> --reason "..."
```

Use `rerun` to retry the same state without adding new feedback. Use `reject`
when the next attempt should receive explicit feedback.

After the run reaches a terminal `waiting_user` status, those signals no longer
resume it. Recovery is a fresh run with adjusted input or config.

## Config Override

`--config <file>` replaces the bundle YAML-derived profile as one whole object. It
does not merge with the bundle default.
