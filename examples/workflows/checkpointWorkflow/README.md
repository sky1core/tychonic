# checkpointWorkflow

`checkpointWorkflow` runs deterministic gates and structured reviews in one
pass. It records each gate result and finishes; there is no retry loop.

## States

- `lint` — `verify`
- `unit_test` — `verify`
- `integration` — `verify`
- `semantic_review` — `review`
- `test_review` — `review`

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used for facts and gate execution. |
| `goal` | no | Free-text goal for the gate prompts. |

Unknown fields are rejected. `cwd` must be a git repository.

## Policies

The workflow reads `policies.integration` for integration gate mode and
position.

## Recovery

This workflow does not register signal handlers and does not enter
`waiting_user`. A failed gate is recorded as the terminal result; recovery is a
fresh run with adjusted input or config.

## Config Override

`--config <file>` replaces the bundle `defaultProfile` as one whole object. It
does not merge with the bundle default.
