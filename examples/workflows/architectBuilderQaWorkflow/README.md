# architectBuilderQaWorkflow

## Overview

Three-stage delegated-work pipeline that an **external agent** (Claude
Code, Codex, or similar) drives end-to-end via Tychonic's interactive
signals.

```
architect (work)  →  builder (work)  →  qa (review)
```

Each stage runs one activity then pauses. The external agent inspects
the artifacts of that stage and sends one of the host-defined interactive
signals (`approve` / `reject` / `modify`) to advance, retry, or overlay a
patch.

This plugin is self-contained: it imports only `@temporalio/workflow` and
uses Tychonic's public signal-name protocol
(`tychonic.interaction.approve_state` etc.) directly.

## States declared

`architectBuilderQaWorkflow` calls these state names. The authoritative
source is `workflow.mjs`'s `defaultProfile.states`; run `tychonic config
show --workflow-name architectBuilderQaWorkflow` to see the live values.

- `architect` — `work`
- `builder` — `work`
- `qa` — `review`

## Input shape

`tychonic run architectBuilderQaWorkflow --input-file <file>` passes the
JSON file straight to the workflow as its Temporal input. Recognised
fields:

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository working directory the workflow records on the run record. |
| `profile` | no | Profile object (`tychonic.config.v1` shape) overriding the bundle's `defaultProfile` for this run. |
| `goal` | no | Free-text goal threaded into the architect / builder prompts. |
| `architectPrompt` | no | Override the architect stage's prompt. |
| `builderPrompt` | no | Override the builder stage's prompt. |
| `qaPrompt` | no | Override the qa stage's prompt. |

Unknown input fields are rejected at workflow start with the error
`unsupported input field: <name>`.

`cwd` must point at a git repository. This workflow creates an isolated
worker worktree from `cwd`; an arbitrary scratch directory will fail before
the staged agent flow runs.

Minimal input:

```json
{
  "cwd": "/abs/path/to/your/project",
  "goal": "What needs to be designed, built, and reviewed"
}
```

## Default profile

The bundle's `defaultProfile` declares the three state blocks listed above
plus `policies.interaction` (interactive mode). Auto mode can also read an
optional `policies.loop.max_review_iterations` value from a one-off
override; when omitted it uses the workflow default (`3`). Inspect the live
values with:

```sh
tychonic config show --workflow-name architectBuilderQaWorkflow --format yaml
```

## Signal handlers

In **interactive mode** (`policies.interaction.mode: "interactive"`), each
stage gates through `waitForStateApproval`. The bundle accepts the three
host-defined interactive signals on the parked state — send them through
the dedicated CLI verbs:

| CLI verb | Signal name | Behavior |
|---|---|---|
| `tychonic approve <wf-id>` | `tychonic.interaction.approve_state` | Advance to the next stage. |
| `tychonic reject <wf-id> --feedback "..."` | `tychonic.interaction.reject_state` | Rerun the parked stage with the feedback threaded into the next prompt. Successive rejects accumulate as a numbered list. |
| `tychonic modify <wf-id> [--status ... --reason ... --note ... --patch-file <path>]` | `tychonic.interaction.modify_state` | Patch the latest state record and advance. `--note "..."` alone is the simplest pass-with-annotation override; `--patch-file <path>.json` accepts a full patch with artifacts and findings. |

`policies.interaction.max_reject_iterations` (default 5) caps reject
rerun attempts per stage. At the cap the run enters `waiting_user` with an
inbox item; `approve` or `modify` on the parked state still applies.

## Auto mode

Flip `policies.interaction.mode: auto` (or remove the `interaction` block)
in the bundle's `defaultProfile` — or pass an override profile through
`--config <file>` — to run the three stages straight through without
external gates. Useful for dry-run tests of the activity wiring and for
heterogeneous-agent smoke runs (architect=claude, builder=codex,
qa=claude).

**Auto-mode review loop**: in auto mode, `architect` runs once and the
`builder ↔ qa` pair runs in a loop. When qa reports `fail` (state.status =
`failed`), the workflow loops back to builder with the qa reason threaded
into the next prompt as numbered findings. The loop is capped by
`policies.loop.max_review_iterations` (default 3). At the cap the run
transitions to `waiting_user` with an inbox item (`inbox_review_cap`) in
the completed run result; the operator can inspect the recorded states
and start a follow-up run with adjusted input/config.

Interactive mode behaves independently: each stage's own reject signal
reruns that stage (reject feedback accumulates as a numbered list), and
qa approve exits immediately without re-running builder. The two loop
mechanisms do not overlap — interactive mode breaks out of the outer
review loop after a single builder+qa round and defers all rerun
decisions to the external gating agent.

## Recovery flow

When the auto-mode review loop exhausts `max_review_iterations` or the
interactive `max_reject_iterations` cap fires, the run transitions to
`waiting_user` with an inbox item describing the unresolved stage. Recover
by either:

- Sending `tychonic approve <wf-id>` or `tychonic modify <wf-id>` against
  the parked state to accept or overlay the outcome.
- Cancelling the run and starting a fresh `architectBuilderQaWorkflow`
  invocation with adjusted input.

## Install / remove

```sh
# operational (replaces the launchd worker in one step):
cd examples/workflows/architectBuilderQaWorkflow
npm install
cd -
tychonic workflows install ./examples/workflows/architectBuilderQaWorkflow

# isolated dev instance (does not touch launchd; restart runtime to pick
# up the new bundle):
tychonic workflows install ./examples/workflows/architectBuilderQaWorkflow \
  --instance <name>

tychonic workflows remove architectBuilderQaWorkflow --instance <name>
```

## Key references

- `SPEC.md` — Workflow Model, Workflow Loop Semantics → Interactive mode
- `docs/plugin-workflows.md` — authoring contract for plugin workflows
- `skills/tychonic-cli/workflow-module-contract.md` — bundle authoring rules
