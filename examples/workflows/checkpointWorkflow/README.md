# checkpointWorkflow

`checkpointWorkflow` runs deterministic gates and structured reviews in one
pass. It records each gate result and finishes; there is no retry loop.

## Purpose

Use this when the workflow should collect fixed checkpoints in one pass:
lint/unit commands, two review states, and integration as the final gate.

## States

| State | TYPE | Failed review returns to |
|---|---|---|
| `lint` | `verify` | - |
| `unit_test` | `verify` | - |
| `integration` | `verify` | - |
| `semantic_review` | `review` | `integration` |
| `test_review` | `review` | `integration` |

This workflow is one-pass, so it does not auto-retry failed reviews. The review
states still declare `on_fail_return_to` because the review-state contract
requires an explicit failure destination in the effective profile.

This example profile uses Claude and Codex review states with pinned agent
settings in `workflow.yaml`. Adapt those values after checking the target
account, model availability, plan/tier, quota, pricing, region/country access,
and organization policy.
This bundle has no Kiro state.

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

Then start a run:

```sh
cat > ./checkpoint-input.json <<'JSON'
{
  "cwd": "/abs/path/to/project",
  "goal": "Run the fixed checkpoint gates and report actionable review findings."
}
JSON

tychonic run checkpointWorkflow --input-file ./checkpoint-input.json --wait
```

## Recovery

This workflow does not wait for standard interaction approval. A failed gate is
recorded as the terminal result; recovery is a fresh run with adjusted input or
config.

The shared workflow context still registers the standard interaction handlers.
Unexpected standard interaction signals are surfaced as inbox evidence instead
of being ignored.

## Config Override

`--config <file>` replaces the bundle YAML-derived profile as one whole object. It
does not merge with the bundle default.
