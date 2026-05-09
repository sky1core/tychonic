# Review Module SPEC

This file applies to structured review parsing, normalization, and schema code
under `src/review/`.

## Structured Reviewer Contract

Structured review output has two layers:

- the **semantic review payload** the reviewer decides: `status`, `summary`, and
  `findings`
- the normalized **Tychonic wire result** the host records:
  `schema_version: "tychonic.review.v1"` plus that semantic payload

Built-in adapters must not make the model responsible for Tychonic bookkeeping
fields such as `schema_version`. The adapter may ask the model for the semantic
payload and then normalize it into the `tychonic.review.v1` wire result before
host validation. An escape-hatch `command` reviewer has no adapter-owned
normalization layer, so its stdout must emit the full `tychonic.review.v1` wire
result directly.

Review parsing has one terminal source per adapter path. It must not choose
among arbitrary JSON objects in stdout.

- Escape-hatch `command` reviewers: stdout must be exactly one complete
  `tychonic.review.v1` wire result.
- Codex built-in reviewer: the terminal source is the final block appended by
  the adapter through `--output-last-message` after the JSONL stream. JSON
  objects inside JSONL `agent_message` events are evidence only and must never
  be accepted as the review verdict.
- Claude built-in reviewer: the terminal source is the stream-json
  `type: "result"` event. `structured_output` is preferred when present;
  otherwise the `result` string is parsed. Assistant message text is evidence
  only and must never be accepted as the review verdict.

If the terminal source exists but does not validate, reviewer output is
malformed. The parser must not fall back to an earlier JSON object.

The semantic payload required fields are `status`, `summary`, and `findings`.
Finding objects must include `severity`, `title`, and `detail`. A finding may
also include `target` when the reviewer can identify a file, state, session, or
other concrete subject. It may include `target_session_id` only when it can
identify a recorded worker session.

Rules:

- `status` is `pass` or `fail`
- `pass` requires an empty `findings` list
- `fail` requires at least one actionable finding
- finding severity is `critical`, `high`, `medium`, or `low`
- malformed reviewer output is not a pass and must create evidence for triage

The model is not responsible for workflow control, resume decisions, internal
ids, schema versioning, or artifact bookkeeping. Those belong to the workflow,
adapter, and host layers. Workflows decide on their own whether to gate, retry,
or branch on a `pass`/`fail` verdict.
