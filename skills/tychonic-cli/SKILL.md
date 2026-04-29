---
name: tychonic-cli
description: Use when operating, documenting, or debugging Tychonic CLI workflows, runtime startup, Temporal-backed state, activity-centric configuration, agent permissions, session resume, or verification.
---

# Tychonic CLI

Use this skill when a task involves Tychonic commands, workflow configs,
runtime startup, workflow bundles, agent adapters, session resume, or
verification.

## Product Model

- Temporal workflow history and Temporal APIs are the product state authority.
- Tychonic core ships no host-owned workflows.
- Workflows are installed bundles with `workflow.mjs` and `defaultProfile`.
- Workflow code owns ordering, branching, loops, retry, recovery, and signals.
- Config declares named `states.<name>` blocks and workflow-owned
  `policies.<name>` blocks. It is not a workflow graph.

Do not read `.tychonic/runs` as product state. Use CLI commands backed by
Temporal.

## Health And Runtime

Common checks:

```sh
tychonic temporal doctor
tychonic temporal status
tychonic status
```

Foreground runtime:

```sh
tychonic runtime up --project-dir "$PWD"
```

Stop a foreground runtime with `Ctrl-C`. Detached isolated runtimes print a
`stopCommand`; use that command instead of reading pid files or killing
processes manually.

Detached/isolated instance flags are development tools. Use them only when the
task explicitly needs isolated runtime state. Prefer `tychonic --help` and
command-specific `--help` for uncommon flags instead of copying options into
instructions.

If the runtime cannot bind/connect to the local Temporal API port, report the
smoke as environment-blocked. Do not switch to another operational service to
hide the failure.

## Running Workflows

Ordinary agent path:

```sh
(cd ./examples/workflows/<name> && npm install)
tychonic workflows validate ./examples/workflows/<name>
tychonic workflows install ./examples/workflows/<name>
tychonic run <workflow-name> --input-file ./input.json --wait
```

Run commands require a Tychonic runtime started in another terminal:

```sh
tychonic runtime up --project-dir "$PWD"
```

Stop that foreground terminal with `Ctrl-C` when the workflow work is done.

To start work and continue with other tasks, omit the wait flag:

```sh
tychonic run <workflow-name> --input-file ./input.json
```

This returns `workflowId` and `runId`; pass `workflowId` to `tychonic wait`.
Treat `workflowId` as the ordinary handle for `wait`, `status`, `inbox`,
`artifacts`, `logs`, and `sessions`. Use `runId` only when the command asks for
one or you must disambiguate a specific Temporal execution.

To wait for an already-started workflow:

```sh
tychonic wait <workflow-id>
```

Read `message` first; it is the plain-language result for the caller and may
include the next useful Tychonic commands.

```json
{
  "ok": true,
  "message": "Workflow is waiting for input at state 'qa'. Inspect evidence with `tychonic status --workflow-id wf_123`; it lists inbox, artifacts, logs, and sessions. Then run `tychonic approve wf_123 --state qa`, `tychonic reject wf_123 --state qa --feedback \"<feedback>\"`, or `tychonic modify wf_123 --state qa --note \"<note>\"`.",
  "state": "qa",
  "workflowId": "wf_123"
}
```

If the workflow is waiting, follow the commands in `message`. If the message
says the workflow needs attention, inspect the evidence commands it names. If
the message says the workflow finished, use the result command it names before
reporting.

State names are workflow-owned. If a message names a state, use the bundle
README to understand that state before sending an interaction command.

Inspect a run with `status --workflow-id` first. It includes an evidence
summary and read commands for artifacts and logs.

```sh
tychonic status --workflow-id <id>
```

Use focused commands only when a specific list or raw content is needed:

```sh
tychonic inbox --workflow-id <id>
tychonic artifacts --workflow-id <id>
tychonic artifacts --workflow-id <id> --artifact <art-id>
tychonic logs --workflow-id <id>
tychonic sessions --workflow-id <id>
```

Without `--workflow-id`, `status` lists recent workflows. With `--workflow-id`,
it includes the workflow's Tychonic run result and evidence summary when
available.

`tychonic run` prints a JSON object. Do not require the operator to inspect
Temporal UI/API for ordinary monitoring.

Each workflow owns its own input shape, policy keys, artifacts, inbox items,
signals, and recovery flow. Read the bundle README before configuring or
operating that workflow.

## Bundle Config

The installed bundle's `defaultProfile` is the default config source.
`--config <file>` replaces that profile for one invocation as a whole object.
There is no merge.

Workflow input must be a JSON object. Do not put `profile` in `--input` or
`--input-file`; Tychonic reserves that field for the effective config it
passes internally to workflow code.

State `type` is exactly one of `work`, `verify`, or `review`:

- `work` runs an agent or command to produce or modify work.
- `verify` runs deterministic checks.
- `review` produces a structured pass/fail review verdict.

For architect/builder/QA workflows, architect and builder states are `work`.
The QA gate is `review`. A prose Kiro pre-review or repair step is still
`work`; only the structured pass/fail gate is `review`.

Recommended state profile shape:

```yaml
version: tychonic.config.v1
states:
  work:
    type: work
    agent: codex
    model: gpt-5.5
    reasoning_effort: xhigh
  verify:
    type: verify
    command: |
      npm run typecheck
      npm run build
      npm test
  review:
    type: review
    agent: claude
    model: opus
    reasoning_effort: max
```

For repeatable workflows, pin `model` on agent states instead of relying on a
changing CLI default. Set `reasoning_effort` on Claude/Codex states whose
quality depends on reasoning depth. These are recommended agent settings, not
cargo-cult knobs.

Do not add `resume`, permission, sandbox, timeout, trust, or policy knobs just
because the schema accepts them. Those are orchestration controls, not the same
category as model/reasoning agent settings; use orchestration controls only
when the workflow behavior needs that control.

Allowed state-block fields are `type`, `agent`, `normalizer`, `command`,
`model`, `reasoning_effort`, `resume`, `timeout`, `sandbox`, `approval`,
`permission_mode`, and `trust_all_tools`.

`model` applies to the primary `agent`. `reasoning_effort` is supported by
`claude` and `codex`. Omitted fields become omitted CLI flags/config
overrides; omission delegates to the selected external CLI's default or
auto-selection behavior.
For `agent: claude`, model values are Claude CLI model values, not Kiro model
ids. Use one of two forms:

- Versionless alias: use the installed Claude CLI's alias, such as `opus`,
  when you want that CLI to select the current model behind the alias.
- Exact versioned name: use a full model name only after verifying this
  installed Claude CLI accepts that exact string, for example
  `claude-opus-4-7` after a successful smoke in this environment.

Example Claude state using a versionless alias:

```yaml
review:
  type: review
  agent: claude
  model: opus
  reasoning_effort: max
```

Example Claude state using an exact versioned name:

```yaml
review:
  type: review
  agent: claude
  model: claude-opus-4-7
  reasoning_effort: max
```

Do not copy Kiro model ids or stale versioned strings into Claude states.
Do not rely on memory or `--help` text alone when pinning or documenting a
Claude exact versioned name; run a small `claude -p --model <name>` smoke first.
Tychonic only passes the string through.

High-model examples by agent:

```yaml
codex_build:
  type: work
  agent: codex
  model: gpt-5.5
  reasoning_effort: xhigh

gemini_work:
  type: work
  agent: gemini
  model: gemini-3.1-pro-preview

kiro_work:
  type: work
  agent: kiro
  model: claude-sonnet-4.5
  trust_all_tools: true
```

Kiro states may set `model`, but not `reasoning_effort`;
the installed Kiro CLI ACP surface exposes no stable reasoning/effort/thinking
option.
Do not add normalizer model fields; Tychonic supplies the lightweight
normalizer model flag internally (`claude` gets `haiku`; `codex` gets
`gpt-5.3-codex-spark`).

## Agents

Use `agent: "<name>"` for built-in adapters:

| Agent | Worker | Review | Same-session resume |
|---|---:|---:|---:|
| `claude` | yes | yes | yes |
| `codex` | yes | yes | yes |
| `kiro` | yes | with normalizer | yes |
| `gemini` | yes | with normalizer | no |

Use `command` only as an escape hatch for custom CLIs, unusual flags, or test
stubs. A state sets exactly one of `agent` or `command`.

For review states, `gemini` and `kiro` require `normalizer:
claude` or `normalizer: codex`. The primary agent performs the review; the
normalizer structures that output into the semantic review payload.

`kiro` uses ACP `sessionId` from `session/new` and resumes through
`session/load`.

The `kiro` adapter runs non-interactively. If a Kiro state must inspect files
or run checks, set `trust_all_tools: true` only for that state and only in an
isolated worktree. QA/review may execute checks, but must not edit code; the
Kiro review path rejects direct file writes and fails if tracked files change
during the review turn. Without tool trust, Kiro can stop on tool approval
instead of completing the workflow.

`TYCHONIC_AGENT_PATH` prepends directories to the agent CLI lookup path. Use it
when a smoke test or local setup needs Tychonic to find agent binaries outside
the normal `PATH`, for example a temporary stub directory or a locally installed
CLI. It is not workflow config and ordinary workflow input should not mention
it.

Built-in review adapters ask the model for the semantic payload:

```json
{
  "status": "pass",
  "summary": "all checks satisfied",
  "findings": []
}
```

`findings` means actionable problems only. Do not put evidence, confirmations,
or passing notes in `findings`; a passing review uses `findings: []`.

The host normalizes built-in reviewer output into `tychonic.review.v1`.
Escape-hatch `command` reviewers bypass that normalization, so their stdout
must emit the full documented wire object.

## Workflow Authoring

When writing or changing a workflow bundle, read
[workflow-module-contract.md](./workflow-module-contract.md). Keep workflow
code deterministic and keep file/shell/network work inside activities.

Workflow bundles are normal package directories. Install dependencies in the
bundle directory before `tychonic workflows install`. Tychonic does not run
`npm install`, synthesize `node_modules`, add symlinks, or rewrite resolver
paths.

## Waiting User And Signals

`waiting_user` means the workflow decided it cannot proceed automatically.
Recovery is workflow-defined. Many workflows require a fresh run with adjusted
input or config; interactive workflows may remain parked and accept signals.
The wait `message` is the authority: if it names a waiting `state`, use the
workflow's interaction command for that state; if it says the workflow needs
attention, inspect evidence before deciding whether to start a fresh run or use
that workflow's documented recovery path.

Use documented workflow signals only:

```sh
tychonic signal <workflow-id> <signal-name> --payload-file ./payload.json
```

For workflows that register standard interaction signals, use:

```sh
tychonic approve <workflow-id> --state <state>
tychonic reject <workflow-id> --state <state> --feedback "..."
tychonic modify <workflow-id> --state <state> --note "..."
```

## Verification

Use the gate that matches the environment:

```sh
npm run verify:worker
npm run verify
```

`verify:worker` is the in-worktree gate. `verify` adds release checks that may
need network access and should run on the source tree after applying a patch.
Do not add conditional skips or offline shims to make the wrong gate pass.

Live agent resume checks use real authenticated agent CLIs and may consume
provider quota:

```sh
npm run verify:agents-live
```

## Guardrails

- Use Temporal-backed CLI commands for state.
- Do not add repo-local workflow state stores.
- Do not fake bundle resolution with symlinks, copied host `node_modules`, or
  environment rewrites.
- Keep user-facing docs focused on product behavior. Put workflow-specific
  behavior in that workflow's bundle README.
- For notification troubleshooting, use
  [notifications-troubleshooting.md](./notifications-troubleshooting.md).
