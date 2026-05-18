# Web Module SPEC

This file applies to the local workflow status UI server under `src/web/`.

## Local Status UI

`tychonic runtime up` starts a local-only operator UI together with the runtime.
The hidden standalone `tychonic web` command starts the same server for
status-UI-only operation. In operational macOS service mode, the same web server
runs as `com.tychonic.web` and is managed with the Temporal and worker
LaunchAgents. It is a single-user convenience surface over the same
Temporal-backed status data used by the CLI.

The server must bind to `127.0.0.1` by default. It is not a public API, team
service, webhook target, or remote deployment surface.

The UI and its JSON endpoints must read workflow state through Temporal APIs and
the existing Tychonic workflow evidence view helpers. They must not read
filesystem evidence directories as a state database or create any repo-local
state store.

The UI may expose summaries of workflows, states, inbox items, findings,
artifacts, logs, sessions, and timing. For a selected state, the UI may also
show focused evidence content that answers the operator's primary question:
the prompt sent to the agent, the terminal agent response or structured review
result, and small related artifact excerpts. Large raw artifacts, full logs,
and complete run-record dumps must stay behind the focused CLI commands already
carried by the evidence view. Any truncation in the UI must be explicit.

The UI may listen to a local event stream for refresh notifications, but event
delivery is only a convenience trigger to re-read Temporal-backed status data.
It must not become a second product state channel.

The UI may also expose the installed workflow bundle's generated Mermaid graph
preview (`workflow.generated.mmd`) and a React Flow definition graph derived
from the installed `workflow.yaml` as static workflow definition metadata.
Those graphs are not workflow run state. Runtime status, progress, evidence,
and decisions still come from Temporal APIs and Tychonic's evidence view
helpers.
