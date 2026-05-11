# simpleWorkflow

`simpleWorkflow` runs a work → verify → review development loop. When review
fails and the worker session is resumable, the workflow can continue that same
session until review passes or the configured loop budget is exhausted.

## Purpose

Use this as an example delegated coding loop: one worker state,
one deterministic verification gate, one structured review, and optional
same-session continuation when review finds fixable issues.

## States

- `work` — `work`
- `verify` — `verify`
- `review` — `review`

Inspect this workflow's installed `defaultProfile`:

```sh
tychonic workflows install ./examples/workflows/simpleWorkflow
tychonic config show --workflow-name simpleWorkflow --format yaml
```

This example profile sets `work` to Claude and `review` to Codex `gpt-5.5` with
`reasoning_effort: xhigh`. Its
`verify` state runs:

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

Start the runtime in one terminal:

```sh
tychonic runtime up
```

In another terminal:

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

This workflow's `defaultProfile` includes `policies.loop`. The workflow reads:

| Key | Purpose |
|---|---|
| `policies.loop.auto_continue` | Enables review-fail continuation. |
| `policies.loop.max_review_iterations` | Outer review-loop budget. |
| `states.work.resume` | Same-session resume budget for the worker state. |

Loop behavior is configured through the profile, not workflow input. If
`policies.loop.max_review_iterations` is omitted while auto-continue is enabled,
the workflow uses its internal default.

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

Ordinary state results are not rerun recovery. A failed verification command,
a parsed failing review verdict, or malformed reviewer output remains the
workflow's normal state-machine result.

The run can also end in terminal `waiting_user` when the resume budget or
review-iteration budget is exhausted with unresolved findings. Recover by
inspecting evidence and starting a fresh run with adjusted input or config:

```sh
tychonic inbox --workflow-id <id>
tychonic artifacts --workflow-id <id>
```

A closed workflow execution does not resume a terminal `waiting_user` run by
signal.

## Config Override

`--config <file>` replaces the bundle `defaultProfile` as one whole object. It
does not merge with the bundle default.
