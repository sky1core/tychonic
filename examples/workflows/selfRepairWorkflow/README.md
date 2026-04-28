# selfRepairWorkflow

`selfRepairWorkflow` iterates through bug detection, regression-test writing,
test review, bug fixing, verification, and final review until final review
passes or the iteration budget is exhausted.

## States

- `detect_bugs` — `review`
- `write_regression_tests` — `work`
- `review_regression_tests` — `review`
- `fix_bugs` — `work`
- `verify` — `verify`
- `final_review` — `review`

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used to create the isolated worker worktree. |
| `profile` | no | Whole-profile replacement for this run. |
| `goal` | no | Free-text goal threaded into worker prompts. |

Unknown fields are rejected. `cwd` must be a git repository.

## Policies

The workflow reads `policies.self_repair_workflow.max_iterations`. If omitted,
it uses the workflow default.

## Recovery

The workflow does not register signal handlers. If the iteration budget is
exhausted before final review passes, inspect the artifacts and start a fresh
run with adjusted input or config.
