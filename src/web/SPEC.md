# Web Module SPEC

This file applies to the local workflow status UI server under `src/web/`.

## Local Status UI

`tychonic web` starts a local-only operator UI for inspecting workflow status.
It is a single-user convenience surface over the same Temporal-backed status
data used by the CLI.

The server must bind to `127.0.0.1` by default. It is not a public API, team
service, webhook target, or remote deployment surface.

The UI and its JSON endpoints must read workflow state through Temporal APIs and
the existing Tychonic workflow evidence view helpers. They must not read
`.tychonic/runs` as a state database or create any repo-local state store.

The UI may expose summaries of workflows, states, inbox items, findings,
artifacts, logs, sessions, and timing. It must keep raw artifact and log content
behind the focused CLI commands already carried by the evidence view instead of
dumping raw content by default.
