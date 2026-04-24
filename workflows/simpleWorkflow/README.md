# simpleWorkflow

`simpleWorkflow` is the default work/verify/review loop. Each iteration runs
the `work` state, then the deterministic `verify` state, then the structured
`review` state. On a `fail` verdict the loop resumes the same worker session
(when the agent CLI exposes one) and continues until review passes or the
configured `policies.loop.max_review_iterations` budget runs out.

## States declared

- `work` — `work`
- `verify` — `verify`
- `review` — `review`

These names are the ones `simpleWorkflow`'s `requires` export declares. They
are validated against this file at install time; changing a NAME here without
also changing the workflow source is rejected.

## Overriding this config

To override the bundle's config for a single invocation, pass a full
replacement file through `--config <file>`. The override replaces this
`config.yaml` as a single whole object for that one invocation and must
include every block the workflow needs. There is no field-level merge.
