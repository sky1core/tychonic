# Domain Module SPEC

This file applies to product records, deltas, and inbox/domain helpers under
`src/domain/`.

## Product Records

The product run id is `WorkflowRunRecord.id`. Temporal workflow ids and Temporal
run ids are SDK identifiers; they are not the surfaced Tychonic run id used for
artifact paths, inbox references, or user-facing run records.

`WorkflowRunRecord`, `WorkflowStateRecord`, `ActivityAttemptRecord`,
`ArtifactRecord`, `FindingRecord`, `DecisionInboxItemRecord`, and
`AgentSessionRecord` are product record shapes. They describe state that is
backed by Temporal workflow history. They are not a local persistence layer.

State status values are drawn from:

```text
pending | running | succeeded | failed | skipped | blocked | timed_out
```

Workflow run status values and inbox/finding records must be updated by workflow
code through explicit deltas or workflow-owned record updates. Domain helpers
must not create a second source of truth outside the workflow run record.

`profile.states.<name>` keys are unique in the effective config, but
`run.states[]` may contain multiple records with the same `name` across
iterations or explicit state reruns. Those records are ordered evidence, not
competing definitions of the state config.

## Deltas

`WorkflowRunDelta` is the handoff shape for activity-produced record changes.
An activity returns a delta; workflow code applies it to its current run copy.

Domain merge helpers must preserve immutability: they return a new record and do
not mutate the caller's input record or arrays in place.

Delta application is append/update bookkeeping. It must not decide workflow
ordering, retry, review loop continuation, candidate rotation, or any other
control-flow concern.
