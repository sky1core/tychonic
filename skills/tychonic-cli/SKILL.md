---
name: tychonic-cli
description: Use when operating, documenting, or debugging Tychonic CLI workflows, runtime startup, Temporal-backed state, activity-centric configuration, agent permissions, session resume, or public-alpha verification.
---

# Tychonic CLI

Use this skill when a task involves Tychonic commands, workflow configs,
runtime setup, explicit agent commands, resume/session behavior, or release
verification.

## Product Model

Tychonic is a local work-operations state machine for isolated delegated AI work.

- Temporal workflow history and Temporal APIs are the product state authority.
- The CLI starts workflows, manages local runtime processes, and queries
  Temporal-backed state.
- Workers poll Temporal and run activities.
- Activities run deterministic commands or external agent CLIs.
- Per-workflow loops, continuations, and recovery semantics live in the
  workflow's own state machine and bundle README.

Do not describe `runtime up` as bypassing Temporal. It runs the worker in the
foreground instead of through launchd.

## Before Using This Skill

Installation, service setup, and agent CLI discovery are covered in the
project [README](../../README.md). For the operational service path, assume
Tychonic is already installed and Temporal is reachable (`tychonic temporal
doctor` returns ok). Use `tychonic --help` and command-specific `--help` for
uncommon flags; this skill documents the common operating path, not every CLI
option.

Quick health checks before running work on an existing runtime:

```sh
tychonic temporal doctor
tychonic temporal status
tychonic status
```

If a detached runtime was just started and `temporal status` reports
`ECONNREFUSED`, wait briefly and check again before treating it as a
workflow failure. Startup can lag the CLI return; inspect runtime logs only
if the Temporal API stays unreachable.
If the runtime log reports local socket `EPERM` or `operation not permitted`
for the Temporal API port, the current sandbox cannot bind/connect to the
local Temporal server. Report the smoke as environment-blocked; do not claim a
workflow result and do not switch to operational services to work around it.

## Workflows

Config files declare named states and policies for existing workflows. They are not workflow graphs.

Use config files for:

- state commands
- agent labels and explicit commands
- adapter commands
- state timeouts
- workflow/state scoped policy knobs
- per-workflow loop settings (each workflow declares which keys it reads
  in its bundle README)

Workflow ordering, branching, loops, fan-out, and joins belong in TypeScript
Temporal workflow code.

## Workflow Module Authoring Contract

When a task involves writing or changing workflow modules, read
[workflow-module-contract.md](./workflow-module-contract.md) first and
follow it exactly.

Validate config and workflow settings:

```sh
tychonic workflows validate ./examples/workflows/pipelineWorkflow
```

Run any installed workflow:

```sh
tychonic run <workflow-name> --input-file ./input.json --wait
tychonic status --workflow-id <id> --include-result
tychonic inbox --workflow-id <id>
tychonic artifacts --workflow-id <id>
tychonic artifacts --workflow-id <id> --artifact <art-id>
tychonic logs --workflow-id <id>
tychonic sessions --workflow-id <id>
tychonic signal <workflow-id> <signal-name> --payload-file <file>
```

The JSON input must carry the full Temporal workflow input object. The
input shape is workflow-specific — read the target workflow's bundle
README for its required fields before invoking `run`. `input.profile`
is optional: when omitted, `tychonic run` injects the installed
bundle's `defaultProfile` automatically. When present, the user-supplied
profile replaces the default verbatim (no merge).

`tychonic run` prints a single JSON object on stdout. Capture its
`workflowId` for subsequent `status` / `inbox` / `artifacts` / `logs`
calls — those commands all require `--workflow-id <id>`. With `--wait`,
the Temporal execution run id is `firstExecutionRunId`; the Tychonic product
run id is inside `result.runId`, and the product outcome is inside
`result.status`. Without `--wait`, `tychonic run` returns immediately after
Temporal accepts the start request; use `tychonic status --workflow-id <id>
--include-result` once the workflow reaches a terminal state to read the result.
In `status --include-result` output, the result is under
`workflow.result.status` because the command wraps the Temporal workflow
description in a top-level `workflow` object.

A reviewer activity (state TYPE `review`) must emit one
`tychonic.review.v1` JSON object on stdout. Plain shell exit codes
(`true` / `false`) are treated as malformed reviewer output and routed
to triage. See SPEC §"Structured Reviewer Contract" or the target
workflow's bundle README for the required fields and an example.
The minimal pass object is:

```json
{
  "schema_version": "tychonic.review.v1",
  "status": "pass",
  "summary": "all checks satisfied",
  "findings": []
}
```

Use these exact field names. `version` / `verdict` are not aliases.

A workflow with a `fail` review verdict still finishes from Temporal's
point of view — `tychonic status --workflow-id <id>` reports the run as
completed once it reaches a terminal Tychonic state. Read the **Tychonic
status** field on the result (`succeeded` / `waiting_user` / etc.), not
the Temporal completion flag, to decide whether the run met its goal.

`tychonic inbox` and `tychonic sessions` are read-only listing commands.
Acting on a `waiting_user` run is done through `tychonic signal` (see
"Waiting-User Recovery Signals" below).

## Per-Workflow Behavior Lives In Each Bundle

This skill describes Tychonic's general contract — Temporal-backed state,
bundle structure, recovery signals, runtime isolation. **Per-workflow
behavior (which `policies` keys a workflow respects, what artifacts it
emits, how to write a brief for it, what its inbox items mean) belongs to
the workflow's bundle, not to this skill.** `tychonic workflows validate`
enforces the YAML shape but does **not** check whether a given workflow
actually reads a given policy key — a config block can validate clean and
still be silently ignored at runtime if it targets a workflow that does
not implement it.
Likewise, host-level `tychonic config validate` checks the shared config
schema, not every workflow-specific semantic constraint. Read the bundle
README for policy combinations that the workflow rejects at runtime.

Before configuring or operating a workflow, read its bundle:

```sh
tychonic config show --workflow-name <name>
tychonic workflows list
# Read the README.md next to the installed bundle path from workflows list.
```

Tychonic ships no bundled workflows inside the host package. The repository's
`examples/workflows/` directory contains example bundles you can install for
reference (`tychonic workflows install ./examples/workflows/<name>`); each
bundle's `README.md` documents its own input shape, signals, and recovery
flow. For brief-writing rules, loop behavior, resume caps, and inbox
items specific to a workflow, read **that workflow's bundle README**, not
this skill.

Workflow bundles are ordinary package directories. The bundle directory
name must equal the exported workflow function name in `workflow.mjs`;
that same name is what users pass to `tychonic run <workflow-name>`.
If the bundle has its own `package.json` dependencies, install them in
that bundle directory before installing the bundle:

```sh
(cd ./examples/workflows/<name> && npm install)
tychonic workflows install ./examples/workflows/<name>
```

For a smoke test that must not touch the source checkout, copy the bundle
to a temporary directory that preserves the bundle name, then install
dependencies in the copy:

```sh
mkdir -p /tmp/tychonic-smoke
cp -R ./examples/workflows/simpleWorkflow /tmp/tychonic-smoke/simpleWorkflow
(cd /tmp/tychonic-smoke/simpleWorkflow && npm install --omit=dev)
tychonic workflows install /tmp/tychonic-smoke/simpleWorkflow
```

Tychonic copies the bundle tree into the runtime registry. It does not run
`npm install`, synthesize `node_modules`, or add resolver shims during
`workflows install`. If dependency installation fails because the environment
is offline or sandboxed, stop and report the smoke as blocked. Do not fake a
working bundle by symlinking the project root `node_modules`, rewriting
resolver paths, copying private dependency trees, or adding temporary shims.
That would test a staged environment the installed bundle will not actually
have.

After a smoke, clean only the temporary files you created. Use `trash` for
cleanup; if `trash` is unavailable or denied for a sandbox path, report the
leftover path instead of falling back to `rm -rf`.

## Bundle Configuration

Every workflow ships as a **bundle** directory containing `workflow.mjs`
and optionally `README.md`. `workflow.mjs` exports the workflow function
and a `defaultProfile` object — the workflow's author-supplied profile
that is the only source of configuration for that workflow.

`defaultProfile` uses `version: tychonic.config.v1` and contains only
`states.<name>` and `policies.<name>` blocks. Allowed state-block fields
are `type`, `agent`, `command`, `resume`, `timeout`, `sandbox`,
`approval`, `permission_mode`, and `trust_all_tools`. Vendor-owned
pass-through values (`model`, `reasoning_effort`,
`thinking_budget`, `approval_mode`, and similar) belong in the external
agent CLI's own configuration.

Inspect and validate an installed bundle:

```sh
tychonic config show     --workflow-name <name> --format yaml
tychonic config validate --workflow-name <name>
tychonic workflows validate ./path/to/bundle        # before installing
```

`tychonic workflows install <directory>` writes the bundle into the
runtime workflow module registry. If the operational worker LaunchAgent is
loaded, the install refreshes that worker so the new bundle is loaded.

A one-off override for a single invocation replaces the bundle's
`defaultProfile` as a single whole object (no merge). The override file is
YAML or JSON text matching the same `tychonic.config.v1` shape:

```sh
tychonic config show --workflow-name <name> --config ./one-off.yaml
tychonic run <name> --input-file ./input.json --config ./one-off.yaml
```

Prefer `--config <file>` for operator-supplied one-off profile overrides.
Do not also put `profile` inside the JSON input when `--config` is present;
the CLI rejects that because both would be competing profile sources.

Each run writes `.tychonic/runs/<runId>/artifacts/profile_snapshot.yaml`
so the effective config is reproducible evidence. No
`profile_sources.json` is written — a bundle has only one source, its
`defaultProfile` export.

## Waiting-User Outcomes

A workflow run reaches `waiting_user` when its workflow contract decides
the loop cannot proceed without a human (specific triggers are
workflow-defined — see the bundle README). The workflow records inbox
items describing the unresolved findings and terminates.

`tychonic signal <workflow-id> <signal-name>` is still the host-side verb
for any signals a running workflow registers — read the bundle README for
its signal table and payload shape — but the bundle decides whether to
keep the workflow alive long enough to consume them. Most bundles in this
repo terminate immediately at any Tychonic terminal status; recovery is
done by inspecting the artifacts and starting a fresh run with adjusted
input. The interactive-mode signals (`approveState`, `rejectState`,
`modifyState`) are the exception — they target a parked state inside an
interactive workflow and have first-class CLI shortcuts (`tychonic
approve|reject|modify <workflow-id>`).

```sh
tychonic signal <workflow-id> <signal-name> [--run-id <id>] \
  [--payload-file <file>]
```

- `<signal-name>` is workflow-defined.
- `--payload-file` reads a JSON file whose parsed contents become the
  signal payload. Omit it for signals whose registered handler accepts an
  empty payload.
- `--run-id` targets a specific Temporal run id when the workflow id has
  multiple runs. Optional — the latest run is used otherwise.
Inspect the run before deciding what to do next:

```sh
tychonic status   --workflow-id <id>
tychonic inbox    --workflow-id <id>
tychonic sessions --workflow-id <id>
tychonic logs     --workflow-id <id>
```

Synchronous vs asynchronous invocation:

- `tychonic run <workflow> --input-file <file> --wait` blocks the CLI
  until the workflow reaches a terminal status and returns the run
  result. Use this when a single CLI call should produce the final
  outcome.
- Omit `--wait` to dispatch the run asynchronously. The CLI returns the
  workflow id immediately; query progress with `tychonic status`,
  `tychonic inbox`, etc.

## Carrying Work Forward From A Failed Run

Tychonic does not yet have a first-class "adopt an old worktree" start
surface. Until that exists, a new workflow run can still recover useful
in-progress work by telling the worker to inspect the previous run's artifacts
and selectively port them into the new isolated worktree.

Use this only as an explicit temporary recovery tactic until Tychonic ships a
real adopt-worktree/start-from-run feature. Once that product feature exists,
use the real feature directly instead of instructing the worker to manually
inspect and port an old worktree. Do not describe the workaround as the same
thing as resuming the old worktree.

When you need this, put the previous run/worktree references directly in the
new workflow brief:

```text
Previous run: <run-id>
Previous failed worktree: <absolute-path>
Previous patch/artifacts to inspect: <artifact-paths>

Start from a fresh isolated worktree, but first inspect the previous failed
worktree and its patch/artifacts. Reapply only the relevant unfinished work
into the new worktree. Do not assume the old worktree is authoritative; verify
every carried-over change against the current source tree and tests.
```

That gives a useful recovery path now without pretending that the product has a
real adopt-worktree feature. Treat this as a workflow-start recovery tactic,
not as something tied to one specific workflow. Track the proper product gap
separately.

## Agent Configuration

Tychonic ships built-in adapters for **`claude`**, **`codex`**, **`gemini`**,
and **`kiro`**. Set `agent: "<name>"` on a state block to use one. The host
writes the CLI's `argv`, role-aware permission flags (work vs review), the
session-id round trip, and the resume invocation where the adapter supports
same-session resume. No hand-written `command` or per-CLI flag list is needed
for the built-in path.

`gemini` and `kiro` are partial adapters — neither CLI produces the
structured `tychonic.review.v1` output the host requires from a
reviewer, so neither may serve as a `type: "review"` agent. The host
schema rejects `agent: "gemini"` or `agent: "kiro"` on a review state
at install time, and the runtime adapter throws `AdapterUnsupported`
as a second line of defense. `kiro` worker sessions are resumable only when
the built-in adapter captures `conversation_id` from the same `kiro-cli chat`
process via `/chat save`; do not infer identity from `kiro-cli chat
--list-sessions` before/after diffs. `gemini` cannot resume through the
built-in adapter because its `--resume` takes a project-relative index rather
than a stable session id. Pick `claude` or `codex` for review states, or use
an explicit `command` for review roles.

`resume: <number>` defaults to `0`. Use it only when a workflow deliberately
continues a previous agent session; the common recommendation is to put it on
the worker state and keep the value small. If a workflow does not need
same-session continuation, omit it.

Allowed state-block orchestration fields are `sandbox`, `approval`,
`permission_mode`, and `trust_all_tools`. Vendor-owned pass-through
values (`model`, `reasoning_effort`, `thinking_budget`, `approval_mode`,
`effort`, `plan_mode_reasoning_effort`, and similar) are not valid config
fields; put those flags directly in an escape-hatch `command` or in the
external CLI's own configuration.

## Escape-Hatch Command

`command` runs a literal shell command verbatim and bypasses the adapter
layer. Use it for:

- a custom CLI not in the four-adapter set
- an unusual flag combination the built-in adapters do not produce
- a test stub

`agent` and `command` are mutually exclusive execution selectors. A state
block must not set both. When `command` is set, Tychonic runs it verbatim
and does not handle resume on that escape-hatch path — that is the
operator's responsibility (the CLI wrapper, a separate script, or just
running each iteration with a fresh session).

## Verification

Verification splits along the worktree boundary:

- `npm run verify:worker` — typecheck, tests, build, and example
  validation. Safe to run inside an isolated worktree with
  no network. Worker activities should call this as their in-sandbox
  gate.
- `npm run verify` — adds `npm audit`, `npm publish --dry-run`, and
  the package smoke install. Requires network access to the public
  registry. Operator runs this on the source tree after applying a
  patch; it is a contract violation for a worker activity to depend
  on it.

When writing worker instructions, reference `verify:worker` as the
in-sandbox gate. Do not introduce conditional skips or offline
shim branches to make `verify` pass in a constrained environment;
split the check instead (worker-side vs operator-side).

Live agent-resume verification uses real authenticated agent CLIs
and may consume provider quota. By default it runs the resume-capable
built-in adapters (`claude`, `codex`, `kiro`). `gemini` is not in the
default set because its built-in adapter has no stable resume-by-id
surface; explicitly selecting it reports `resume_unsupported`.

```sh
npm run verify:agents-live
TYCHONIC_LIVE_AGENTS=kiro npm run verify:agents-live
TYCHONIC_LIVE_AGENTS=codex,claude,kiro npm run verify:agents-live
```

## Notifications

If a Tychonic notification doesn't appear, see
[notifications-troubleshooting.md](./notifications-troubleshooting.md).

## Guardrails For Skill Use

- Read product state through Temporal APIs (`tychonic status`, `inbox`,
  `sessions`, `artifacts`, `logs`). Do not scan `.tychonic/runs` as state.
- Do not propose repo-local workflow state stores or new run databases.
- Keep any public-facing doc edits focused on product behavior; private
  operating notes belong in ignored `*.local.md` files.
- Run `npm run verify` before declaring a release-ready state.
