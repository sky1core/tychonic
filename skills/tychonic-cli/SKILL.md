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
- Review/simpleWorkflow continuation is part of the workflow state machine.

Do not describe `runtime up` as bypassing Temporal. It runs the worker in the
foreground instead of through launchd.

## Before Using This Skill

Installation, service setup, and agent CLI discovery are covered in the
project [README](../../README.md). This skill assumes Tychonic is already
installed and Temporal is reachable (`tychonic temporal doctor` returns ok).

Quick health checks before running work:

```sh
tychonic temporal doctor
tychonic temporal status
tychonic status
```

External Temporal can be selected with `--mode external`, `--address`,
`--namespace`, and `--task-queue` on any runtime, workflow, or status command.

## Workflows

Config files declare named states and policies for existing workflows. They are not workflow graphs.

Use config files for:

- state commands
- agent labels and explicit commands
- adapter commands
- state timeouts
- workflow/state scoped policy knobs
- review/simpleWorkflow loop settings

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

Run `simpleWorkflow`:

```sh
tychonic run simpleWorkflow --input-file ./simple-workflow-input.json --wait
tychonic status --workflow-id <id> --result
tychonic inbox --workflow-id <id>
tychonic inbox execute <item-id> --workflow-id <id> --config <file>
tychonic sessions --workflow-id <id>
```

The JSON input must carry the full Temporal workflow input object. For
`simpleWorkflow`, that usually means `cwd`, `verifyCommand`, worker/reviewer
fields, and any resolved `profile` snapshot you want the workflow to run with.

`tychonic inbox` and `tychonic sessions` are themselves the listing commands.
Subcommands (`inbox execute`, `inbox dismiss`, `sessions register`) act on
individual items.

## Writing Development Briefs For `simpleWorkflow`

When using `simpleWorkflow` as the development workflow, the brief must say
exactly what the worker should do. The issue is not "narrow vs broad". The
issue is whether the brief states the desired contract precisely enough that
the worker cannot reinterpret product direction on its own.

A development brief for `simpleWorkflow` must include all of these:

- current canonical product names that must remain unchanged during the task
- exact feature/fix to implement
- exact file or module scope to edit
- explicit do-not-touch surface
- exact verification command or failing test to make pass
- explicit stop condition if the worker discovers a broader naming/spec issue

Use wording like this:

```text
Implement exactly X.
Current canonical names are A/B/C; do not rename product surfaces.
Only edit files under Y.
Do not modify Z.
Make this verification pass: <command>.
If the task appears to require broader product renaming or spec reinterpretation,
stop and report instead of making repo-wide changes.
```

Do not hand `simpleWorkflow` vague goals such as "audit recent changes",
"clean up naming", or "improve the workflow changes" unless the task really is
an explicitly approved repo-wide audit. Those briefs let the worker reinterpret
the product surface and are likely to produce unrelated renames or drift from
the current contract.

Current canonical workflow names in this repo are:

- `simpleWorkflow` — development workflow
- `selfRepairWorkflow` — self-repair / bug-finding-and-fixing workflow
- `checkpointWorkflow` — gate / review workflow

## Bundle Configuration

Every workflow ships as a **bundle** directory containing
`workflow.mjs`, `config.yaml`, and optionally `README.md`. The bundle's
`config.yaml` is the only source of configuration for that workflow.

Config files use `version: tychonic.config.v1` and contain only
`states.<name>` and `policies.<name>` blocks. Allowed state-block
fields are `type`, `agent`, `command`, `resume_command`, `timeout`,
`sandbox`, `approval`, `permission_mode`, `trust_all_tools`, and
`emits` (review TYPE only). Vendor-owned pass-through values (`model`,
`reasoning_effort`, `thinking_budget`, `approval_mode`, and similar)
belong in the external agent CLI's own configuration.

Inspect and validate an installed bundle:

```sh
tychonic config show     --workflow simpleWorkflow --format yaml
tychonic config validate --workflow simpleWorkflow
tychonic workflows validate ./path/to/bundle        # before installing
```

A one-off override for a single invocation or signal replaces the
bundle's `config.yaml` as a single whole object (no merge):

```sh
tychonic config show --workflow simpleWorkflow --config ./one-off.yaml
tychonic inbox execute <item-id> --workflow-id <wf> --config ./one-off.yaml
```

Each run writes `.tychonic/runs/<runId>/artifacts/profile_snapshot.yaml`
so the effective config is reproducible evidence. No
`profile_sources.json` is written — a bundle has only one source, the
bundle itself.

## Resuming Blocked Simple Workflows

If `simpleWorkflow` hits its `max_review_iterations` and the final
review still fails, the workflow enters `waiting_user`. With
input `holdOpenOnWaiting: true`, it accepts these recovery signals:

```sh
tychonic inbox execute <item-id> --workflow-id <id> --config <file>
tychonic inbox dismiss <item-id> --workflow-id <id>
tychonic resume <session-id> --workflow-id <id> --prompt "..." --verify-command "..."
tychonic simple_workflow:continue --workflow-id <id> --max-iterations 5
```

`simple_workflow:continue` is the batch recovery path: it runs the full auto-continue
loop over every remaining open inbox item up to the given budget (default
5), reusing the workflow's captured start-time snapshot. Prefer it over
calling `inbox execute` once per finding.

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
not as something specific to `simpleWorkflow`. Track the proper product gap
separately.

## Agent Configuration

Each activity block runs an explicit `command`. The `agent` field is a
label for logs, sessions, and UI output; it does not select a built-in
provider adapter or generate provider-specific flags. There is no
standalone `agents.<name>` registration.

Allowed state-block orchestration fields are `sandbox`, `approval`,
`permission_mode`, and `trust_all_tools`. Vendor-owned pass-through
values such as `model`, `reasoning_effort`, `thinking_budget`,
`approval_mode`, `effort`, and `plan_mode_reasoning_effort` are not
valid config fields; put those flags directly in `command` or
`resume_command`.

## Permissions And Resume

Worker commands should be non-interactive and intended for isolated
worktrees. Put these provider flags directly in `command` when that
provider is used:

- Codex worker: `workspace-write`, approval `never`
- Claude worker: `--permission-mode dontAsk`
- Gemini worker: `--approval-mode yolo --sandbox`
- Kiro worker: `--trust-all-tools`

Reviewer commands should be more constrained:

- Codex reviewer: `read-only`, approval `never`
- Claude reviewer: `--permission-mode plan`
- Gemini and Kiro review commands must explicitly emit the review contract.

Worker resume uses an explicit `resume_command` stored on the Tychonic
session record. External session ids can be attached through
`tychonic sessions register`, but Tychonic does not infer provider-specific
resume commands from agent labels.

If no explicit `resume_command` is available, leave the worker session
non-resumable instead of attaching stale state.

## Verification

Verification splits along the worktree boundary:

- `npm run verify:worker` — typecheck, tests, build, example
  validation, guardrails. Safe to run inside an isolated worktree with
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
and may consume provider quota:

```sh
npm run verify:agents-live
TYCHONIC_LIVE_AGENTS=codex,claude npm run verify:agents-live
```

## Guardrails For Skill Use

- Read product state through Temporal APIs (`tychonic status`, `inbox`,
  `sessions`, `artifacts`, `logs`). Do not scan `.tychonic/runs` as state.
- Do not propose repo-local workflow state stores or new run databases.
- Keep any public-facing doc edits focused on product behavior; private
  operating notes belong in ignored `*.local.md` files.
- Run `npm run verify` before declaring a release-ready state.
