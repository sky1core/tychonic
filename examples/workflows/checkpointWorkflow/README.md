# checkpointWorkflow

`checkpointWorkflow` runs deterministic gates and structured reviews in one
pass. It records each gate result and finishes; there is no retry loop.

## Purpose

Use this when the workflow should collect fixed checkpoints in one pass:
lint/unit/integration commands plus two review states, with integration placed
before review, after semantic review, or as the final gate.

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

## Minimal Run

```sh
tychonic workflows install ./examples/workflows/checkpointWorkflow
tychonic runtime up
```

In another terminal:

```sh
cat > ./checkpoint-input.json <<'JSON'
{
  "cwd": "/abs/path/to/project",
  "goal": "Run the fixed checkpoint gates and report actionable review findings."
}
JSON

tychonic run checkpointWorkflow --input-file ./checkpoint-input.json --wait
```

## Policies

The workflow reads `policies.integration.position` to decide where the
integration gate runs:

| Value | Behavior |
|---|---|
| `before_ai_review` | Run integration before reviews. |
| `after_ai_review` | Run integration after `semantic_review` and before `test_review`. |
| `final_gate` | Run integration after both reviews. |

## Recovery

This workflow does not wait for standard interaction approval. A failed gate is
recorded as the terminal result; recovery is a fresh run with adjusted input or
config.

The shared workflow context still registers the standard interaction handlers.
Unexpected standard interaction signals are surfaced as inbox evidence instead
of being ignored.

## Config Override

`--config <file>` replaces the bundle `defaultProfile` as one whole object. It
does not merge with the bundle default.
