# architectBuilderQaWorkflow

`architectBuilderQaWorkflow` runs an architect → builder → QA pipeline. It can
run with interactive gates or straight through in auto mode, depending on
`policies.interaction`.

## Purpose

Use this as the default reference for staged delegation: one agent plans,
another agent builds, and QA reviews. The bundled default runs in auto mode
with a bounded builder/QA loop. Switch `policies.interaction.mode` to
`interactive` when an operator should approve each stage.

The default profile uses Claude `claude-opus-4-7` with `reasoning_effort: max`
for architecture, Kiro `claude-opus-4.6` for building, and Codex `gpt-5.5` with
`reasoning_effort: xhigh` for final QA.

## States

| State | TYPE | Role |
|---|---|---|
| `architect` | `work` | Produce the implementation plan. |
| `builder` | `work` | Kiro implements the plan in the isolated worktree. |
| `qa` | `review` | Codex returns the structured pass/fail review verdict. |

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used to create the isolated worker worktree. |
| `goal` | no | Goal threaded into architect and builder prompts. |
| `promptAdditions` | no | Object keyed by state NAME. Appends extra instructions to built-in prompts for `architect`, `builder`, or `qa`. |

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

In `auto` interaction mode, `--wait` returns when the workflow succeeds, fails,
is cancelled, or needs attention. In `interactive` mode, it may return with a
message naming the waiting stage; follow that message and use the standard
interaction command for that stage.

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
tychonic approve <workflow-id> --state <state>
tychonic reject <workflow-id> --state <state> --feedback "..."
tychonic modify <workflow-id> --state <state> --note "..."
```

After the run reaches a terminal `waiting_user` status, those signals no longer
resume it. Recovery is a fresh run with adjusted input or config.

## Config Override

`--config <file>` replaces the bundle `defaultProfile` as one whole object. It
does not merge with the bundle default.
