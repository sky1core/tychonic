# pipelineWorkflow

`pipelineWorkflow` is a seven-stage example bundle. It demonstrates multiple
state NAMEs using the same activity TYPE, especially `review_1` and `review_2`
as separate `review` states.

## Purpose

Use this as a reference for a longer one-pass delivery pipeline where each
stage has an explicit NAME, failures stop later stages, and the same TYPE can
appear more than once without adding new activity kinds.

## States

- `work` — `work`
- `static` — `verify`
- `unit` — `verify`
- `review_1` — `review`
- `integration` — `verify`
- `review_2` — `review`
- `security` — `verify`

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used for facts and the isolated worker worktree. |
| `goal` | no | Worker goal; used when `prompt` is omitted. |
| `prompt` | no | Worker prompt. |
| `reviewPrompt` | no | Prompt for `review_1`. |
| `reviewPrompt2` | no | Prompt for `review_2`. |

Unknown fields are rejected. `cwd` must be a git repository.

## Minimal Run

```sh
tychonic workflows install ./examples/workflows/pipelineWorkflow
tychonic runtime up
```

In another terminal:

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

Inspect the installed default profile:

```sh
tychonic config show --workflow-name pipelineWorkflow --format yaml
```

`--config <file>` replaces the whole profile for one run; it is not merged with
the bundle default.
