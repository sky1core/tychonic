# pipelineWorkflow

`pipelineWorkflow` is a seven-stage example bundle. It demonstrates multiple
state NAMEs using the same activity TYPE, especially `review_1` and `review_2`
as separate `review` states.

## States

- `work` — `work`
- `static` — `lint`
- `unit` — `unit_test`
- `review_1` — `review`
- `integration` — `integration`
- `review_2` — `review`
- `security` — `verify`

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used for facts and the isolated worker worktree. |
| `profile` | no | Whole-profile replacement for this run. |
| `goal` | no | Worker goal; used when `prompt` is omitted. |
| `prompt` | no | Worker prompt. |
| `reviewPrompt` | no | Prompt for `review_1`. |
| `reviewPrompt2` | no | Prompt for `review_2`. |

Unknown fields are rejected. `cwd` must be a git repository.

## Behavior

The pipeline runs once and short-circuits when any stage fails or blocks. It
does not register signal handlers and does not enter `waiting_user`; recovery is
a fresh run with adjusted input or config.

## Config

Inspect the installed default profile:

```sh
tychonic config show --workflow-name pipelineWorkflow --format yaml
```

`--config <file>` replaces the whole profile for one run; it is not merged with
the bundle default.
