# architectBuilderQaWorkflow

Three-stage delegated-work pipeline that an **external agent** (Claude
Code, Codex, or similar) drives end-to-end via Tychonic's interactive
signals.

```
architect (work)  →  builder (work)  →  qa (review)
```

Each stage runs one activity then pauses. The external agent inspects
the artifacts of that stage and sends one of:

- `tychonic approve <wf-id>`                             — advance
- `tychonic reject  <wf-id> --feedback "..."`             — rerun this
  stage with the feedback threaded into the next prompt (feedback from
  successive rejects accumulates as a numbered list into the next
  attempt's prompt)
- `tychonic modify  <wf-id> [--status ... --reason ... --note ...]`
  — overlay a `StateRecordPatch` on the latest state record and advance.
  `--note "..."` alone is the simplest pass-with-annotation override;
  `--patch-file <path>.json` accepts a full patch with artifacts and
  findings

`policies.interaction.max_reject_iterations` (default 5) caps reject
rerun attempts per stage. At the cap the run enters `waiting_user`
with an inbox item; approve or modify on the parked state still
applies.

This plugin is self-contained: it imports only `@temporalio/workflow`
and uses Tychonic's public signal-name protocol
(`tychonic.interaction.approve_state` etc.) directly. There is no
dependency on any Tychonic internal module path.

## Install

From the project that will host the run:

```sh
# operational (replaces the launchd worker in one step):
tychonic workflows install ./examples/workflows/architectBuilderQaWorkflow

# isolated dev instance (does not touch launchd; restart runtime to pick
# up the new bundle):
tychonic workflows install ./examples/workflows/architectBuilderQaWorkflow \
  --instance <name>
```

## Start a run

```sh
tychonic run architectBuilderQaWorkflow --input-file input.json
```

Minimal input:

```json
{
  "cwd": "/abs/path/to/your/project",
  "goal": "What needs to be designed, built, and reviewed"
}
```

Optional overrides: `architectPrompt`, `builderPrompt`, `qaPrompt`,
`runId`.

## Auto mode

Flip `policies.interaction.mode: auto` (or remove the `interaction`
block) in `config.yaml` to run the three stages straight through
without external gates — useful for dry-run tests of the activity
wiring and for heterogeneous-agent smoke runs (architect=claude,
builder=codex, qa=claude).

**Auto-mode review loop**: in auto mode, `architect` runs once and
the `builder ↔ qa` pair runs in a loop. When qa reports `fail`
(state.status = `failed`), the workflow loops back to builder with
the qa reason threaded into the next prompt as numbered findings. The
loop is capped by `policies.loop.max_review_iterations` (default 3).
At the cap the run transitions to `waiting_user` with an inbox item
(`inbox_review_cap`) in the completed run result; the operator can inspect
the recorded states and start a follow-up run with adjusted input/config.

Interactive mode behaves independently: each stage's own reject
signal reruns that stage (reject feedback accumulates as a numbered
list), and qa approve exits immediately without re-running builder.
The two loop mechanisms do not overlap — interactive mode breaks out
of the outer review loop after a single builder+qa round and defers
all rerun decisions to the external gating agent.

## Key references

- `SPEC.md` — Workflow Model, Workflow Loop Semantics → Interactive mode
- `docs/plugin-workflows.md` — authoring contract for plugin workflows
- Built-in bundles for comparison: `workflows/simpleWorkflow/`,
  `workflows/selfRepairWorkflow/`
