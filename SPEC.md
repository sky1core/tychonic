# Tychonic SPEC

## Definition

Tychonic is a macOS-local AI work operations manager. It does not replace a
foreground coding agent. It runs existing agent CLIs, deterministic checks, and
review tools through Temporal so a user can delegate work, inspect evidence,
resume sessions, and continue workflow review loops from a durable local state
machine.

Core idea:

```text
User / foreground agent
  -> Tychonic CLI
  -> Temporal workflow
  -> activities and adapters
  -> artifacts, findings, inbox items, session references
```

The product value is reliable orchestration of unreliable AI workers, not a new
coding model.

The local status UI is an operator view over the same Temporal-backed workflow
status and evidence summaries exposed by `tychonic status`. It is local-only and
does not make Tychonic a remote service, public API, dashboard product, or
team/multi-user system.

## Public Alpha Scope

Supported:

- macOS single-user local runtime
- host-native execution; running Tychonic itself inside Docker is not the public
  alpha default
- TypeScript product path
- Temporal managed-local mode and explicit external Temporal connection
- CLI as the primary machine interface
- local-only workflow status UI served by `tychonic web`
- workflow config catalog plus runtime workflow module registry
- deterministic command activities for project checks through the `verify`
  activity TYPE
- structured reviewer contract `tychonic.review.v1`
- isolated worktree mutation path for workflows that run worker activities

Not supported:

- remote/team deployment
- multi-user or multi-tenant operation
- public Web UI/API product surface
- organization worker pools, team quota pooling, or task queue tenancy
- project working tree mutation by background automation
- unsafe auto-fix
- full native desktop app
- automatic issue/webhook processing
- secret proxying or credential brokering
- Docker Compose/PostgreSQL product deployment

## Source Of Truth

Temporal is the only source of truth for product state.

Workflow/run/step/activity/inbox/finding/session/resume/review-loop/retry/cancel
state must live in Temporal workflow history and Temporal APIs. Tychonic must not
create repo-local state databases, lock files, local inbox/session registries, or
stale-run recovery stores.

Allowed local files:

- logs
- artifacts
- live output
- patches
- isolated worktrees (preserved on finish; operator-removable)
- Temporal managed-local runtime files

These files are evidence or runtime support files. They are not state authority.
Tychonic-owned artifacts, live output, patches, and isolated worktrees must
live under Tychonic-owned user-home or runtime directories, not inside the
target repository. A target repository must not receive a repo-local `.tychonic`
directory as a Tychonic byproduct of running workflows.

Isolated worktrees are created under
`~/.tychonic/worktrees/<operational|instances/<name>>/tychonic-worktree-<runId>-<suffix>/worktree`.
They are not removed by any workflow finish path. On workflow finish, the
generated wrapper captures a `worktree_patch` artifact snapshot of the agent's
changes and leaves the worktree directory in place so the operator can inspect,
hand-apply, or remove it with standard tools (`git worktree remove`, `trash`,
`rm`). The worktree path is preserved in the workflow result and is visible
through `tychonic status --workflow-id <id> --include-result`.

## Module SPECs

This root `SPEC.md` and the module `SPEC.md` files below are one product
contract. The root file states cross-module product boundaries. A module file
states the contract for code in that folder.

Code follows the nearest applicable module `SPEC.md` and this root file. A
module `SPEC.md` may narrow or detail the contract for its folder, but it must
not contradict this root file.

| Scope | Contract |
| --- | --- |
| workflow helper code | [src/workflows/SPEC.md](src/workflows/SPEC.md) |
| domain records and deltas | [src/domain/SPEC.md](src/domain/SPEC.md) |
| activity contracts | [src/activities/SPEC.md](src/activities/SPEC.md) |
| shared activity bodies and command runner | [src/bootstrap/SPEC.md](src/bootstrap/SPEC.md) |
| workflow bundle registry and Temporal loading | [src/temporal/SPEC.md](src/temporal/SPEC.md) |
| config schema and profile loading | [src/catalog/SPEC.md](src/catalog/SPEC.md) |
| contract checker gates | [src/contracts/SPEC.md](src/contracts/SPEC.md) |
| built-in agent adapters | [src/adapters/SPEC.md](src/adapters/SPEC.md) |
| structured review parsing and schema | [src/review/SPEC.md](src/review/SPEC.md) |
| interaction signal payload validation | [src/interaction/SPEC.md](src/interaction/SPEC.md) |
| CLI public surface | [src/cli/SPEC.md](src/cli/SPEC.md) |
| local runtime operations | [src/runtime/SPEC.md](src/runtime/SPEC.md) |
| launchd service helpers | [src/service/SPEC.md](src/service/SPEC.md) |
| artifact file storage | [src/storage/SPEC.md](src/storage/SPEC.md) |
| local workflow status UI | [src/web/SPEC.md](src/web/SPEC.md) |
| reference workflow examples | [examples/workflows/SPEC.md](examples/workflows/SPEC.md) |

## Product Boundaries

Tychonic uses **Temporal only** for state management. The only source of truth
for product state is Temporal workflow history and the Temporal API.

The active product path is TypeScript: CLI, Temporal workflows, configuration
schema, agent adapters, and tests stay in one TypeScript package and type
system.

Workflow behavior runs as Temporal workflow code generated from declarative
`workflow.yaml` bundle source. Install validates the YAML and generates
explicit Temporal `workflow.mjs` wrappers. Hand-written `workflow.mjs` is not
an operator-authored bundle entrypoint. Runtime configuration declares named
`states.<name>` blocks and named `policies.<name>` values. It does not define
workflow graphs, ordering, branching, fan-out, joins, or loops. Each `review`
state block must explicitly declare `on_fail_return_to`, naming the non-review
state that receives failed review feedback when the workflow loops. Declarative
YAML wrappers generated at install time append failed review summaries and
structured findings to that declared return state's next prompt when the return
state is prompt-bearing.

Tychonic core contains **zero workflow modules**. Workflows are user-supplied
bundles installed via `tychonic workflows install`. Reference examples under
`examples/workflows/` are opt-in bundle sources, not host defaults.

Users select supported agent CLIs through state config `agent` labels:
`claude`, `codex`, `gemini`, and `kiro`. Hand-written `command` values are an
escape hatch for non-default execution paths.

Public workflow run input must not require callers to memorize workflow-internal
prompt fields. Public top-level input fields are required `cwd`, optional
`goal`, and optional `promptAdditions` only when the workflow explicitly
supports additive per-state prompt instructions. Declarative `workflow.yaml`
prompt text may reference the explicit `{{goal}}` variable; unknown prompt
variables are install-time validation errors.

## Cross-Module Invariants

Every contributor needs these invariants before reading a narrower module
SPEC:

- **State NAME and activity TYPE are different axes.** Workflow code owns state
  NAMEs and calls activities by NAME. TYPE only binds a state config block to
  the activity contract (`work`, `verify`, `review`) and must not drive
  branching, retry, aggregation, or candidate rotation.
- **Runtime configuration is data; workflow source owns orchestration.**
  Runtime configuration declares `states.<name>` blocks and workflow-owned
  `policies.<name>` values. Workflow graphs, loops, ordering, joins, and retry
  decisions live in `workflow.yaml`, which is translated into explicit Temporal
  workflow code at install time. A
  `review` state's `on_fail_return_to` is the required declared failure
  destination for review-loop feedback. The destination must be a non-review
  state; it is not a runtime config graph DSL. In generated YAML workflows,
  failed review summaries and structured findings are carried into that
  destination state's next prompt when the destination is prompt-bearing.
- **Config sources replace, not merge.** A bundle's `defaultProfile` is the
  default source. `--config <file>` replaces it as one whole object for that
  run. No field merge, deep merge, array merge, implicit inheritance, or hidden
  preset fill is allowed.
- **Run input is narrow and stable.** Public top-level workflow input is
  `cwd`, optional `goal`, and optional `promptAdditions`. `promptAdditions`
  keys are auto-derived from the effective profile (states with type `work` or
  `review`). Declarative prompts may explicitly render `{{goal}}`; unknown
  prompt variables are rejected during install. `profile` is reserved for
  Tychonic's internal handoff.
- **Run preflight happens before Temporal start.** `tychonic run` validates the
  standard workflow input contract before starting a Temporal workflow. Invalid
  input must not enter a Temporal workflow task retry loop.
- **Recoverable state failure stays rerunnable.** When a state-producing
  activity fails, times out, or blocks because of an external/transient problem,
  the workflow must preserve the failed state evidence and keep an explicit
  recovery path that can rerun that state later in the same Temporal workflow
  execution. Rerun appends history and records; it never rewrites the failed
  attempt.
- **Activities return deltas and evidence.** Activity bodies do not mutate
  `input.run`. They return `WorkflowRunDelta` plus TYPE-specific outcome
  records; workflow code owns the live run record and applies those results.
- **Adapter-owned values pass through.** Model names, reasoning effort, and
  similar external CLI values have no Tychonic default catalog. If omitted,
  Tychonic omits the downstream flag or config override.
- **Reference workflows are examples, not defaults.** No workflow is built into
  core. Every workflow reaches the runtime registry through
  `tychonic workflows install`.

## Implementation Language

The active product path is TypeScript.

The Tychonic package itself — CLI, built-in Temporal workflow activities, bundle
config schema, adapters — stays in one TypeScript package and type system.

Operator-authored workflow bundles are declarative `workflow.yaml` files,
documented in `docs/plugin-workflows.md`. YAML bundles are translated to
JavaScript ESM during install so Temporal's workflow sandbox consumes generated
`workflow.mjs`. Bundles are a first-class product surface and are not covered
by this "TypeScript-only" rule.

Non-TypeScript Temporal SDK bindings (Go, Python, Java) are not part of the
current product path.
