# simpleWorkflow

`simpleWorkflow` runs a work → verify → review development loop. When review
fails and the worker session is resumable, the workflow can continue that same
session until review passes or the configured loop budget is exhausted.

## Purpose

Use this as the reference for a normal delegated coding loop: one worker state,
one deterministic verification gate, one structured review, and optional
same-session continuation when review finds fixable issues.

## States

- `work` — `work`
- `verify` — `verify`
- `review` — `review`

Inspect the installed profile:

```sh
tychonic workflows install ./examples/workflows/simpleWorkflow
tychonic config show --workflow-name simpleWorkflow --format yaml
```

The bundled default profile uses Claude for `work` and `review`. Its `verify`
state runs:

```sh
npm run typecheck
npm run build
npm test
```

Pass a whole-profile `--config <file>` replacement when the target repository
uses a different verification command.

## Input

`tychonic run simpleWorkflow --input-file <file>` passes the JSON file directly
to the workflow.

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used to create the isolated worker worktree. |
| `goal` | no | Prompt text for the worker. |

Unknown fields are rejected. `cwd` must be a git repository.

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

The bundle default profile includes `policies.loop`. The workflow reads:

| Key | Purpose |
|---|---|
| `policies.loop.auto_continue` | Enables review-fail continuation. |
| `policies.loop.max_review_iterations` | Outer review-loop budget. |
| `states.work.resume` | Same-session resume budget for the worker state. |

Loop behavior is configured through the profile, not workflow input. If
`policies.loop.max_review_iterations` is omitted while auto-continue is enabled,
the workflow uses its internal default.

## Recovery

The run can end in `waiting_user` when the resume budget or review-iteration
budget is exhausted with unresolved findings. Recover by inspecting evidence
and starting a fresh run with adjusted input or config:

```sh
tychonic inbox --workflow-id <id>
tychonic artifacts --workflow-id <id>
```

The workflow does not resume a terminal `waiting_user` run by signal.

## Config Override

`--config <file>` replaces the bundle `defaultProfile` as one whole object. It
does not merge with the bundle default.
