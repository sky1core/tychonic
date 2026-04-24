# selfRepairWorkflow

`selfRepairWorkflow` runs a fixed six-state loop to detect bugs, write
regression tests, review those tests, fix the code, verify, and then
final-review. Its iteration budget defaults to `3` when
`policies.self_repair_workflow.max_iterations` is omitted.

## States declared

- `detect_bugs` — `review`
- `write_regression_tests` — `work`
- `review_regression_tests` — `review`
- `fix_bugs` — `work`
- `verify` — `verify`
- `final_review` — `review`

These names are the ones `selfRepairWorkflow`'s `requires` export declares.
They are validated against this file at install time.

## Overriding this config

To override the bundle's config for a single invocation, pass a full
replacement file through `--config <file>`. The override replaces this
`config.yaml` as a single whole object for that one invocation and must
include every block the workflow needs. There is no field-level merge.
