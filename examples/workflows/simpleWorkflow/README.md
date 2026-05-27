# simpleWorkflow

`simpleWorkflow` runs a work → verify → review development loop. When `verify`
or `review` fails, the generated YAML wrapper returns to `work` until the loop
passes or `max_steps` is exhausted.

## Purpose

Use this as an example delegated coding loop: one worker state,
one deterministic verification gate, and one structured review.

## States

| State | TYPE | Failure path |
|---|---|---|
| `work` | `work` | finish as `work failed` |
| `verify` | `verify` | `work` |
| `review` | `review` | `work` |

Inspect this workflow's installed YAML-derived profile:

```sh
tychonic workflows install ./examples/workflows/simpleWorkflow
tychonic config show --workflow-name simpleWorkflow --format yaml
```

This example profile uses Claude for `work`, Codex for `review`, and pinned
agent settings in `workflow.yaml`. Its `verify` state runs:

```sh
npm run typecheck
npm run build
npm test
```

The agent settings above are examples; adapt them after checking
the target account, model availability, plan/tier, quota, pricing,
region/country access, and organization policy.
This workflow has no Kiro state.

Pass a whole-profile `--config <file>` replacement when the target repository
uses a different verification command.

## Input

`tychonic run simpleWorkflow --input-file <file>` passes the JSON file directly
to the workflow.

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used to create the isolated worker worktree. |
| `goal` | no | Worker goal threaded into this workflow's `work` prompt. |
| `promptAdditions` | no | Object keyed by state NAME. Appends extra instructions to prompts for `work` or `review`. |

Unknown fields are rejected. `promptAdditions` keys must be `work` or `review`.
`cwd` must be a git repository.

## Minimal Run

Start or reuse the runtime daemon:

```sh
tychonic runtime up
```

Then start a run:

```sh
cat > ./simple-input.json <<'JSON'
{
  "cwd": "/abs/path/to/project",
  "goal": "Implement the requested change and leave evidence in artifacts."
}
JSON

tychonic run simpleWorkflow --input-file ./simple-input.json --wait
```

## Loop Policy

The loop is declared in `workflow.yaml`: `verify.on_fail.goto` and
`review.on_fail.goto` both return to `work`, and `max_steps` is the stop
condition. `states.work.resume` is an agent-session resume budget for the
worker state.

## Recovery

While the Temporal workflow execution is still open, `work`, `verify`, and
`review` can also enter `waiting_user` if the activity itself throws before it
returns a Tychonic state result. This path is for external/transient failures
such as an unavailable agent CLI, provider/network interruption, or process
timeout before the activity can return its normal output. After fixing the
external issue, rerun the same state:

```sh
tychonic status --workflow-id <id>
tychonic rerun <id> --state <work|verify|review> --reason "<what changed>"
```

Ordinary state results are not rerun recovery. A failed verification command or
a parsed failing review verdict returns to `work` through the declared loop. A
malformed reviewer output remains the workflow's normal state-machine result.

The run can also end in terminal `waiting_user` when `max_steps` is exhausted
with unresolved verification failures or review findings. Recover by inspecting
evidence and starting a fresh run with adjusted input or config:

```sh
tychonic inbox --workflow-id <id>
tychonic artifacts --workflow-id <id>
```

A closed workflow execution does not resume a terminal `waiting_user` run by
signal.

## Config Override

`--config <file>` replaces the bundle YAML-derived profile as one whole object. It
does not merge with the bundle default.
