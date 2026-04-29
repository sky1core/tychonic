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
  -> Tychonic CLI or local Web UI/API
  -> Temporal workflow
  -> activities and adapters
  -> artifacts, findings, inbox items, session references
```

The product value is reliable orchestration of unreliable AI workers, not a new
coding model.

## Public Alpha Scope

Supported:

- macOS single-user local runtime
- host-native execution; running Tychonic itself inside Docker is not the public
  alpha default
- TypeScript product path
- Temporal managed-local mode and explicit external Temporal connection
- CLI as the primary machine interface
- local-only Web UI/API
- workflow config catalog plus runtime workflow module registry
- deterministic command activities for project checks through the `verify`
  activity TYPE
- structured reviewer contract `tychonic.review.v1`
- isolated worktree mutation path for workflows that run worker activities

Not supported:

- remote/team deployment
- multi-user or multi-tenant operation
- public network exposure of the Web API
- organization worker pools, team quota pooling, or task queue tenancy
- project working tree mutation by background automation
- unsafe auto-fix
- Tychonic-owned workflow DSL
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
- temporary worktrees
- Temporal managed-local runtime files
- rebuildable UI projections/caches

These files are evidence or runtime support files. They are not state authority.

## Workflow Model

Workflows are TypeScript Temporal workflow code. They invoke the
activity function for each state they enter, passing the state NAME
and the effective profile. They do not read YAML and they do not branch
on activity TYPE.

Configuration declares named state config blocks and named policies.
Configuration does not define workflow graphs, node order, edges,
join policies, arbitrary branching, new activity kinds, task queue
lifecycle, or local state storage.

Allowed configuration content:

- state config blocks keyed by state NAME (`states.<name>`), each
  carrying a `type` field that binds the state to an activity
  function and the settings that TYPE requires
- named policies (`policies.<name>`) for workflow-level orchestration
  knobs. The host config schema treats `policies` as an opaque object
  keyed by string; each workflow bundle defines, validates, and
  consumes the policy keys it cares about. Common bundle-defined keys
  include `policies.loop`, `policies.integration`, and
  `policies.interaction`.

Ordering, branching, loops, fan-out, joins, retry, and
multi-activity aggregation belong in Temporal workflow code. If a
project needs custom ordering, write or generate a compiled,
self-contained ESM workflow module that exports Temporal workflow
functions, install it into the runtime workflow module registry, and
make the relevant runtime load that registry through its documented
runtime path.

A workflow module's `defaultProfile` export pulls the state and policy
contract into the workflow code itself: it is the workflow's author-supplied
`TychonicConfig` that ships with the bundle and is validated once at install
time. Workflow start still validates the effective config under
`TychonicConfigSchema`.

### States And Activities

Tychonic separates the **workflow state machine** (runtime positions)
from the **backend activity** (code that executes work). These are
different categories. Every other term must reduce to one of them.

- **State** — a position in a workflow's state machine. Each state
  has a NAME (unique within the workflow run), a status drawn from
  `pending | running | succeeded | failed | skipped | blocked |
  timed_out`, attempts, and artifacts. An activity produces one or
  more states per invocation. The runtime record type is
  `WorkflowStateRecord` and the record array is `run.states[]`.
- **Activity** — a Temporal activity function registered on the
  Tychonic worker. State-producing TYPE activities are
  `runWorkerActivity`, `runVerifyActivity`, and `runReviewActivity`.
  An activity takes a
  state NAME as a parameter, reads the state config block under that
  NAME from the effective profile, validates that the block's `type`
  matches the activity's TYPE, runs its TYPE contract, and returns a
  `WorkflowRunDelta` plus TYPE-specific outcome fields. Temporal
  records each call as an activity task in workflow history.

NAME is a property of the state, not of the activity function. The
same activity function is called with many distinct state NAMEs per
run; the states those calls produce sit side by side in `run.states[]`.
TYPE is a property of both the activity function (fixed per function)
and each state config block (declared by the user so the schema
validator can accept or reject the block for that function).

No third concept exists at runtime. Terms like "step activity",
"workflow step", "named activity instance", or "activity binding" are
not product concepts; use "state" (machine position / record) or
"activity" (backend function) as appropriate.

### Activity Result And Evidence Invariants

The product run id is `WorkflowRunRecord.id`. Temporal workflow ids and
Temporal run ids are SDK identifiers; they are not the surfaced Tychonic run id
used for artifact paths, inbox references, or user-facing run records.

An activity that receives an existing `WorkflowRunRecord` treats `input.run` as
an immutable snapshot. It does not push into, splice, or otherwise mutate
`input.run.states`, `input.run.activity_attempts`, `input.run.artifacts`,
`input.run.findings`, `input.run.inbox`, or `input.run.agent_sessions`.
Filesystem writes are allowed activity effects, but the corresponding product
records must be returned through `WorkflowRunDelta` and TYPE-specific outcome
fields. Workflow code owns the live run record and applies returned deltas to
its own copy.

An activity invocation that starts a `WorkflowStateRecord` or an
`ActivityAttemptRecord` must return it in a terminal state before the activity
call completes. The workflow record must not contain activity-produced
`running` states or unfinished attempts after an activity result has been
merged. Review, worker, and deterministic command body invocations each
produce exactly one state record and one activity attempt record for that body
call; lifecycle or fact-gathering activities that do not enter a workflow state
return only run-level deltas.

External agent session references are evidence. When an external agent
invocation yields a session reference, the activity result records it as an
`AgentSessionRecord` and links the relevant attempt to that session.
`AgentSessionRecord.id` is that session reference. Tychonic does not store a
second session id beside it.

Activity-produced artifact records use the state NAME in their `kind` so the
artifact can be traced back without inspecting the file path. The kind format is
`<NAME>_<role>` (for example `<NAME>_prompt`, `<NAME>_output`,
`<NAME>_parsed`). The corresponding artifact file name is
`<kind>-<attemptId>.<ext>`. Run-level artifacts that are not produced by a
state attempt may use their own documented names.

Review TYPE maps reviewer execution and parse outcomes to state status as
follows:

| Outcome | State status |
| --- | --- |
| execution prevented by config or missing block | `skipped` |
| reviewer command exits non-zero | `failed` |
| reviewer command times out | `timed_out` |
| reviewer output is malformed for `tychonic.review.v1` | `blocked` |
| parsed `fail` verdict | `failed` |
| parsed `pass` verdict | `succeeded` |

Malformed reviewer output is never a pass. It must leave evidence for triage.
Review findings and triage inbox items are appended by workflow code after it
merges the review activity result; the shared activity body does not mutate the
caller-owned run record to add them.

Workflow activity proxies for state-producing activities use
`maximumAttempts: 1`. Retries that change product state belong in workflow code
with explicit state NAMEs, not in Temporal activity proxy retry.

### State Identity And Activity TYPE

A state and the activity it invokes share exactly two axes.

- **NAME** — a user-chosen identifier unique within the effective
  configuration. NAME belongs to the state: `state.name` on the
  runtime record equals the state NAME the workflow used when it
  invoked the activity, and equals the key under which the state's
  config block lives (`profile.states.<name>`).
- **TYPE** — a product-controlled label drawn from the fixed
  `ActivityTypeSchema` set (`work`, `verify`, `review`). TYPE selects
  the activity function the workflow must call for a given state, and
  the contract that activity runs.

Tychonic exposes one state-producing activity function per TYPE. An activity
accepts a state NAME as a parameter, never as a hardcoded identifier in its own
source. Workflow code owns every NAME literal that reaches an activity call
site. The same activity function is called any number of times per run with
distinct state NAMEs — a workflow that needs three reviews calls
`runReviewActivity` with three state NAMEs, and the configuration declares
three state config blocks of `type: review`.

A workflow never branches, retries, or aggregates based on TYPE.
TYPE exists only for schema validation (`type: review` rejects a
block that carries shell-command settings) and for binding a state
to its activity function. Any runtime behavior that depends on
which specific state to run must be expressed through the state
NAME the workflow passes to the activity call.

### Plugin Composition Path

A custom workflow is a bundle directory installed through the runtime
workflow module registry with `tychonic workflows install <directory>`. The
bundle's `workflow.mjs` composes exported activities in whatever order,
loop structure, or conditional shape its implementation needs, using NAME
literals it chooses, and exports a `defaultProfile` object that declares
the matching state blocks. No Tychonic source change is required to add a
new workflow, introduce a new NAME, or run the same TYPE any number of
times.

Adding a new TYPE (extending the product contract) does require a
Tychonic release and is explicitly out of scope for plugin authors.
Plugins consume the TYPE set Tychonic exposes.

## Workflow Modules

A workflow module is an installable **bundle directory** on disk. A bundle
holds exactly one workflow and the config that workflow needs to run.

The bundle contract is fixed:

- every bundle is a directory whose name **equals the name of the single
  workflow function it exports** — the same name users pass to `tychonic run
  <name>`. The name must match `^[A-Za-z0-9][A-Za-z0-9_.-]*$`. Bundle install
  rejects a bundle whose exported workflow function name differs from the
  directory name.
- every bundle contains `workflow.mjs`, a compiled ESM Temporal workflow
  module. It exports one workflow function per file (the function name is the
  workflow name users pass to `tychonic run <name>`) and a `defaultProfile`
  object (see below).
- a bundle may also be a normal package directory: `README.md`, `package.json`,
  lockfiles, `node_modules`, relative support modules, and pre-bundled assets
  are allowed.
  Dependencies are installed separately by the operator before
  `tychonic workflows install`; Tychonic copies the directory tree verbatim and
  does not run a package manager during install.

Bundles are installed with `tychonic workflows install <directory>`.
Installation copies the directory tree verbatim to
`<state>/workflows/modules/<name>/` where `<state>` is
`tychonicRuntimeDirs().stateDir` and validates the bundle (below). The
install command fails if another installed bundle already exports a workflow
function with the same name, or if two bundles would share the same directory
name.

`tychonic workflows remove <name>` deletes the installed bundle directory
from the same registry. On the operational service path, install and remove
also refresh the LaunchAgent worker when that worker is installed. Under an
isolated `--instance`, install and remove update only that instance's module
registry; the operator restarts that isolated runtime to load the change.
`tychonic service restart-worker` remains as an independent manual recovery
command for the operational service path.

The runtime workflow module registry is the set of installed bundle
directories. The worker loads every `<name>/workflow.mjs` under that
registry and rejects startup if two bundles contribute the same exported
workflow name. Bundle imports resolve through standard package resolution from
the installed bundle directory; Tychonic does not inject host package
`node_modules`, symlinks, or staging resolver state.

Tychonic ships **no** workflow bundles inside the host package. A fresh
`tychonic service install` produces an empty workflow module registry. The
operator installs whatever bundles the project needs — hand-authored, or
the example bundles under `examples/workflows/` — through `tychonic
workflows install <directory>`. There is no separate "built-in workflow"
execution path.

### Workflow-default profile

A bundle's `workflow.mjs` must export a `defaultProfile` object shaped like
a `TychonicConfig` (`version: "tychonic.config.v1"`) that declares the
`states.<name>` and `policies.<name>` blocks the workflow depends on:

```js
export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    work:   { type: "work",   command: "..." },
    verify: {
      type: "verify",
      command: `npm run typecheck
npm run build
npm test
npm run validate:examples`
    },
    review: {
      type: "review",
      agent: "claude"
    }
  },
  policies: { loop: { auto_continue: true, max_review_iterations: 3 } }
};
```

- `defaultProfile` must parse under `TychonicConfigSchema`. The same schema
  applies to bundle defaults and override files passed through
  `--config <file>`.
- `defaultProfile` is the workflow's author-supplied default profile. It
  travels with the bundle and is the value `tychonic run` injects into the
  workflow input's reserved `profile` field when no `--config <file>` override
  is passed.
- The state and policy contract for the workflow lives entirely in this
  one export. No separate manifest, schema file, or JSON companion file
  exists.

### Install-time validation

`tychonic workflows install <directory>` performs exactly these checks, in
order. Any failure aborts the install without touching the runtime modules
directory.

1. The source path is a directory.
2. The directory contains `workflow.mjs`.
3. `workflow.mjs` is parsed as an ES module AST without importing it,
   creating a staging directory, or symlinking `node_modules`. The static
   inspection must find at least one named workflow export (function) and
   exactly one `defaultProfile` export.
4. The exported workflow function name equals the bundle directory name.
5. The extracted `defaultProfile` parses under `TychonicConfigSchema`.
6. No other installed bundle exports the same workflow function name.

Validation runs once at install time. The worker and the workflow itself do
not re-run these checks at runtime. Runtime errors are limited to the
workflow-start schema validation performed by `TychonicConfigSchema` on the
effective profile; that contract is documented in "State Config Block
Contract".

## Configuration Model

A workflow bundle's `defaultProfile` export is the **default** source of
configuration for that workflow. A single `--config <file>` may replace it
for one run. There is no global configuration file, no repository
configuration file, no product-default configuration file, and no layered
merge pipeline.

Configuration has exactly two top-level groups. No others.

- `states.<name>` — state config blocks keyed by state NAME. Each block is
  fully self-contained and includes a mandatory `type` field that binds the
  state to an activity TYPE, the settings that TYPE requires, and any agent
  fields it needs (`agent`, `resume`, `command`, `sandbox`, `approval`,
  `permission_mode`, `trust_all_tools`, `timeout`).
- `policies.<name>` — workflow-level orchestration policies that are not
  per-state. The host config schema treats `policies` as an opaque
  object with string keys; each workflow bundle defines, validates, and
  consumes the policy keys it cares about. The example bundles under
  `examples/workflows/` use `policies.loop`, `policies.integration`,
  and `policies.interaction`; their
  shapes are documented in those bundles' READMEs.

There is no `agents.<name>` top-level, no `commands.<name>` top-level, no
`activity_timeouts.<name>` top-level, no `work` / `review` slot blocks, no
`profile` file concept, no `name` or `template` field in a config file.
Workflow selection is a CLI invocation argument, not a file field.

State NAMEs are arbitrary identifiers unique within the file. State config
block types are the fixed product-controlled set `work`, `verify`, and
`review`. Each TYPE has a documented contract for its activity's inputs and
outputs. The TYPE field exists for schema validation and for binding the state
to its activity function, not for orchestration. A workflow never branches,
retries, or selects states based on TYPE. See "Workflow Model → State Identity
And Activity TYPE" for the full NAME/TYPE contract.

Workflows reference states by NAME only. Retry, aggregation, and all other
multi-state orchestration live in the workflow's TypeScript code and use
explicit NAMEs for each call site.

### Bundle config is the default source

The default config for a workflow run is the workflow's `defaultProfile`
export, validated once at install time and again at workflow start by
`TychonicConfigSchema`. A caller may replace it for one invocation through
`--config <file>`. No other file — not a user home-directory config, not a
repository config, not a product-default config — is read, merged, or
consulted.

`tychonic run <name>` resolves the run's profile from exactly one config
source: the installed bundle's `defaultProfile`, or the whole-object
replacement file passed with `--config <file>`. Raw workflow input from
`--input` or `--input-file` must not include a top-level `profile` field;
that field is reserved for Tychonic's internal handoff of the effective
profile to workflow code. When raw workflow input is supplied, it must be a
JSON object so the reserved handoff can be attached without changing the
payload's category. Pulling the state and policy contract into the workflow
code itself keeps the contract single-sourced: a workflow author declares
state names, types, and policy blocks once, in one place, and the runtime
reads exactly that.

Two consequences follow and must both hold:

- Absent fields stay absent. Agent settings whose valid values are owned by
  the external CLI, such as `model` and `reasoning_effort`, appear only as
  state config fields documented below. They are recommended when
  repeatability or reasoning depth matters, but Tychonic never fills them with
  defaults and never validates the vendor's model catalog. If omitted, the
  generated command omits the corresponding CLI flag or config override.
- Product defaults are expressed in workflow code, not configuration.
  Invariants that must hold regardless of any bundle's `defaultProfile`
  (for example, per-TYPE command timeout defaults when a block omits
  `timeout`) are applied by the activity implementation or by the workflow
  module itself. They are not injected into the user-visible config.

### CLI overrides

Callers that need to override settings for a single workflow start may supply
a config file through `--config <file>` on `tychonic run`.

An override replaces the bundle's `defaultProfile` as a single whole object
for that one invocation. The override file is YAML or JSON text matching
the same `tychonic.config.v1` shape. There is no field-level merge, no
array merge, no per-block merge. If the override declares `states.<name>`,
the bundle's `states.<name>` is discarded entirely for that invocation —
the override must include every block the workflow needs.

An override never survives past the workflow start it was passed to. Running
workflows never re-read any config file.

### Immutability

At workflow start Tychonic loads the bundle's `defaultProfile`, optionally
replaces it whole with a CLI-override file, validates the resulting
`TychonicConfig`, and passes the parsed object into the Temporal workflow
input under the reserved `profile` field. Running workflows must not re-read
any config source for state decisions after start.

Each run records one `profile_snapshot.yaml` artifact so the effective
settings are reproducible evidence. No `profile_sources.json` artifact is
written — there is only one source, the bundle, and the snapshot itself is
sufficient.

## State Config Block Contract

Every state config block (`states.<name>`) is a self-contained unit:

```yaml
states:
  work:
    type: work
    agent: codex
    model: gpt-5.5
    reasoning_effort: xhigh
    resume: 3
    sandbox: workspace-write
    approval: never
    timeout: 30m
  primary_review:
    type: review
    agent: claude
    model: opus
    reasoning_effort: max
    permission_mode: plan
  kiro_review:
    type: review
    agent: kiro
    model: claude-sonnet-4.5
    normalizer: codex
  verify:
    type: verify
    command: |
      npm run typecheck
      npm run build
      npm test
      npm run validate:examples
    timeout: 15m
```

Rules:

- `type` is mandatory and must be one of the product-defined set. The
  current types are `work`, `verify`, and `review`.
  New types are added by releasing new product code, not by user
  declaration.
- The settings allowed in a block are the union of settings the type
  contract requires, recommended agent settings (`model`,
  `reasoning_effort` where supported), and orchestration values Tychonic owns
  (`resume`, `sandbox`, `approval`,
  `permission_mode`, `trust_all_tools`, `timeout`). Unknown fields are a
  validation error.
- `model` is valid only with `agent`. It selects the model for the primary
  built-in adapter when that CLI supports a model flag. Current built-in
  adapters `claude`, `codex`, `gemini`, and `kiro` all support it. Workflow
  authors should pin `model` for states whose quality, latency, or cost
  profile matters. Omitting `model` explicitly delegates model choice to the
  selected external CLI's default or auto-selection behavior. Tychonic passes
  the string through and does not maintain the vendor model list.
- `reasoning_effort` is valid only with `agent` when that CLI exposes a
  reasoning/effort surface. Current built-in support is `claude` and `codex`.
  Workflow authors should set it on Claude/Codex states whose quality depends
  on reasoning depth. Omitting it delegates to the external CLI's
  configured/default effort. Tychonic passes the string through and does not
  invent a default. `gemini` and `kiro` currently expose model selection but
  no stable reasoning/effort/thinking CLI option, so the schema rejects
  `reasoning_effort` for those agents.
- Allowed fields inside a state block are exactly `type`, `agent`,
  `normalizer`, `resume`, `command`, `model`, `reasoning_effort`, `timeout`,
  `sandbox`, `approval`, `permission_mode`, and `trust_all_tools`. Unknown
  fields are a validation error.
- `agent` is the primary input: it selects one of the built-in
  adapters (`claude`, `codex`, `gemini`, `kiro`). The host
  writes the CLI's `argv`, role-aware permission flags, and resume invocation
  where the selected adapter supports same-session resume.
- `normalizer` is review-only. It is required when `type: review` selects
  `agent: gemini` or `agent: kiro`, because those agents
  produce prose review output rather than the structured semantic payload the
  host can validate. The normalizer must be `claude` or `codex`, is prompted
  with only the primary review output, and emits the semantic review payload
  that the host normalizes into `tychonic.review.v1`. Normalizer model flag
  selection is host-owned: `normalizer: claude` passes `model: haiku`, and
  `normalizer: codex` passes `model: gpt-5.3-codex-spark`. Workflow config
  does not expose separate normalizer model or reasoning fields. Direct
  structured reviewers (`claude`, `codex`) and escape-hatch `command`
  reviewers must not set `normalizer`.
- `resume` is a non-negative integer (default `0`). It is a simple
  continuity budget a workflow may read when it explicitly chooses to
  continue an existing external agent session. `resume: 0` disables
  same-session continuation by convention. The host does not infer resume
  behavior from state TYPE, state NAME, `agent`, `command`, or the mere
  presence of this field; workflow code decides whether to call a
  resume-capable activity. When workflow code calls a built-in adapter
  resume path with a prior session id, Tychonic writes that adapter's
  resume invocation. On the escape-hatch `command` path, Tychonic does
  not synthesize resume behavior; the workflow or wrapper owns whatever
  custom session-continuation behavior it wants.
- `command` is the escape hatch: it runs the literal shell command
  verbatim and bypasses the adapter layer. Use it for non-default CLIs
  or unusual flag combinations. `agent` and `command` are mutually
  exclusive execution selectors; a state block must set exactly one of
  them when its TYPE requires an executable agent path.
- When a state config block omits `timeout`, Tychonic applies the
  per-TYPE default below. An explicit `timeout` on the block
  overrides that per-TYPE default.

  | Type | Default timeout |
  | --- | --- |
  | `verify` | 30 minutes |
  | `work` | 120 minutes |
  | `review` | 45 minutes |

  Temporal activity envelopes and worker drain defaults are
  intentionally more generous than these command defaults so
  long-running local checks can finish or hit their own configured
  timeout.
- Heartbeat timeout is a liveness contract, not a normal failure mode.
  Any activity that Temporal runs with a heartbeat timeout must send
  heartbeats for the full wall-clock lifetime of the activity, from
  command launch through output capture, artifact writes, session-id
  extraction, and every other post-processing step. This is especially
  required for long-running `work` and structured `review` activities.
- A healthy long-running activity may finish successfully, fail its
  command, or hit its configured command `timeout`. It must **not**
  fail merely because Tychonic stopped heartbeating while the underlying
  agent/process was still doing valid work. If an activity hits Temporal
  heartbeat timeout before its own command timeout, treat that as a
  product bug in Tychonic orchestration.
- Heartbeats must not depend on child-process stdout/stderr traffic.
  Silent-but-healthy commands, quiet model turns, and post-command
  bookkeeping still require periodic heartbeats. The heartbeat path must
  therefore be wired at the activity entrypoint and remain active even
  when the child emits no output.
- Multi-line commands run in fail-fast shell mode. If any line exits
  non-zero, the activity fails immediately and later lines do not run.
- State NAMEs are unique identifiers within the effective configuration.
  Workflow code calls activities by these state NAMEs. Two state
  config blocks with the same NAME is a validation error even if
  their TYPEs differ.

## Adapter Model

Tychonic ships **built-in adapters for the supported agent CLI paths**:
`claude`, `codex`, `gemini`, `kiro`. The host owns command
synthesis, session-id handling, agent-specific flags (permission, sandbox,
approval, trust), and resume semantics where the selected adapter supports
same-session resume. Workflow authors and operators select an adapter by
setting `agent: "<name>"` on a state block.

The default code path for every executable activity is **agent-driven**:

- `agent` selects a built-in adapter
- `resume` is a numeric option (default `0`) that a workflow may use as a
  same-session continuation budget. The host only writes a resume invocation
  when workflow code explicitly calls a resume-capable adapter path with a
  prior session id; it does not auto-resume by role, TYPE, NAME, or profile
  shape. The workflow owns the recovery path after that budget is exhausted
  and must expose it as part of that workflow's own contract.
- the host writes the actual `argv`, the resume flag where supported, the
  session-id round trip, and the role-aware permission flags

`command` is an **escape hatch** for non-default scenarios — a custom CLI not
in the built-in adapter set, an unusual flag combination, or a test stub. When
`command` is set, the host runs that command verbatim and skips the adapter
layer entirely; the workflow's resume bookkeeping does not apply because the
host has no way to know how the user's CLI handles session continuation.
That part is the user's responsibility.

`agent` and `command` are mutually exclusive execution selectors. The
state either runs through a built-in adapter (`agent`) or through an
explicit escape hatch (`command`). A block that sets both is invalid.

`resume_command` is **not a Tychonic concept**. Built-in adapters that support
same-session resume know their own resume invocation. An escape-hatch
`command` user who wants resume-aware behavior has to build that into their
own CLI wrapper — Tychonic core does not carry a separate resume-command field.

Activity call sites execute the one selector declared by the validated state
block: `command` runs the state-block escape hatch, and `agent` runs a
built-in adapter. Schema validation rejects a block that sets both selectors
or neither selector when its TYPE requires an executable agent path.

Workflow call inputs carry runtime data such as `prompt`, `worktreePath`,
`sessionId`, and `verificationCommands`. They do not carry `command` or
`agent`; execution selection belongs to `profile.states.<name>`.

### Built-in adapter coverage

The built-in adapters do not have identical capabilities:

- **claude**, **codex** — full coverage: new run, resume by session id,
  role-aware permission flags, and worker / reviewer roles.
- **kiro** — Kiro path through `kiro-cli acp`. Fresh runs call ACP
  `session/new`, store the returned `sessionId` as `AgentSessionRecord.id`,
  send the prompt through `session/prompt`, and resume through `session/load`.
  The adapter acts as the ACP client for the one workflow turn. Work states may
  use file and terminal client capabilities inside the workflow worktree.
  Review states may inspect files and run checks, but must not edit code: the
  review client does not advertise file-write capability, rejects direct
  `fs/write_text_file` requests, and fails the review if tracked files change
  during the turn. Tychonic must not infer identity from
  `kiro-cli chat --list-sessions` before/after diffs. Review states may use it
  only with `normalizer: claude` or `normalizer: codex`.
- **gemini** — worker and prose-review fresh-run coverage only. Review states
  may use it only with `normalizer: claude` or `normalizer: codex`.
  `runResume` throws `AdapterUnsupported` because
  `gemini --resume` takes a project-relative index rather than a stable
  session id.

The host schema rejects `agent: "gemini"` or `agent: "kiro"` on a
`type: "review"` state unless `normalizer` is
`claude` or `codex`. A custom `command` wrapper may still implement its own
review or continuation contract, but Tychonic does not synthesize adapter
normalization or resume behavior for the escape-hatch command path.

### Pass-Through Values vs Orchestration Values

Tychonic is an orchestrator for external agent CLIs. It must not bake in
defaults for settings whose authoritative source is the external CLI or its
provider.

**Rule:** if a supported built-in agent CLI exposes a model or reasoning
effort setting, Tychonic may expose the corresponding state config field as
an optional pass-through. Tychonic must not carry a system default for that
setting, must not maintain the vendor's valid-value catalog, and must omit
the downstream flag/config override when the field is absent. Escape-hatch
`command` states own their complete command string and do not use these
adapter fields.

- **Orchestration values** — settings Tychonic owns because they encode
  Tychonic's own isolation and safety contract. Role-aware defaults are
  allowed only when they are attached to an explicit adapter contract.
  Current config-field list: `sandbox`, `approval`, `permission_mode`, and
  `trust_all_tools`. The command shape itself (argv, stdin contract,
  resume flag where supported) is owned by the built-in adapter and by the
  operator for the escape-hatch `command` path.
- **Adapter pass-through values** — optional settings the built-in adapter
  maps directly to a verified CLI surface. Current fields are `model` and
  `reasoning_effort`. Unsupported vendor knobs such as `thinking_budget`,
  `approval_mode`, `effort`, and provider endpoints are not schema fields; use
  an escape-hatch `command` if a workflow must own such a command line before
  Tychonic has an explicit adapter contract.

Consequence: a new model name or renamed effort level on the external side
does not require a Tychonic schema change. The field remains a string and the
selected external CLI is the validator for its own value set.

Reviewer-capable adapters and reviewer-capable escape-hatch commands must
produce the shared `tychonic.review.v1` object documented under
"Structured Reviewer Contract".

## Structured Reviewer Contract

Structured review output has two layers:

- the **semantic review payload** the reviewer decides: `status`, `summary`,
  and `findings`
- the normalized **Tychonic wire result** the host records:
  `schema_version: "tychonic.review.v1"` plus that semantic payload

Built-in adapters must not make the model responsible for Tychonic bookkeeping
fields such as `schema_version`. The adapter may ask the model for the semantic
payload and then normalize it into the `tychonic.review.v1` wire result before
host validation. An escape-hatch `command` reviewer has no adapter-owned
normalization layer, so its stdout must emit the full `tychonic.review.v1`
wire result directly.

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

## Workflow Loop Semantics

Workflow loop shape — whether a workflow loops at all, how it caps that loop,
which activity it retries on review `fail`, and how it transitions to
`waiting_user` — is defined inside each bundle's `workflow.mjs`. This
section states only the host-side invariants every workflow must respect.
Per-workflow loop contracts (counters, signal payloads, inbox titles) live
in the bundle's `README.md`.

Host-side invariants:

- A workflow continuation appends new Temporal workflow history. It does not
  rewrite earlier attempts.
- Review findings must target the relevant prior activity attempt, file, or
  agent session when possible.
- Deterministic verification should run before semantic review when the
  deterministic check can cheaply reject bad work.
- Integration checks run only when configuration and policy allow it; skipped
  checks must record a reason.
- A `waiting_user` workflow run accepts operator-driven recovery only when
  the workflow registered the matching signal handler and the workflow start
  input opted into hold-open behavior. The `tychonic signal` CLI sends those
  signals; the bundle's README documents the signal name and payload shape.

### Interaction Signal Contract

Tychonic CLI exposes three convenience commands for workflows that choose to
register the standard interaction signal/query names:

- `tychonic approve <workflow-id> [--state <name>]`
- `tychonic reject <workflow-id> [--state <name>] --feedback <text>`
- `tychonic modify <workflow-id> [--state <name>] [--status <status>]
  [--reason <text>] [--note <text>] [--patch-file <path.json>]`

The signal/query names and payload shapes are host public surface because the
CLI sends them:

| CLI action | Temporal signal/query | Payload |
| --- | --- | --- |
| approve | `tychonic.interaction.approve_state` | `{ state: string }` |
| reject | `tychonic.interaction.reject_state` | `{ state: string, feedback: string }` |
| modify | `tychonic.interaction.modify_state` | `{ state: string, patch: StateRecordPatch }` |
| pending-state query | `tychonic.interaction.pending_state` | returns `string | undefined` |

`state` is always a non-empty state NAME. `reject.feedback` is a non-empty
string.

`StateRecordPatch` is an object with these optional fields:

- `status`: one of `succeeded`, `failed`, `skipped`, `blocked`, `timed_out`
- `reason`: string
- `note`: string
- `artifacts`: `ArtifactRecord[]`
- `findings`: `FindingRecord[]`

The CLI validates this payload before signaling. Workflow code must still
validate or reject incoming signal payloads because callers may bypass the CLI
with raw Temporal signals.

When `--state` is omitted, the CLI queries
`tychonic.interaction.pending_state`. If the workflow has not registered that
query, the query fails, or it returns no state, the CLI must fail with a clear
message and ask the operator to pass `--state` explicitly.

Registering these signal names is optional. A workflow that does not register
them is not interactive from the point of view of `tychonic approve`,
`tychonic reject`, and `tychonic modify`.

The host does **not** assign semantics to `policies.interaction` and does not
require a workflow to use any utility named `waitForStateApproval`.
`policies.interaction`, reject accumulation, per-state reject caps, signal
parking, and whether interaction replaces or composes with auto retry loops are
bundle-owned workflow contracts documented by the bundle that implements them.

### Agent session continuity

Agent session continuity is a host capability, not a host policy. Tychonic
exposes the activity layer needed for a workflow to resume the same external
agent session across iterations: `runWorkerActivity` accepts an explicit
`sessionId`, and the built-in adapter for that session's agent issues the CLI's
own resume invocation. A workflow that wants same-session continuity calls
`runWorkerActivity` with the prior session id; a workflow that wants a fresh
session omits `sessionId`. When a given agent CLI cannot expose a durable
session reference (for example the partial gemini adapter), the activity
records the session as non-resumable evidence.

`states.<name>.resume` (non-negative integer, default `0`) is the optional
budget for that explicit continuation path. Omitted or `0` means no
same-session continuation budget. The host does not attach resume semantics
to any state NAME or role. When the budget is exhausted, the workflow decides
its own recovery path and documents that behavior in the bundle's README.

### Integration policy

`policies.integration` is bundle-owned workflow policy. The host schema treats
it as opaque data and does not assign integration behavior.

The checkpoint example uses only `policies.integration.position`:

- `before_ai_review`: run before semantic review
- `after_ai_review`: defer until after semantic review
- `final_gate`: run after a workflow's review loop as the final gate

A workflow that uses this policy reads `profile.policies.integration.position`
and routes its own integration state NAME to `runVerifyActivity` accordingly.
Other workflows may define a different `policies.integration` shape, but they
must document and validate the keys they consume.

## Runtime

Runtime modes:

- `managed-local`: Tychonic starts or reuses local Temporal and runs the worker
  either in the foreground or through macOS LaunchAgents.
- `external`: the user provides Temporal address, namespace, and task queue for
  an explicitly configured single-user runtime. This does not make remote/team
  deployment part of the public alpha scope.

Both modes use Temporal APIs for state. Tychonic never reads Temporal persistence
files directly.

LaunchAgent service mode must run from an installed package build by default,
not a mutable source checkout. Agent CLI discovery must use the deterministic
resolver used by both foreground and service mode.

Managed-local Temporal persistence and process files are Temporal-owned runtime
files. macOS defaults are:

- state: `~/Library/Application Support/Tychonic`
- logs: `~/Library/Logs/Tychonic`
- LaunchAgents: `~/Library/LaunchAgents/com.tychonic.*.plist`

Project `.tychonic/` files may hold artifacts, live output, patches, temporary
worktrees, and rebuildable projections. They must not become workflow state
databases.

### Isolated dev instances

Tychonic's local runtime supports **named isolated instances** for workflow
development and integration smokes. An instance is a deterministic derivation
of the operational runtime paths and Temporal connection parameters from a
single name. It is not a new domain concept: the operational runtime has no
named instance, and Temporal workflow history remains the sole Source Of
Truth. The name `instance` is chosen to avoid collision with `profile`
(already used for workflow configuration snapshots), `namespace` (the
Temporal logical isolation unit), and `environment` (which would imply a
deployment pipeline not present in this single-user product).

An instance is activated by `--instance <name>` on any Tychonic CLI command,
or by `TYCHONIC_INSTANCE=<name>` in the shell environment. When both are set,
`--instance` wins. When neither is set, the command targets the operational
paths.

Instance names must match `^[a-z][a-z0-9-]{0,31}$`. The names `default`,
`prod`, `production`, and `service` are reserved and rejected. The allowed
character set is the intersection of what is safe inside filesystem paths,
launchd labels, and Temporal task-queue identifiers.

When an instance is active, Tychonic derives the following values from
`<name>` and uses them in place of the operational defaults:

| Value | Operational default | Instance-active |
| --- | --- | --- |
| state dir | `tychonicRuntimeDirs().stateDir` | `<default-state>/instances/<name>` |
| log dir | `tychonicRuntimeDirs().logDir` | `<default-log>/instances/<name>` |
| Temporal DB / PID / runtime files | under the state dir | under the instance state dir (derivation propagates) |
| Temporal API port | `7233` | `17000 + fnv1a32(<name>) mod 1000` |
| Temporal address | `127.0.0.1:7233` | `127.0.0.1:<derived API port>` |
| Temporal namespace | `default` | `default` (unchanged — the DB file is already separate) |
| Temporal task queue | `tychonic` | `tychonic-<name>` |
| workflow module registry | `<state>/workflows/modules/` | `<instance-state>/workflows/modules/` (state dir derivation propagates) |
| web server port | `8765` | `18000 + fnv1a32(<name>) mod 1000` |

Instance activation never creates a registry file, an entry in a global
index, or any other secondary record of the instance's existence. The
presence of `<default-state>/instances/<name>/` is the only artifact; nothing
else tracks which instances have ever been used.

Explicit overrides still win over instance-derived values at the field level.
The field-level precedence is **explicit > instance-derived > operational
default**, applied independently to each of:

- `--temporal-mode`, `--temporal-port`, `--temporal-address`,
  `--temporal-task-queue`, `--temporal-namespace`
- `$TYCHONIC_STATE_HOME`, `$TYCHONIC_LOG_HOME`
- the web server port

This is the same replace-not-merge precedence that applies between a bundle's
`defaultProfile` and `--config <file>`, scoped to a single CLI invocation. There
is no block-level replacement and no implicit merging across fields. When
`$TYCHONIC_STATE_HOME` or `$TYCHONIC_LOG_HOME` is set while an instance is
active, the explicit env value wins and Tychonic emits a warning on stderr
identifying which instance-derived path was overridden.

Operational launchd services (`com.tychonic.temporal`, `com.tychonic.worker`,
`com.tychonic.web`) are not touched by any command run under an instance.
The `service` command group (`service install`, `service status`,
`service uninstall`, `service restart-worker`, `service terminate-worker`)
rejects invocation while an instance is active. `workflows install <bundle>`
and `workflows remove` under an instance copy or delete bundle files in the
instance's module registry only — they never replace a LaunchAgent worker,
and the command output carries a note instructing the operator to restart
`tychonic runtime up --instance <name>` to pick up the change.

**Bundle registry starts empty.** A fresh instance has no workflow bundles.
`service install` is rejected under an instance, and the operational path
itself ships no bundled workflows: every bundle reaches the registry through
`tychonic workflows install <directory>`. The operator therefore calls
`tychonic workflows install <directory> --instance <name>` for every bundle
the instance needs (for example, any directory under `examples/workflows/`,
or a hand-authored bundle). Tychonic makes no distinction between sources;
all bundles flow through the same install path. `runtime up --instance
<name>` refuses to start (both foreground and `--detach`) when the
instance's module registry is empty, so the operator gets the correct
guidance to install the bundles they need instead of a detached child that
dies silently a few seconds after reporting a PID.

Lifecycle commands:

- `tychonic runtime up --instance <name>` — starts Temporal if needed and
  runs the worker (and, by default, the web server) in the foreground. It
  records the runtime parent PID in `<instance-state>/runtime.pid` and removes
  that PID file on normal process exit when it still owns the file.
- `tychonic runtime up --instance <name> --detach` — spawns the same runtime
  in a new session and exits. Writes the child PID to
  `<instance-state>/runtime.pid` and appends stdout/stderr into
  `<instance-log>/runtime.log`. Requires `--instance`; `--detach` is not
  available on the operational path. If a live PID already occupies the
  PID file, the command refuses rather than overwriting it.
- `tychonic runtime stop --instance <name>` — sends SIGTERM to the runtime
  PID recorded in `<instance-state>/runtime.pid`, waits for it to exit, removes
  only that PID file, and then asks the same instance's managed-local Temporal
  process to stop if one remains. It never escalates to SIGKILL and never
  removes state or log directories. If the runtime process remains alive, the
  command reports timeout instead of forcing cleanup.
- `tychonic workflows install <bundle> --instance <name>` — copies the
  bundle into `<instance-state>/workflows/modules/<name>/`. Does not call
  any launchd operation. The JSON response includes a note that the
  operator must restart `runtime up --instance <name>` for the worker to
  load the new bundle.
- `tychonic runtime reset --instance <name>` — terminates any runtime
  recorded in the instance PID file (SIGTERM, 10 second wait,
  SIGKILL), then removes `<instance-state>/` and `<instance-log>/`.
  Rejects invocation without `--instance`; operational paths are never
  reset through this command. Without `--yes`, it prints the paths it is
  about to remove and reads a confirmation from stdin. AI agents pass
  `--yes` for non-interactive cleanup.

Instance isolation changes only the runtime directory layout and the
Temporal connection parameters the CLI generates. It does not change the
bundle configuration schema, the workflow code, the workflow configuration
snapshot, or the rule that Temporal workflow history is the sole Source Of
Truth. The instance's Temporal DB file is a different file on disk from the
operational DB, and the two catalogues do not share workflow identities even
when both use the `default` namespace.

The derivation uses standard mechanisms only: existing `TYCHONIC_STATE_HOME`
and `TYCHONIC_LOG_HOME` env rules, the commander program's global option and
`preAction` hook, the Temporal CLI's existing port and namespace flags, and
POSIX `start_new_session` for `--detach`. No staging directory, symlink
array, or private node_modules layout is introduced for instance resolution.

### Bundle layout on disk

Installed workflow bundles live under
`<state>/workflows/modules/<name>/`, where `<state>` is
`tychonicRuntimeDirs().stateDir` (macOS default:
`~/Library/Application Support/Tychonic`).

Each bundle directory contains at minimum:

- `workflow.mjs`

It may also contain `README.md`, `package.json`, lockfiles, `node_modules`,
relative support modules, and pre-bundled assets. This mirrors the install-time bundle
contract in "Workflow Modules": dependencies resolve through the installed
bundle directory's standard package layout. Tychonic does not add host
`node_modules`, symlinks, or private resolver state when the worker bundles
installed workflows.

## Verification Boundary

Verification splits along the worktree boundary. Worker activities run
in an isolated worktree and must only perform checks that complete
inside that worktree. Release-gate checks that require external network
or machine state belong on the operator side, after the operator applies
a patch to the source tree.

- **Worker-side verification** (`npm run verify:worker`): typecheck,
  unit tests, build, and example validation. Runs
  end-to-end without network access and without touching the user's
  machine-level state.
- **Release verification** (`npm run verify`): extends worker-side with
  `npm audit`, `npm publish --dry-run`, and the package smoke install.
  These steps require network access to the public registry and are
  only meaningful against the applied source tree; they are not
  attempted inside the worker sandbox.

Worker instructions must reference `verify:worker` as the in-sandbox
gate. Calling the full `verify` command from a worker activity is a
contract violation — the sandbox cannot satisfy it, and workarounds
(conditional skips, offline shims, silenced registry failures)
weaken the release gate. If a check cannot run inside the worker, the
product splits the check into worker and operator variants with
distinct names; it never makes a required gate conditional on the
environment.

## Implementation Language

The active product path is TypeScript.

The Tychonic package itself — CLI, local Web API, built-in Temporal
workflow activities, bundle config schema, adapters — stays in one
TypeScript package and type system.

Operator-authored workflow bundles (`workflow.mjs`, documented in
`docs/plugin-workflows.md`) are written in JavaScript (ESM) so Temporal's
workflow sandbox can consume them directly without a TypeScript build
step. Bundles are a first-class product surface and are not covered by
this "TypeScript-only" rule.

Non-TypeScript Temporal SDK bindings (Go, Python, Java) are not part
of the current product path.
