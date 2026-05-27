# pipelineWorkflow

`pipelineWorkflow` is a seven-stage example bundle. It demonstrates multiple
state NAMEs using the same activity TYPE, especially `review_1` and `review_2`
as separate `review` states.

## Purpose

Use this as a reference for a longer one-pass delivery pipeline where each
stage has an explicit NAME, failures stop later stages, and the same TYPE can
appear more than once without adding new activity kinds.

## States

| State | TYPE | Failed review returns to |
|---|---|---|
| `work` | `work` | - |
| `static` | `verify` | - |
| `unit` | `verify` | - |
| `review_1` | `review` | `work` |
| `integration` | `verify` | - |
| `review_2` | `review` | `work` |
| `security` | `verify` | - |

This example profile uses Kiro for `work`, Claude for `review_1`, Codex for
`review_2`, and pinned agent settings in `workflow.yaml`. Adapt those values
after checking the target account, model availability, plan/tier, quota,
pricing, region/country access, and organization policy.
Kiro model availability is account-, tier-, and region-scoped; absence from
the configured `openp kiro` backend means unavailable for that account, not
that the documented Kiro model id is globally invalid.

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used for facts and the isolated worker worktree. |
| `goal` | no | Worker goal threaded into this workflow's `work` prompt. |
| `promptAdditions` | no | Object keyed by state NAME. Appends extra instructions to prompts defined by this workflow for `work`, `review_1`, or `review_2`. |

Unknown fields are rejected. `promptAdditions` keys must match one of the
promptable state NAMEs listed above. `cwd` must be a git repository.

## Minimal Run

```sh
tychonic workflows install ./examples/workflows/pipelineWorkflow
tychonic runtime up
```

Then start a run:

```sh
cat > ./pipeline-input.json <<'JSON'
{
  "cwd": "/abs/path/to/project",
  "goal": "Run the full delivery pipeline and report actionable failures."
}
JSON

tychonic run pipelineWorkflow --input-file ./pipeline-input.json --wait
```

## Behavior

The pipeline runs once and short-circuits when any stage fails or blocks. It
does not wait for standard interaction approval; recovery is a fresh run with
adjusted input or config.

The shared workflow context still registers the standard interaction handlers.
Unexpected standard interaction signals are surfaced as inbox evidence instead
of being ignored.

## Config

Inspect this workflow's installed YAML-derived profile:

```sh
tychonic config show --workflow-name pipelineWorkflow --format yaml
```

`--config <file>` replaces the whole profile for one run; it is not merged with
the bundle default.
