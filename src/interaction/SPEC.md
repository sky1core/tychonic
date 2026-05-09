# Interaction Module SPEC

This file applies to interaction signal payload validation under
`src/interaction/`.

## Payload Contract

Interaction payload validators implement the standard signal payload shapes
documented in `src/cli/SPEC.md`.

Validators must reject malformed raw Temporal signal payloads before they can
drive a workflow gate. Malformed payloads are stray input, not partial
instructions to infer from.

`StateRecordPatch` is an overlay on the latest state record for a NAME. It is
not a replacement for the whole run, and it must contain at least one meaningful
field.

`RerunStatePayload` carries `{ state: string, reason?: string }`. `state` is a
non-empty state NAME. `reason`, when present, is a non-empty operator note. The
payload requests that workflow code rerun the named state; it does not mutate
the run record by itself.
