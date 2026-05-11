# CLI Module SPEC

This file applies to the public CLI surface under `src/cli/`.

## Run And Wait Modes

`tychonic run <workflow-name>` starts the workflow and returns immediately by
default. This is the fire-and-forget mode for callers that want to launch work
and continue with other tasks.

`tychonic run <workflow-name> --wait` starts the workflow and then waits until
the workflow needs caller action or returns a result. `tychonic wait
<workflow-id>` attaches the same wait behavior to a workflow that was already
started.

This wait condition is product-level, not a request to inspect Temporal UI. The
CLI returns when any of these is true:

- the workflow exposes a pending interactive state through the standard
  `tychonic.interaction.pending_state` query
- the workflow exposes a run result whose `status` is one of `waiting_user`,
  `blocked`, `failed`, `succeeded`, or `cancelled`
- the underlying workflow execution has closed without a usable Tychonic result

The JSON response uses `message` as the primary outcome. The message is a
plain-language sentence that a human or LLM caller can report or act on
directly.

Supporting fields are optional and exist for automation or follow-up commands:

- `state` is present when an interactive state is waiting
- `status` is present when a Tychonic run status exists
- `resultError` carries the error when the workflow closed without a usable
  Tychonic result

The wait payload does not include the full raw run result. The caller uses
`tychonic status --workflow-id <id>` and focused evidence commands for run
details. The CLI does not expose a second wait mode or a caller-selected wait
condition.

`tychonic status --workflow-id <id>` is the ordinary evidence view for a
workflow. Its default output includes workflow metadata, evidence counts,
focused read commands, inbox/artifact/log/session/finding summaries, and a
timing summary computed from the run timestamps and activity attempt timestamps.
It must not dump the full raw run record by default, because raw adapter
commands and large result payloads make the operator surface harder to read.
Focused commands such as `tychonic artifacts --artifact <id>` and
`tychonic logs --attempt <id>` print raw content only when the caller asks for
that specific evidence item.

## Interaction Signal Contract

Tychonic CLI exposes four convenience commands for workflows that choose to use
the standard interaction signal/query names:

- `tychonic approve <workflow-id> [--state <name>]`
- `tychonic reject <workflow-id> [--state <name>] --feedback <text>`
- `tychonic modify <workflow-id> [--state <name>] [--status <status>]
  [--reason <text>] [--note <text>] [--patch-file <path.json>]`
- `tychonic rerun <workflow-id> [--state <name>] [--reason <text>]`

The signal/query names and payload shapes are host public surface because the
CLI sends them:

| CLI action | Temporal signal/query | Payload |
| --- | --- | --- |
| approve | `tychonic.interaction.approve_state` | `{ state: string }` |
| reject | `tychonic.interaction.reject_state` | `{ state: string, feedback: string }` |
| modify | `tychonic.interaction.modify_state` | `{ state: string, patch: StateRecordPatch }` |
| rerun | `tychonic.interaction.rerun_state` | `{ state: string, reason?: string }` |
| pending-state query | `tychonic.interaction.pending_state` | returns `string | undefined` |

`state` is always a non-empty state NAME. `reject.feedback` is a non-empty
string. `rerun.reason`, when present, is a non-empty string.

`StateRecordPatch` is an object with at least one meaningful field:

- `status`: one of `succeeded`, `failed`, `skipped`, `blocked`, `timed_out`
- `reason`: non-empty string
- `note`: non-empty string
- `artifacts`: non-empty `ArtifactRecord[]`
- `findings`: non-empty `FindingRecord[]`

The CLI validates this payload before signaling. The standard interaction helper
revalidates these payloads inside the workflow and treats malformed raw Temporal
signals as stray input instead of letting them drive the gate. Custom signals
are workflow-owned and must validate their own raw Temporal payloads.

When `--state` is omitted, the CLI queries
`tychonic.interaction.pending_state`. If the workflow has not registered that
query, the query fails, or it returns no state, the CLI must fail with a clear
message and ask the operator to pass `--state` explicitly.

Using these signal names is optional. A workflow that does not create the
standard interaction helper is not interactive from the point of view of
`tychonic approve`, `tychonic reject`, `tychonic modify`, and `tychonic rerun`.

`createTychonicInteraction(policy)` from `tychonic/workflow` registers the
standard signal/query handlers as one unit and exposes the workflow-side gate
for waiting on state approval, applying modify patches, draining stray signals,
handling explicit state rerun requests, creating standard inbox items, and
validating the `policies.interaction` shape that the helper consumes. Workflow
code must not hand-register these standard names one by one.

The standard helper owns only the generic interaction mode and reject-cap shape:
`policies.interaction.mode` and `policies.interaction.max_reject_iterations`.
How interaction composes with a workflow's own retry loops, auto continuation,
or terminal recovery path remains workflow-specific and must be documented by
the workflow bundle that implements it.
