# architectBuilderFinalQaWorkflow

`architectBuilderFinalQaWorkflow` runs architect → builder → QA with Claude
planning, Kiro building, and Codex as the final structured reviewer. Its
YAML state machine has a bounded builder/QA loop.

## Purpose

Use this when Kiro should handle the implementation middle of a staged workflow,
while the final pass/fail gate stays on Codex for structured QA output.
When QA does not pass, the workflow sends review feedback back to `builder`
until QA passes or `max_steps` is reached.

This example profile uses Claude for `architect`, Kiro for `builder`, Codex for
`qa`, and pinned agent settings in `workflow.yaml`. Adapt those values after
checking the target account, model availability, plan/tier, quota, pricing,
region/country access, and organization policy.
Kiro model availability is account-, tier-, and region-scoped; absence from
the configured `openp kiro` backend means unavailable for that account, not
that the documented Kiro model id is globally invalid.

## States

| State | TYPE | Failed review returns to | Role |
|---|---|---|---|
| `architect` | `work` | - | Produce the implementation plan. |
| `builder` | `work` | - | Kiro implements the plan in the isolated worktree. |
| `qa` | `review` | `builder` | Codex returns the structured pass/fail review verdict. |

`builder` uses `trust_all_tools: true` because the OpenP Kiro backend needs
tool trust for non-interactive implementation work. QA is a structured Codex review state; it
may run checks but must not silently repair code.

## Run Mode

Use `tychonic run architectBuilderFinalQaWorkflow --input-file <file> --wait`
when the caller should wait for the pipeline result before doing anything else.

QA failure loops back into `builder` with prior QA feedback until QA passes or
the YAML `max_steps` cap is reached.

After the run reaches a terminal `waiting_user` status, interaction signals no
longer resume it. Recovery is a fresh run with adjusted input or config.

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
tychonic workflows install ./examples/workflows/architectBuilderFinalQaWorkflow
tychonic runtime up
```

Then start a run:

```sh
cat > ./architect-builder-final-qa-input.json <<'JSON'
{
  "cwd": "/abs/path/to/project",
  "goal": "Implement the requested change with Kiro as builder and Codex as final QA."
}
JSON

tychonic run architectBuilderFinalQaWorkflow --input-file ./architect-builder-final-qa-input.json --wait
```

## Trade-Off

Kiro owns the implementation middle, so builder quality depends on Kiro. Codex
owns the final structured QA judgment; choose its model and reasoning effort
explicitly after checking the repository risk and the target operator
environment.

## Config Override

`--config <file>` replaces the bundle YAML-derived profile as one whole object. It
does not merge with the bundle default.
