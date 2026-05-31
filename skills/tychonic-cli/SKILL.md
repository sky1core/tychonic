---
name: tychonic-cli
description: "Tychonic CLI workflow operations: run, wait, status, inspect evidence, install or validate workflow bundles, start or check runtime, inspect Temporal-backed state, configure workflow states and policies, operate agent adapters, resume sessions, and verify delegated Tychonic work."
---

# Tychonic CLI

Use this skill when a task involves Tychonic commands, workflow configs,
runtime startup, workflow bundles, agent adapters, session resume, or
verification.

## Product Model

- Temporal workflow history and Temporal APIs are the product state authority.
- Tychonic core ships no host-owned workflows.
- Workflows are installed bundles authored as declarative `workflow.yaml`.
  Install generates the Temporal wrapper and Mermaid graph.
- There are no built-in, official, default, or host-seeded workflows. Reference
  examples under `examples/workflows/` are inert files, even when included in a
  package install, until an operator explicitly installs one with
  `tychonic workflows install <directory>`.
- A workflow that appears in `tychonic workflows list` is a local installed
  registry entry, not proof that Tychonic core owns that workflow.
- Reference examples are starting points for authors. Target account, model
  availability, plan/tier, quota, pricing, region/country access, and
  organization policy differ by operator, so Tychonic does not provide one
  default workflow profile to reuse unchanged.
- Workflow source owns ordering, branching, loops, retry, recovery, and signals.
- Workflow modules should stay simple: author `workflow.yaml`; install generates
  the `tychonic/workflow` helper-backed Temporal wrapper.
- Config declares named `states.<name>` blocks and workflow-owned
  `policies.<name>` values. It is not a workflow graph.

Do not read filesystem run evidence directories as product state. Use CLI
commands backed by Temporal.

## Health And Runtime

Common checks:

```sh
tychonic temporal doctor
tychonic temporal status
tychonic status
```

Runtime daemon:

```sh
tychonic runtime up
```

`runtime up` returns to the shell. Each runtime instance has one managed daemon.
If the daemon is already running, it reports `already_running` with the existing
PID instead of failing because the caller PID differs. It starts the worker and
status UI together; the JSON response includes the status UI URL under
`web.url`. Stop both with:

```sh
tychonic runtime stop
```

Use `tychonic runtime up --foreground` only for development/debugging; stop that
foreground process with `Ctrl-C`.

For persistent macOS service mode, use `tychonic service install`; that
LaunchAgent set includes Temporal, the worker, and the web status UI. Choose
either the operational `runtime up` daemon or service mode for the operational
runtime. Do not run both on the same task queue: `runtime up` refuses when the
Tychonic LaunchAgents are loaded, and `service install` refuses while a
verified manual operational runtime is running. Use `tychonic service status`
to inspect service mode.

Detached/isolated instance flags are development tools. Use them only when the
task explicitly needs isolated runtime state. Prefer `tychonic --help` and
command-specific `--help` for uncommon flags instead of copying options into
instructions.

Runtime and service startup prepare the executable environment from the current
machine PATH and fail preflight when an installed workflow requires a missing
built-in agent executable. Fix the PATH or install the missing CLI, then rerun
the same Tychonic command.

If the runtime cannot bind/connect to the local Temporal API port, report the
smoke as environment-blocked. Do not switch to another operational service to
hide the failure.

## Running Workflows

Agent-backed workflow path:

```sh
tychonic workflows validate ./examples/workflows/<name>
tychonic workflows install ./examples/workflows/<name>
tychonic run <workflow-name> --input-file ./input.json --wait
```

Run commands require a Tychonic runtime daemon:

```sh
tychonic runtime up
```

Stop it with `tychonic runtime stop` when the workflow work is done.

To start work and continue with other tasks, omit the wait flag:

```sh
tychonic run <workflow-name> --input-file ./input.json
```

This returns `workflowId` and `runId`; pass `workflowId` to `tychonic wait`.
Treat `workflowId` as the primary handle for `wait`, `status`, `inbox`,
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
  "message": "Workflow is waiting for input at state 'qa'. Inspect evidence with `tychonic status --workflow-id wf_123`; it lists inbox, artifacts, logs, and sessions. Then run `tychonic approve wf_123 --state qa`, `tychonic reject wf_123 --state qa --feedback \"<feedback>\"`, `tychonic modify wf_123 --state qa --note \"<note>\"`, or `tychonic rerun wf_123 --state qa --reason \"<reason>\"`.",
  "state": "qa",
  "workflowId": "wf_123"
}
```

If the workflow is waiting, follow the commands in `message`. If the message
says the workflow needs attention or finished, inspect the evidence command it
names before reporting.

State names are workflow-owned. If a message names a state, use the bundle
README to understand that state before sending an interaction command.

Inspect a run with `status --workflow-id` first. It includes workflow metadata,
an evidence summary, a timing summary, and read commands for artifacts and
logs. It does not dump the full raw run record by default.

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
it returns the evidence needed to decide the next operator action.

`runtime up` starts the local status UI and prints its URL in `web.url`. For
operational macOS service mode, `tychonic service install` manages the web
LaunchAgent together with Temporal and the worker. Use `tychonic service status`
to inspect all three, `tychonic service terminate-web` to restart only the web
LaunchAgent, and `tychonic service uninstall` to remove the managed service set.

Use the browser view to inspect recent workflow runs, state flow, selected-state
prompt/agent response evidence, artifacts, sessions, and definition metadata.
It remains a Temporal-backed local operator view, not a separate source of
truth. If the UI shows a refresh error, check the `/api/events` EventSource
path, reverse-proxy buffering for `text/event-stream`, and
`TYCHONIC_WEB_ALLOWED_HOSTS` when a non-loopback `Host` header reaches the
loopback-bound server. The `Refresh` button is the manual fallback when event
refresh is unavailable.

`tychonic run` prints a JSON object. Do not require the operator to inspect
Temporal UI/API for routine monitoring.

Workflow run input uses the stable task-shaped surface documented by the
workflow: required `cwd`, optional `goal`, and optional `promptAdditions` only
when the workflow exposes extra state instructions. The workflow owns policy
keys, artifacts, inbox items, signals, and recovery flow. Read the workflow
README before configuring or operating that workflow.
Declarative prompts include `goal` only through explicit `{{goal}}` variables;
unknown prompt variables are install-time errors.

Before running a workflow from a changed checkout, run the contract gate:

```sh
npm run check:contracts
```

This is a pre-run contract check for config, workflow input, review parsing,
and interaction signal surfaces. It calls the production validators and parsers;
it does not replace runtime evidence from the actual workflow run. If it fails,
fix the contract failure before starting the workflow.

Do not substitute a raw agent CLI call for a structured Tychonic review. Direct
commands such as `claude -p`, `codex exec`, or an ad-hoc shell wrapper may help
with exploratory diagnosis, but they do not provide the product contract:
Tychonic `review` TYPE schema enforcement, adapter terminal-source parsing,
artifact/session capture, finding promotion, rerun recovery, or workflow-level
finding audit. For structural issue discovery or commit-readiness review, use
an installed workflow bundle with explicit `review` states, for example
`structuralIssueDiscoveryWorkflow`, after running `npm run check:contracts`.

`tychonic run` validates the standard workflow input contract (required `cwd`,
optional `goal`, optional `promptAdditions`) at CLI preflight before starting
Temporal. A bad workflow input or mismatched `--config` profile fails there, not
inside a Temporal workflow task retry loop.

## Bundle Config

The installed bundle's `defaultProfile` is the default config source. Bundles
derive it from `workflow.yaml`.
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
The QA gate is `review`. Non-verdict support steps are still `work`; only the
structured pass/fail gate is `review`.

State profile shape with environment-specific agent settings omitted:

```yaml
version: tychonic.config.v1
states:
  architect:
    type: work
    agent: claude
  builder:
    type: work
    agent: kiro
  verify:
    type: verify
    command: |
      npm run typecheck
      npm run build
      npm test
  qa:
    type: review
    on_fail_return_to: builder
    agent: codex
```

A workflow author may explicitly choose `model` and supported
`reasoning_effort` per state only after checking the target account, model
availability, plan/tier, quota, pricing, region/country access, and organization
policy. These are explicit agent settings, not defaults for an unchecked
operator environment.

Do not add `resume`, permission, sandbox, timeout, trust, or policy knobs just
because the schema accepts them. Those are orchestration controls, not the same
category as model/reasoning agent settings; use orchestration controls only
when the workflow behavior needs that control.

`policies.<name>` entries are workflow-owned values. The host requires the
top-level `policies` value to be an object, but it does not require each policy
value to be an object or to use the state NAME grammar. The workflow that
consumes a policy validates that policy value's shape.

Allowed state-block fields are `type`, `agent`, `normalizer`, `command`,
`on_fail_return_to`, `model`, `reasoning_effort`, `resume`, `timeout`,
`sandbox`, `approval`, `permission_mode`, and `trust_all_tools`.

Every `review` state must declare `on_fail_return_to`, naming the non-review
state that receives failed review feedback when the workflow loops. The workflow
still owns the loop and must route failed review feedback to that declared
state. For declarative `workflow.yaml`, the generated wrapper appends failed
review summaries and structured findings to that return state's next prompt
when the return state is prompt-bearing.

`model` applies to the primary `agent`. `reasoning_effort` maps to OpenP
`--effort` for all three built-in adapters. Omitted fields become omitted CLI
flags/config overrides; omission delegates to the selected OpenP backend's
default or auto-selection behavior.
For `agent: claude`, model values are Claude CLI model values, not Kiro model
ids. Use one of two forms:

- Versionless alias: use the installed Claude CLI's alias, such as `opus`,
  only when you intentionally want that CLI to select the current model behind
  the alias.
- Exact versioned name: use a full model name only after verifying this
  installed Claude CLI accepts that exact string, for example
  `claude-opus-4-8` after a successful smoke in this environment.

Example Claude state using an exact versioned name:

```yaml
review:
  type: review
  on_fail_return_to: work
  agent: claude
  model: claude-opus-4-8
  reasoning_effort: max
```

Do not copy Kiro model ids or stale versioned strings into Claude states.
Do not rely on memory or `--help` text alone when pinning or documenting a
Claude exact versioned name; run a small `claude -p --model <name>` smoke first.
Tychonic passes the string through. During execution, if a CLI reports the
concrete selected model and it differs from an exact versioned model string in
state config, Tychonic fails the activity instead of accepting a silent model
change. Claude aliases such as `opus` are not exact-match asserted because the
CLI resolves them to concrete model names internally.

Current repo example values, not a template:

Use them only after checking the target account, model availability, plan/tier,
quota, pricing, region/country access, and organization policy.

```yaml
codex_build:
  type: work
  agent: codex
  model: gpt-5.5
  reasoning_effort: xhigh

kiro_work:
  type: work
  agent: kiro
  model: claude-sonnet-4.5
  trust_all_tools: true
```

Kiro states may set `model` and `reasoning_effort`; Tychonic passes them to
OpenP as `--model` and `--effort`. Kiro model ids are OpenP Kiro backend ids.
Availability may be account-, tier-, or region-scoped: a successful
`openp kiro --model <id>` smoke proves what that account can run, not whether
every documented Kiro model id exists globally. Repo reference examples may be
pinned to a maintainer-verified Kiro ACP model id for this repository; do not
treat a failed smoke in one account as proof that the id is globally invalid.
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

Use `command` only as an escape hatch for custom CLIs, unusual flags, or test
stubs. A state sets exactly one of `agent` or `command`.

For review states, `kiro` requires `normalizer:
claude` or `normalizer: codex`. The primary agent performs the review; the
normalizer structures that output into the semantic review payload.

`kiro` uses ACP `sessionId` from `session/new` and resumes through
`session/load`.

The `kiro` adapter runs non-interactively. If a Kiro state must inspect files
or run checks, set `trust_all_tools: true` only for that state and only in an
isolated worktree. QA/review may execute checks, but must not edit code.
Review activities compare the git worktree before and after the reviewer
command when a git worktree is available; a net source mutation fails the
review. The Kiro review path also rejects direct file writes. Without tool
trust, Kiro can stop on tool approval instead of completing the workflow.

`TYCHONIC_AGENT_PATH` prepends directories to the agent CLI lookup path. Use it
when a smoke test or local setup needs Tychonic to find agent binaries outside
the normal `PATH`, for example a temporary stub directory or a locally installed
CLI. It is not workflow config and workflow run input must not mention
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

Example bundles that import only `@temporalio/workflow` and `tychonic/workflow`
need no per-bundle npm install. Tychonic provides those workflow imports while
bundling workflow code. If a custom bundle imports any other package, ship that
dependency inside the bundle directory or pre-bundle it before
`tychonic workflows install`.
Tychonic does not run `npm install`, synthesize arbitrary `node_modules`, add
symlinks, or rewrite resolver paths.

## Waiting User And Signals

Before reaching `waiting_user`, generated declarative workflows already absorb
transient infrastructure failure at the Temporal activity proxy layer
(token-limit cool-downs, network blips, laptop suspend, worker restart). The
proxy retries every thrown activity for roughly fifteen hours of wall-clock
budget before surfacing the error to workflow code. Activity outcomes returned
as `failed`/`timed_out`/`blocked` on the normal return path are not retried by
the proxy — workflow code handles them through its own review/fix loop or by
parking on the recovery gate. Errors thrown as
`ApplicationFailure.nonRetryable` (missing config, unsupported adapter,
missing command) skip the retry budget and reach workflow code immediately.

`waiting_user` therefore means one of: the transient retry budget was
exhausted, a permanent (nonRetryable) error reached the recovery gate, or the
workflow expects an explicit decision at an interactive gate. The wait
`message` is the authority: if it names a waiting `state`, inspect evidence
(`status --include-result`, `inbox`, `artifacts`, `logs`, `sessions`), fix the
underlying cause where applicable, then resume with the workflow's interaction
command for that state. A fresh run is only the right move when the workflow
has already finished (`completed`/`failed`/`canceled`/`terminated`) — closed
workflows cannot accept signals, and resume is impossible.

Use documented workflow signals only:

```sh
tychonic signal <workflow-id> <signal-name> --payload-file ./payload.json
```

For workflows that expose the standard interaction helper, use:

```sh
tychonic approve <workflow-id> --state <state>
tychonic reject <workflow-id> --state <state> --feedback "..."
tychonic modify <workflow-id> --state <state> --note "..."
tychonic rerun <workflow-id> --state <state> --reason "..."
```

Use `rerun` when the workflow exposes a retry of the same state without adding
new feedback or incrementing a reject cap. This can apply to recoverable state
failures such as transient activity or external-agent failures, and to
workflow-defined interactive gates that accept the standard interaction helper.
It appends new history instead of rewriting the failed attempt.

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

## Project Setup

Tychonic-owned byproducts must not be written into the target repository.
Run evidence lives under `~/.tychonic/runs/operational/<run-id>/` or
`~/.tychonic/runs/instances/<name>/<run-id>/`; isolated workflow worktrees are
created under `~/.tychonic/worktrees/`, not under `/tmp`, not under the active
runtime state directory, and not under the project `.tychonic/` directory.
Repositories with git submodules are initialized automatically
(`git submodule update --init --recursive`) when the worktree is created;
no manual submodule setup is needed.
On finish Tychonic captures a `worktree_patch` artifact and leaves the worktree
directory in place; the worktree path is preserved in the workflow result and
visible through `tychonic status --workflow-id <id> --include-result`. The
operator removes worktrees with standard tools (`git worktree remove`, `trash`,
`rm`) when they are no longer needed; Tychonic does not provide a cleanup
activity, signal, or CLI command for that.

Agents must not create files or directories at the project root unless they are
source files that are part of the actual task deliverable. Scratch files,
temporary files, notes, analysis outputs, and working state belong in Tychonic
evidence/artifact paths or outside the target repository when explicitly
needed.

## Guardrails

- Use Temporal-backed CLI commands for state.
- Do not add repo-local workflow state stores.
- Do not fake arbitrary bundle resolution with symlinks, copied host
  `node_modules`, or environment rewrites.
- Keep user-facing docs focused on product behavior. Put workflow-specific
  behavior in that workflow's bundle README.
- Do not create scratch files, temporary files, or working directories at
  the project root. Non-deliverable files belong in Tychonic evidence/artifact
  paths or outside the target repository when explicitly needed.
- For notification troubleshooting, use
  [notifications-troubleshooting.md](./notifications-troubleshooting.md).
