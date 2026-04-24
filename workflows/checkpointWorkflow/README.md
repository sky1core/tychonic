# checkpointWorkflow

`checkpointWorkflow` runs deterministic gates (`lint`, `unit_test`,
`integration`) and structured reviews (`semantic_review`, `test_review`)
through a single pass that computes skip/blocked decisions inline.

## States declared

- `lint` — `lint`
- `unit_test` — `unit_test`
- `integration` — `integration`
- `semantic_review` — `review`
- `test_review` — `review`

These names are the ones `checkpointWorkflow`'s `requires` export declares.
They are validated against this file at install time.

## Overriding this config

To override the bundle's config for a single invocation, pass a full
replacement file through `--config <file>`. The override replaces this
`config.yaml` as a single whole object for that one invocation and must
include every block the workflow needs. There is no field-level merge.
