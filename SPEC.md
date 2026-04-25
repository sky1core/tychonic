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
  -> Tychonic CLI or local operator surface
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
- localhost-only Web API and experimental local operator surface
- workflow config catalog plus runtime workflow module registry
- deterministic command activities for lint, unit, integration, verify, and
  similar project checks
- structured reviewer contract `tychonic.review.v1`
- isolated worktree mutation path for `simpleWorkflow`

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
and the merged profile. They do not read YAML and they do not branch
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
  knobs such as `policies.loop` and `policies.integration`

Ordering, branching, loops, fan-out, joins, candidate retry, and
multi-activity aggregation belong in Temporal workflow code. If a
project needs custom ordering, write or generate a compiled,
self-contained ESM workflow module that exports Temporal workflow
functions, install it into the runtime workflow module registry, and
replace the worker process.

A workflow module's `requires.states` export is the declarative contract
for which state NAMEs and TYPEs the workflow needs. It is validated once at
install time against the bundle's `config.yaml`. Missing or mistyped state
config blocks fail at install, not at workflow start; workflow start still
validates the config under `TychonicConfigSchema` but does not re-run the
`requires` cross-check.

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
  Tychonic worker. One activity exists per TYPE
  (`runReviewActivity`, `runLintActivity`, ...). An activity takes a
  state NAME as a parameter, reads the state config block under that
  NAME from the merged profile, validates that the block's `type`
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

### State Identity And Activity TYPE

A state and the activity it invokes share exactly two axes.

- **NAME** — a user-chosen identifier unique within the merged
  configuration. NAME belongs to the state: `state.name` on the
  runtime record equals the state NAME the workflow used when it
  invoked the activity, and equals the key under which the state's
  config block lives (`profile.states.<name>`).
- **TYPE** — a product-controlled label drawn from the fixed
  `ActivityTypeSchema` set (`lint`, `unit_test`, `integration`,
  `work`, `verify`, `review`, `auto_continue`, and
  similar as the catalog grows). TYPE selects the activity function
  the workflow must call for a given state, and the contract that
  activity runs.

Tychonic registers one activity per TYPE. An activity accepts a
state NAME as a parameter, never as a hardcoded identifier in its
own source. Workflow code owns every NAME literal that reaches an
activity call site. The same activity function is called any number
of times per run with distinct state NAMEs — a workflow that needs
three reviews calls `runReviewActivity` with three state NAMEs, and
the configuration declares three state config blocks of `type:
review`.

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
literals it chooses. The bundle's `config.yaml` declares the matching
state blocks. No Tychonic source change is required to add a new workflow,
introduce a new NAME, or run the same TYPE any number of times.

Adding a new TYPE (extending the product contract) does require a
Tychonic release and is explicitly out of scope for plugin authors.
Plugins consume the TYPE set Tychonic exposes.

**Plugin dependency resolution.** A plugin module imports
`proxyActivities` (and any other Temporal workflow helpers) from
`@temporalio/workflow`. Tychonic's worker bundler adds the Tychonic
package's own `node_modules` to the webpack resolver so the plugin
file — which lives under
`~/Library/Application Support/Tychonic/workflows/modules/` where no
local `node_modules` exists — can resolve that import without
shipping its own dependencies. Plugin authors write a bundle directory
containing a single ESM `workflow.mjs` file and install it with
`tychonic workflows install <directory>`; they do not bundle, symlink,
or vendor `@temporalio/workflow`. The
implementation lives in `src/temporal/worker.ts` (`buildWorkflowBundle`
/ `tychonicWebpackResolveDirs`).

Transitive dependencies on other packages the plugin author adds
(for example, a JSON schema library) are currently not auto-resolved;
plugins that need extra runtime libraries must pre-bundle those
libraries into the installed `.mjs` file.

**Authoring guide.** `docs/plugin-workflows.md` covers quick start,
the registered activity set, `ActivityInput` / `ActivityResult`
shape, how to merge activity results without mutating the run,
workflow sandbox constraints, and how to start a plugin workflow
from `@temporalio/client` or `temporal workflow start`.
`examples/pipeline-7stage.plugin.mjs` is a self-contained working
example that exercises the activity set with two review-TYPE
instances (`review_1`, `review_2`) sharing the same
`runReviewActivity` function.

### `waitForStateApproval`

Tychonic exposes a shared workflow helper
`waitForStateApproval(stateName: string): Promise<ApprovalDecision>`
that product workflows (`simpleWorkflow`, `checkpointWorkflow`,
`selfRepairWorkflow`) and plugin workflows call after every activity call
they want to be gatable. It is the sole mechanism by which
`policies.interaction.mode: "interactive"` takes effect. A plugin that
does not call the hook stays auto-only even under `mode: "interactive"`;
this is deliberate — interactive is opt-in at the call-site level, not a
silent wrapper around arbitrary external code.

Contract:

- At workflow start, the hook reads the run's
  `policies.interaction.mode` from the start-time snapshot exactly once
  and caches the decision. Re-reading on every call is a bug.
- When `mode` is `"auto"` (including the absent-block case) the hook
  returns `{ kind: "approve" }` immediately. No signal wait, no Temporal
  timer, no history event.
- When `mode` is `"interactive"` the hook suspends until exactly one of
  three signals is received whose payload targets the supplied
  `stateName`:
  - `approveState({ state })` → `{ kind: "approve" }`
  - `rejectState({ state, feedback })` → `{ kind: "reject", feedback }`
  - `modifyState({ state, patch })` → `{ kind: "modify", patch }`
- Signals that target a different state name than the one currently
  awaited are parked on an in-workflow queue and replayed when that
  state's hook runs. A stale signal (no future hook call will match) is
  evidence of caller error; the workflow records a `waiting_user` inbox
  item describing the stray signal and otherwise ignores it.
- The hook does not apply the decision. The calling workflow receives
  the `ApprovalDecision` return value and acts on it. This keeps the
  mutation path explicit at the workflow call site.

`ApprovalDecision` is the discriminated union:

```ts
type StateRecordPatch = {
  status?: WorkflowStateStatus; // must end terminal after overlay
  reason?: string;
  note?: string;                // appended to existing reason
  artifacts?: ArtifactRecord[]; // appended to state + run
  findings?: FindingRecord[];   // appended to state + run
};

type ApprovalDecision =
  | { kind: "approve" }
  | { kind: "reject"; feedback: string }
  | { kind: "modify"; patch: StateRecordPatch };
```

Caller responsibility:

- `approve`: continue to the next state.
- `reject`: re-run the state that just finished, with `feedback` supplied
  to the next attempt's prompt or command contract in a workflow-defined
  way. Reject feedback **accumulates** across iterations: the caller
  carries the full list and passes every prior feedback entry to the
  next attempt (the simpleWorkflow appends each as a synthetic review
  finding; plugins compose them into the next prompt). The caller also
  bumps a per-state reject counter; when the counter reaches
  `policies.interaction.max_reject_iterations`, the caller promotes the
  state to `waiting_user` and stops calling the hook for that state.
- `modify`: overlay the `StateRecordPatch` onto the most recent
  `WorkflowStateRecord` with `name === stateName` in `run.states`, then
  continue to the next state. The patch is an overlay, not a
  replacement:
  - `status`, `reason`, `note` update the latest state record
    (`note` is appended to existing `reason` as
    `"<reason> — note: <note>"`, or becomes `reason` if none existed).
  - `artifacts` / `findings` are appended to both the state record's
    id lists and to the run-level `run.artifacts` / `run.findings`.
  - The state record's `id`, `activity_attempt_ids`, and timestamps are
    preserved. Callers do not supply them.
  - If no state with the requested `name` has run yet, the caller
    throws. Resulting status must be terminal.

The overlay-on-modify path is **not** an activity-level mutation;
the activity that produced the original state record still satisfies
"Activity never mutates input.run". Modifications are expressed in the
caller's post-activity merge step, exactly like the existing
`applyActivityResult` merge that the workflow already runs on every
activity return.

History evidence:

- Each signal delivery is already recorded by Temporal as a workflow
  history event. No additional recording is required for approve /
  reject / modify beyond the signal payload itself.
- Reject feedback is persisted as an artifact of the immediately-next
  activity attempt (`state-<name>-reject-feedback-<attemptN>.txt`) so
  the attempt that follows a reject can be read end-to-end from its
  own artifact manifest.

### Activity Invariants

Every TYPE-per-activity call must satisfy the following invariants.
Deviations are bugs, not design choices. These are the semantics a
delegation brief references (principle 12) instead of re-describing.

**Run identity.**
Tychonic's `WorkflowRunRecord.id` is the sole run identifier surfaced
across the system. It governs filesystem layout (`.tychonic/runs/<id>/`
and `.tychonic/worktrees/<id>/`), inbox references, finding and
attempt linkage, artifact paths, and cross-activity joins. Temporal's
workflow and run ids are SDK concerns; an activity that needs them
reads `Context.current().info.{workflowId,runId}` locally. The
activity input shape therefore does not carry a separate
`workflowRunId` field: every call receives `run` and reads `run.id`.

**No source mutation.**
An activity never mutates `input.run`. Mutations are expressed as a
`WorkflowRunDelta` in the return value. The caller merges the delta
into its own run copy (workflow state, an existing runner's context,
or a test shim). Activities that need to add `artifact`, `finding`,
`inbox_item`, or `agent_session` objects return them through their
TYPE-specific result fields and the caller appends them to the
matching arrays on the run record — those object arrays are not part
of `WorkflowRunDelta` at stage 1.

**State lifecycle.**
Each activity call produces at least one state (`WorkflowStateRecord`)
and must finalize every state it starts. A state leaves the activity
in a terminal status (`succeeded`, `failed`, `skipped`, `blocked`, or
`timed_out`) with `finished_at` set. A state in `running` on return is
a bug regardless of the outcome the activity otherwise reports.

**Attempt lifecycle.**
Attempts mirror state lifecycle. Every `ActivityAttemptRecord` the
activity creates with `startAttempt` ends with `finishAttempt` before
the activity returns. The record shape (`type`, `cwd`, `command`,
`timeoutMs`, `exitCode`, `status`, `reason`, `live_output_path`) is
fixed by the shared helpers; activities must not invent new fields or
rename existing ones.

**Artifact filenames.**
Every artifact an activity writes through `RunArtifactStore` uses the
filename `<kind>-<attemptId>.<ext>`, where `<attemptId>` is the
`ActivityAttemptRecord.id` of the attempt that produced the artifact
and `<kind>` follows the rule below. Single-attempt activities receive
no shorter form; the attempt id is always present. Overwriting a
prior attempt's artifact is a regression.

**Artifact kinds.**
Artifact kinds follow the pattern `<NAME>_<role>`, where `<NAME>` is
the state NAME the activity call received with every underscore
preserved, and `<role>` is one of the fixed set tied to the TYPE's
contract (e.g. `prompt`, `output`, `parsed` for review activities).
The NAME segment has no override path: body, caller, and
configuration cannot substitute a different prefix. Hard-coded
prefixes tied to specific built-in state NAMEs (`semantic_review`,
`test_review`, `review`) inside shared activity bodies are bugs and
must be replaced with the NAME the workflow passed in.

**Agent session metadata.**
An activity that invokes an external agent records the resulting
session as an `AgentSessionRecord` and links it from the attempt
(`attempt.agent_session_id`). Session id extraction must respect the
agent adapter layer — shared activity bodies do not hardcode codex,
claude, gemini, or kiro specifics; they go through the adapter.

**Finding and inbox routing.**
Structured review findings and inbox items derived from review
output are appended by the caller, not the shared activity body. The
body never pushes into `run.findings`, `run.inbox`, `run.artifacts`,
or `run.agent_sessions`; it reports what it produced through a
TYPE-specific result field on `ActivityResult`. For review-type
activities that field is `reviewOutcome`, a discriminated union:

- `{ kind: "skipped", reason }` — autonomy, facts, or a missing
  state config block prevented execution; no reviewer ran.
- `{ kind: "command_failed", status, exitCode? }` — the reviewer
  command did not succeed (`status` is `"failed"` or `"timed_out"`);
  no parseable output exists.
- `{ kind: "unparseable", detail, reviewerSessionId?, artifacts,
  agentSessions }` — the reviewer command succeeded but its output
  did not match `tychonic.review.v1`.
- `{ kind: "parsed", result, reviewerSessionId, artifacts,
  agentSessions }` — the reviewer command succeeded and its output
  parsed into a `tychonic.review.v1` verdict. `reviewerSessionId`
  equals the `id` of one `AgentSessionRecord` in `agentSessions`
  — the successful reviewer attempt's session — and is the
  authoritative source for `Finding.source_review_session_id`
  when the caller appends findings for a `fail` verdict.

`artifacts: ArtifactRecord[]` and `agentSessions: AgentSessionRecord[]`
carry full records, not ids. The body creates them in-memory, writes
the underlying files to disk (through `RunArtifactStore` or direct
filesystem I/O), and returns the objects through `reviewOutcome`. The
caller appends those objects to `run.artifacts` and
`run.agent_sessions`. The body must never push into `input.run.*`
itself — see `File I/O vs run mutation` below.

The caller switches on `reviewOutcome.kind` to decide whether to
append findings (only for `kind: "parsed"` with
`result.status === "fail"`), open an inbox triage item (only for
`kind: "unparseable"`, with caller-chosen wording), or do nothing
(`skipped`, `command_failed`, or `parsed` with `pass`). The body
does not know inbox title wording. One body call produces at most
one reviewer session; multi-candidate and multi-iteration
strategies are the caller's loop, not the body's.

**One state per body call.**
Each review-body invocation produces exactly one
`WorkflowStateRecord`. Callers that loop body calls (candidate
retry, multi-iteration review) receive one state per call and
must not delete, rename, or retroactively re-attach attempts from
one body-produced state into another. Collapsing multiple candidate
states into a single "logical review" step distorts
`started_at`/`finished_at` chronology and is a regression; logical
grouping of candidate attempts belongs to read-time aggregation,
not to the stored state records.

**File I/O vs run mutation.**
Filesystem writes an activity performs during its body (artifact
files, live output logs, worktree contents) are not state changes
from the `No source mutation` invariant's perspective. State
changes are mutations of the `run: WorkflowRunRecord` object passed
in as `input.run`. `RunArtifactStore.writeArtifact` historically
both writes the file and pushes the resulting record into
`run.artifacts`; activity bodies must not leave that push in place.
They either call a non-mutating store API, or write the file
directly and construct the `ArtifactRecord` themselves. Either way,
`input.run` on return must be deep-equal to `input.run` on entry.
Agent-session records follow the same rule: the body builds the
`AgentSessionRecord`, returns it through `reviewOutcome.agentSessions`,
and never calls `input.run.agent_sessions.push`.

**Review state terminal status.**
Review-type activities map reviewer outcomes to `state.status` with
exactly the following table. There is no other correct mapping.

| Condition | state.status |
| --- | --- |
| autonomy, facts, or a missing state config block prevents execution | `skipped` |
| reviewer command exited non-zero | `failed` |
| reviewer command timed out | `timed_out` |
| reviewer command succeeded but output did not match `tychonic.review.v1` | `blocked` |
| reviewer command succeeded and verdict is `fail` | `failed` |
| reviewer command succeeded and verdict is `pass` | `succeeded` |

A `fail` verdict is a workflow-level failure event, not a successful
review that happens to have findings attached. The `simpleWorkflow` gate on
the next iteration reads this status.

**Pass-through omission.**
Values whose authoritative source lives outside Tychonic (model
names, reasoning levels, thinking budgets, provider endpoints) follow
principle 4: they are not activity-layer fields. The activity never
supplies a Tychonic-side default for a pass-through value; operators
include those flags only in explicit `command` / `resume_command`
strings or in the external CLI's own configuration.

**Retry boundary.**
Every Tychonic activity proxy sets Temporal retry to
`maximumAttempts: 1`. Activities are non-retryable by design: they
spawn expensive, non-deterministic agent CLIs (`claude -p`, `codex
exec`, etc.), and a silent Temporal-level retry would double-charge,
double-edit, or confuse the worker session. Retry responsibility
lives one layer up, in the workflow's review loop
(`loop.max_review_iterations`): when a review state reports `fail`,
the workflow calls the worker activity again with the prior findings
threaded in, and does so until the loop cap or a `waiting_user`
transition. Durability, therefore, is defined at the **workflow
transition** level (state-to-state, signal delivery, workflow
resume), not within a single activity attempt. If a worker process
dies mid-activity, that activity moves to `failed` on the next
heartbeat timeout and the workflow reacts through the same review
loop, not through Temporal re-dispatching the same attempt. Plugins
follow the same contract; the `proxyActivities` helper in Tychonic's
public activity package sets this retry policy and must not be
overridden without an explicit, reviewed reason.

## Workflow Modules

A workflow module is an installable **bundle directory** on disk. A bundle
holds exactly one workflow and the config that workflow needs to run.

The bundle contract is fixed:

- every bundle is a directory whose name **equals the name of the single
  workflow function it exports** — the same name users pass to `tychonic run
  <name>`. The name must match `^[A-Za-z0-9][A-Za-z0-9_.-]*$`. Bundle install
  rejects a bundle whose exported workflow function name differs from the
  directory name.
- every bundle contains exactly these files at its top level:
  - `workflow.mjs` — required. Compiled ESM Temporal workflow module.
    Exports one workflow function per file (the function name is the workflow
    name users pass to `tychonic run <name>`), and exports a
    `requires` object (see below).
  - `config.yaml` — required. A Tychonic config file
    (`version: tychonic.config.v1`) that declares the `states.<name>` and
    `policies.<name>` blocks this workflow depends on. Fully self-contained.
  - `README.md` — optional. Operator-facing documentation for this bundle.
- no other files, subdirectories, or file extensions are allowed inside a
  bundle. Additional files are an install-time error.

Bundles are installed with `tychonic workflows install <directory>`.
Installation copies the directory tree verbatim to
`<state>/workflows/modules/<name>/` where `<state>` is
`tychonicRuntimeDirs().stateDir`, validates the bundle (below), and replaces
the worker process so the new bundle is loaded. The install command fails if
another installed bundle already exports a workflow function with the same
name, or if two bundles would share the same directory name.

`tychonic workflows remove <name>` deletes the installed bundle directory
and replaces the worker process. Both commands do these two operations
together as one user action; there is no separate `--restart-worker` flag.
`tychonic service restart-worker` remains as an independent manual recovery
command.

The runtime workflow module registry is the set of installed bundle
directories. The worker loads every `<name>/workflow.mjs` under that
registry, passes the packaged webpack resolver so each bundle resolves
`@temporalio/workflow` out of the Tychonic package's own `node_modules`, and
rejects startup if two bundles contribute the same exported workflow name.

Tychonic's own product workflows ship as bundles built by `npm run build`:
`workflows/simpleWorkflow/`, `workflows/checkpointWorkflow/`, `workflows/selfRepairWorkflow/`. They
are installed into the runtime registry by `tychonic service install`
exactly the same way operator-supplied bundles are installed. There is no
separate "built-in workflow" execution path.

### Required state declaration

A bundle's `workflow.mjs` must declare the states it calls by exporting a
`requires` object shaped like this:

```js
export const requires = {
  states: [
    { name: "work", type: "work" },
    { name: "verify", type: "verify" },
    { name: "review", type: "review" }
  ]
};
```

- `requires.states` is a non-empty array whose element order has no
  orchestration meaning (workflow code still owns order/branching).
- Each element is `{ name: string, type: ActivityType }`. `type` is drawn
  from the fixed `ActivityTypeSchema` set (`lint`, `unit_test`, `integration`,
  `work`, `verify`, `review`, `auto_continue`).
- State names must be unique within the array.

This is the only authoritative declaration of which state names and types
the workflow expects. No separate manifest, schema file, or JSON companion
file exists.

### Install-time validation

`tychonic workflows install <directory>` performs exactly these checks, in
order. Any failure aborts the install without touching the runtime modules
directory.

1. The source path is a directory.
2. The directory contains `workflow.mjs` and `config.yaml`, may contain
   `README.md`, and contains nothing else.
3. `config.yaml` parses under `TychonicConfigSchema`.
4. `workflow.mjs` is parsed as an ES module AST without importing it,
   creating a staging directory, or symlinking `node_modules`. The static
   inspection must find at least one named workflow export (function) and
   exactly one `requires` export matching the shape in **Required state
   declaration**.
5. For every `{ name, type }` entry in `requires.states` there is a
   matching `states[name]` block in `config.yaml`, and that block's `type`
   equals the declared `type`. Missing names, type mismatches, or extra
   `states[*]` entries that no workflow export references each produce a
   distinct error message pointing at the offending name.
6. No other installed bundle exports the same workflow function name.

Validation runs once at install time. The worker and the workflow itself do
not re-run these checks at runtime. Runtime errors are limited to the
pre-existing workflow-start schema validation performed by
`TychonicConfigSchema` on the effective profile; that contract is unchanged
(see "State Config Block Contract").

### `selfRepairWorkflow` iteration budget

`selfRepairWorkflow` requires these explicit named states:

- `detect_bugs`: `review`
- `write_regression_tests`: `work`
- `review_regression_tests`: `review`
- `fix_bugs`: `work`
- `verify`: `verify`
- `final_review`: `review`

Its iteration budget is `policies.self_repair_workflow.max_iterations`
when set; otherwise the workflow uses the default of `3`.

## Configuration Model

A workflow bundle's `config.yaml` is the **only** source of configuration
for that workflow. There is no global configuration file, no repository
configuration file, no product-default configuration file, and no layered
merge pipeline.

Configuration has exactly two top-level groups. No others.

- `states.<name>` — state config blocks keyed by state NAME. Each block is
  fully self-contained and includes a mandatory `type` field that binds the
  state to an activity TYPE, the settings that TYPE requires, and any agent
  fields it needs (`agent`, `command`, `resume_command`, `sandbox`,
  `approval`, `permission_mode`, `trust_all_tools`, `timeout`).
- `policies.<name>` — workflow-level orchestration policies that are not
  per-state. Currently `policies.loop`, `policies.integration`,
  `policies.self_repair_workflow`, and `policies.interaction`.

There is no `agents.<name>` top-level, no `commands.<name>` top-level, no
`activity_timeouts.<name>` top-level, no `work` / `review` slot blocks, no
`profile` file concept, no `name` or `template` field in a config file.
Workflow selection is a CLI invocation argument, not a file field.

State NAMEs are arbitrary identifiers unique within the file. State config
block types are a fixed product-controlled set (`lint`, `unit_test`,
`integration`, `work`, `verify`, `review`, `auto_continue`). Each TYPE has
a documented contract for its activity's inputs and outputs. The TYPE field
exists for schema validation and for binding the state to its activity
function, not for orchestration. A workflow never branches, falls back, or
selects states based on TYPE. See "Workflow Model → State Identity And
Activity TYPE" for the full NAME/TYPE contract.

Workflows reference states by NAME only. Retry, candidate ordering,
aggregation, and all other multi-state orchestration live in the workflow's
TypeScript code and use explicit NAMEs for each call site.

### Bundle config is the only source

The effective config for a workflow run is exactly the `config.yaml` file
installed with that workflow's bundle, validated once at install time and
again at workflow start by `TychonicConfigSchema`. No other file — not a
user home-directory config, not a repository config, not a product-default
config — is read, merged, or consulted.

Two consequences follow and must both hold:

- Absent fields stay absent. Values whose authoritative source lives outside
  Tychonic (for example `model`, `reasoning_effort`, `thinking_budget`) are
  not config fields and are never filled by Tychonic. Operators put those
  vendor-owned flags directly in `command` / `resume_command` or in the
  external CLI's own configuration.
- Product defaults are expressed in workflow code, not configuration.
  Invariants that must hold regardless of any bundle (for example, per-TYPE
  command timeout defaults when a block omits `timeout`) are applied by the
  activity implementation or by the workflow module itself. They are not
  injected into the user-visible config.

### CLI overrides

Callers that need to override settings for a single workflow start or signal
invocation may supply a config file through `--config <file>` on the
relevant command, or include override fields in a Temporal signal payload
where the signal schema already allows it (for example,
`simpleWorkflow`'s continuation / resume / extend-iterations signals).

An override replaces the bundle's `config.yaml` as a single whole object for
that one invocation. There is no field-level merge, no array merge, no
per-block merge. If the override file declares `states.<name>`, the
bundle's `states.<name>` is discarded entirely for that invocation — the
override must include every block the workflow needs. If the override file
omits the block entirely, the workflow sees the bundle block unchanged.

An override never survives past the workflow start or signal it was passed
to. Running workflows never re-read any config file.

### Immutability

At workflow start Tychonic loads the bundle's `config.yaml`, optionally
replaces it whole with a CLI-override file, validates the resulting
`TychonicConfig`, and passes the parsed object into the Temporal workflow
input. Running workflows must not re-read any config file for state
decisions after start.

Each run records one `profile_snapshot.yaml` artifact so the effective
settings are reproducible evidence. No `profile_sources.json` artifact is
written — there is only one source, the bundle, and the snapshot itself is
sufficient.

### `policies.interaction`

`policies.interaction` governs whether an external caller (a human operator
acting through the CLI, or another agent CLI driving Tychonic
programmatically) gates every state transition.

```yaml
policies:
  interaction:
    mode: auto          # required. "auto" | "interactive"
    max_reject_iterations: 5   # optional. applies to "interactive" only
```

Fields:

- `mode: "auto"` — the workflow runs every state without waiting for an
  external decision. Identical to the behavior produced by omitting the
  block entirely.
- `mode: "interactive"` — after every activity call in the workflow that
  uses the shared `waitForStateApproval` hook (see "Workflow Model →
  `waitForStateApproval`"), the workflow suspends until it receives one of
  three signals (`approveState`, `rejectState`, `modifyState`) targeting
  the state that just finished.
- `max_reject_iterations` — optional. When `mode: "interactive"`, limits
  how many consecutive `rejectState` signals a single state can absorb
  before the workflow promotes the state to `waiting_user` with an inbox
  item and stops further reject-driven retries. Default: `5`. When the
  block is `auto`, the field is not allowed (schema error).

Schema validation rules (enforced by `PolicyInteractionSchema`):

- `mode` is required; only two values accepted.
- `max_reject_iterations` is a positive integer and rejected when
  `mode: "auto"`.
- Absent block is equivalent to `{ mode: "auto" }` for runtime behavior
  but must not be written back into the profile snapshot — absent stays
  absent.

Absence is the compatibility story: every existing bundle whose
`config.yaml` has no `policies.interaction` block continues to run with
the mode-auto behavior that existed before this policy was added.

This policy is immutable for the lifetime of one run, like every other
setting captured in the start-time snapshot. See "Immutability" above.

## Manager Configuration Assistance

Tychonic may include a manager-assistant path for proposing configuration,
policy, notification, adapter, or workflow module changes from
natural-language requests. This path must produce explicit config/code
patches.

Hard guardrails require user approval. The manager path must not silently
loosen state-management rules, background mutation safety, verification
requirements, credential boundaries, or the TypeScript/Temporal product
path.

## State Config Block Contract

Every state config block (`states.<name>`) is a self-contained unit:

```yaml
states:
  lint:
    type: lint
    command: npm run lint
    timeout: 10m
  unit_test:
    type: unit_test
    command: npm test
    timeout: 45m
  work:
    type: work
    agent: codex
    sandbox: workspace-write
    approval: never
    timeout: 30m
  primary_review:
    type: review
    agent: claude
    permission_mode: plan
  backup_review:
    type: review
    agent: codex
    sandbox: read-only
    approval: never
  verify:
    type: verify
    command: npm test
    timeout: 15m
```

Rules:

- `type` is mandatory and must be one of the product-defined set. The
  current types are `lint`, `unit_test`, `integration`, `work`,
  `verify`, `review`, and `auto_continue`.
  New types are added by releasing new product code, not by user
  declaration.
- The settings allowed in a block are the union of settings the type
  contract requires plus the orchestration values Tychonic owns
  (`sandbox`, `approval`, `permission_mode`, `trust_all_tools`,
  `timeout`). Unknown fields are a validation error.
- Pass-through values (`model`, `reasoning_effort`, `thinking_budget`,
  `approval_mode`, `effort`, `plan_mode_reasoning_effort`, and similar
  vendor-owned fields) are not part of this schema. A bundle's
  `config.yaml` must not declare them: the external agent CLI already owns
  its own configuration for these values. Allowed fields inside a state
  block are exactly `type`, `agent`, `command`, `resume_command`,
  `timeout`, `sandbox`, `approval`, `permission_mode`, `trust_all_tools`,
  and `emits` (`review` TYPE only). Unknown fields are a validation error.
- When a state config block omits `timeout`, Tychonic applies the
  per-TYPE default below. An explicit `timeout` on the block
  overrides that per-TYPE default.

  | Type | Default timeout |
  | --- | --- |
  | `lint` | 10 minutes |
  | `unit_test` | 30 minutes |
  | `integration` | 60 minutes |
  | `verify` | 30 minutes |
  | `work` | 120 minutes |
  | `review` | 45 minutes |
  | `auto_continue` | 90 minutes |

  Temporal activity envelopes and worker drain defaults are
  intentionally more generous than these command defaults so
  long-running local checks can finish or hit their own configured
  timeout.
- Heartbeat timeout is a liveness contract, not a normal failure mode.
  Any activity that Temporal runs with a heartbeat timeout must send
  heartbeats for the full wall-clock lifetime of the activity, from
  command launch through output capture, artifact writes, session-id
  extraction, and every other post-processing step. This is especially
  required for worker-like activity types (`work`, `auto_continue`) and
  structured `review`.
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
- State NAMEs are unique identifiers within the merged configuration.
  Workflow code calls activities by these state NAMEs. Two state
  config blocks with the same NAME is a validation error even if
  their TYPEs differ.

## Adapter Model

Tychonic no longer owns built-in agent adapters, built-in command
generation, built-in typed provider settings, or built-in resume/session
parsing for named vendors.

The public adapter contract is **command-only**:

- every executable activity runs an explicit `command`
- `agent` is optional metadata only; it does not trigger command
  synthesis, special defaults, typed vendor settings, or alternate
  execution paths
- `resume_command` is explicit operator-owned data, never generated from
  a built-in preset
- reviewer activities that occupy a `review` slot must declare
  `emits: ["tychonic.review.v1"]`

This rule exists to prevent the same capability from being maintained in
two places at once. Tychonic must not keep both:

- an explicit command/custom-command path, and
- a built-in preset path for the same worker or reviewer role

for the same product surface.

Default product workflows ship as bundles built by `npm run build` and are
installed into the runtime workflow module registry by `tychonic service
install` exactly like any operator-supplied bundle. Runtime execution must
consume these installed bundles and the explicit state commands declared in
their `config.yaml`; it must not silently recreate built-in vendor adapter
behavior in the worker, review, or session-control path.

### Pass-Through Values vs Orchestration Values

Tychonic is an orchestrator for external agent CLIs. It must not bake in
defaults for settings whose authoritative source is the external CLI or its
provider.

**Rule:** if a setting is owned by the external agent CLI (for example
`model`, `reasoning_effort`, or `thinking_budget` — values whose valid set is
owned by the vendor and already resolvable from the CLI's own
configuration), Tychonic must not carry a system default or schema field for
that setting. Operators express it directly in `command` /
`resume_command`, or leave it to the external CLI's own configuration.

- **Orchestration values** — settings Tychonic owns because they encode
  Tychonic's own isolation and safety contract. Role-aware defaults are
  allowed only when they are attached to an explicit command contract, not
  to a vendor preset. Current config-field list: `sandbox`, `approval`,
  `permission_mode`, and `trust_all_tools`. The command shape itself
  (argv, stdin contract, session resume flags) is explicit operator-owned
  data in `command` / `resume_command`.
- **Pass-through values** — everything else the external CLI already knows
  how to handle on its own. Model selection, reasoning effort, thinking
  budget, provider endpoints, and any similar field whose valid values
  follow the upstream vendor's release cadence. Tychonic must not hardcode
  defaults for these and must reject them as config fields.

Consequence: a new model name, a renamed effort level, or a deprecated
provider alias on the external side never requires a Tychonic code change.
Users control those values through their own CLI configuration or through
explicit `command` / `resume_command` strings.

Activity/role-specific sandbox and approval values are the exception only as
Tychonic-owned orchestration policy. They do not imply a built-in provider
preset and must not cause Tychonic to synthesize vendor-specific flags.

Slots may accept either a single explicit command or an ordered command-backed
candidate list. An ordered candidate list is not a workflow graph. It is
candidate selection inside one existing workflow state. Command failure,
timeout, or reviewer contract failure can move to the next candidate. A valid
structured `fail` verdict is a completed review result and should enter the
normal `simpleWorkflow` loop rather than trying the next reviewer.

Custom command adapters can be used as workers or reviewers only when their
contract is explicit. Worker-only CLIs may produce unstructured output.
Reviewer-capable adapters must produce the shared structured review object.

An `agent` label slot and an ordered `agents` slot are mutually exclusive. An
ordered candidate list must not be combined with direct `command` or
`resume_command` settings in the same slot. Candidate entries must still
resolve to explicit commands; they must not rely on built-in vendor adapter
registrations.

## Structured Reviewer Contract

Structured reviewers must emit one machine-readable `tychonic.review.v1` object.
Required fields are `schema_version`, `status`, `summary`, and `findings`.
Finding objects must include `severity`, `title`, `detail`, and a target when
the reviewer can identify one.

Rules:

- `status` is `pass` or `fail`
- `pass` requires an empty `findings` list
- `fail` requires at least one actionable finding
- finding severity is `critical`, `high`, `medium`, or `low`
- malformed reviewer output is not a pass and must create evidence for triage

## Workflow Loop Semantics

The default product loop is transparent work, verify, review, and continue:

```text
work -> deterministic verification -> structured review
  -> pass: done
  -> fail: create findings/inbox and continue work or resume a session
```

Review findings must target the relevant prior activity attempt, file, or agent
session when possible. A workflow continuation appends new workflow history. It does
not rewrite earlier attempts.

Worker session continuity is a product-level contract, not an optimisation.
When a review activity returns `fail`, the next worker activity in the same
`simpleWorkflow` must resume the same external agent session rather than
starting a fresh conversation, provided the agent CLI exposes a durable
session reference. The resumed worker sees the full prior context — goal,
inspected files, prior code changes, structured review findings — without
Tychonic having to re-prompt that history. Review findings enter the
resumed session as the next turn so the agent treats them as direct feedback
on its own work. If a given agent cannot expose a durable session reference,
Tychonic falls back to running the continuation as a fresh worker with the
findings as context and records the non-resumable state as evidence.

Deterministic verification should run before semantic review when it can cheaply
reject bad work. Integration checks should run only when profile or workflow
policy says they are allowed; skipped checks must record a reason.

Default `checkpointWorkflow`/`simpleWorkflow` ordering is:

- run configured lint and unit commands before semantic review
- skip missing deterministic commands with a recorded reason
- run semantic review only after cheaper deterministic gates do not reject the
  work
- create findings and inbox items for review failures that need action
- schedule continuation or resume work by appending Temporal history, not by
  rewinding an earlier attempt

`simpleWorkflow` input carries two related fields that are intentionally
coupled:

- `autoContinue: boolean` — enable the work/verify/review retry loop. When
  false or absent, the workflow runs a single pass and records the review
  verdict, whether pass or fail.
- `maxIterations: number` — cap for that retry loop.

`maxIterations` has no meaning without a loop to bound, so
`simpleWorkflow` rejects input that sets `maxIterations` with
`autoContinue` unset or false (`simple_workflow --max-iterations
requires --auto-continue`). There is no implicit default: Tychonic
refuses rather than choosing one of the two interpretations on the
caller's behalf.

Integration test policy is explicit:

- `disabled`: do not run and record a skipped reason
- `manual`: create a waiting/inbox state when integration appears necessary
- `auto_on_relevant_changes`: run only when deterministic facts and resource
  policy allow it
- `required`: make integration a final success condition

Integration position is also explicit:

- `before_ai_review`: run before semantic review
- `after_ai_review`: defer until after semantic review
- `final_gate`: run after the work/review/`simpleWorkflow` loop as the final gate

When `simpleWorkflow` exhausts `loop.max_review_iterations` with the last
structured review still failing, the workflow enters `waiting_user`. If it
was started with workflow input `holdOpenOnWaiting: true`, it accepts
operator signals to continue:

- per-inbox-item continuation (`tychonic inbox execute`) processes one
  finding with one worker+verify+review cycle
- session resume (`tychonic resume`) re-prompts a specific agent session
- batch continuation (`tychonic simple_workflow:continue`) runs the auto-continue loop
  over every remaining open inbox item with a fresh iteration budget,
  reusing the workflow's immutable start-time snapshot

Signals must not widen the effective profile. Defaults come from the
captured snapshot; only explicit per-signal fields act as CLI-layer
overrides for that signal's scope.

### Interactive mode

When `policies.interaction.mode === "interactive"`:

- Interactive mode **replaces** the auto-mode workflow loop. The
  reviewer activity still runs and produces a `tychonic.review.v1`
  verdict as evidence, but the workflow does **not** self-retry on a
  reviewer `fail`. Instead, after every activity call (deterministic or
  semantic), the workflow calls `waitForStateApproval` and suspends
  until an external agent decides the next move. The external agent
  reads the reviewer verdict and the produced artifacts, then sends
  `approveState`, `rejectState`, or `modifyState`. `rejectState`
  re-runs the activity that just finished; accumulated rejects and the
  `policies.interaction.max_reject_iterations` cap are the loop driver
  in this mode. `policies.loop.max_review_iterations` does not run
  under interactive mode — that knob is an auto-mode concept.
- `approveState` after any state advances to the next state; a
  `review` state is no different from any other state in this regard.
  A reviewer `fail` verdict followed by `approveState` is the
  documented path for an external agent to accept the run despite
  review findings (the findings remain as evidence on the run).
- `rejectState` after any state re-runs that state's activity with
  the feedback string threaded in. A reject on a `review` state is
  allowed and is the path for an external agent to force another
  review iteration. `feedback` is required (non-empty); an empty
  feedback string is a signal-validation error.
- `modifyState` after any state overlays a `StateRecordPatch` on the
  latest `WorkflowStateRecord` for that state name in `run.states`.
  The patch may change `status` / `reason`, append a `note`, and
  append `artifacts` / `findings` (see the `waitForStateApproval`
  contract above). The state record's `id`, `activity_attempt_ids`,
  and timestamps are preserved. The workflow continues with the
  overlaid record as the state's terminal outcome. This is the
  mechanism by which an external agent injects its own review
  verdict, adds context to a worker outcome, or overrides a state's
  status without re-running the activity.
- `policies.interaction.max_reject_iterations` caps the number of
  `rejectState` signals a single state can absorb. When the cap is
  reached, the workflow promotes the run to `waiting_user` with an
  inbox item titled `Interactive reject limit reached` and stops
  calling `waitForStateApproval` for that state. `approveState` or
  `modifyState` on the parked state still applies; `rejectState`
  after the cap is an inbox-item-only signal (recorded, not acted
  on).
- Mode cannot change mid-run. A config override signaling a mode
  switch is rejected at signal-validation time. This follows the
  general "signals must not widen the effective profile" rule
  already stated above.
- Hold-open semantics are unchanged by interactive mode. A workflow
  started with input `holdOpenOnWaiting: true` that reaches
  `waiting_user` under interactive mode still accepts the existing
  signals (`simple_workflow:continue`, `resume`, `inbox execute`,
  `inbox dismiss`) in addition to the three interactive signals.
  Interactive signals are independent of hold-open; they work from
  workflow start, not only after `waiting_user`.

Interactive mode does **not** change any of:

- isolated worktree semantics (`simpleWorkflow` still creates and
  uses `.tychonic/worktrees/<id>/`)
- structured review contract (`tychonic.review.v1` still required
  from any `review`-type activity that runs)
- agent session resume (`resume_command`, `simple_workflow.resume_session`
  signal, and worker session continuity all behave identically)
- the `ActivityInput` / `ActivityResult` / `WorkflowRunDelta` type
  contracts
- the bundle layout (`workflow.mjs` + `config.yaml` + optional
  `README.md`)
- install-time worker replacement

## Policy And Facts

Tychonic should prefer deterministic facts over AI judgment when possible.

Useful deterministic facts include:

- git diff and changed file classification
- configured command availability
- environment or resource availability
- previous workflow status
- prior check output

Policy decisions can enter, skip, block, or require user input for a step. A
skip is a first-class result and must preserve a reason.

## State And Evidence

Every activity attempt should preserve enough evidence to explain what happened:

- step/activity status
- command or adapter used
- timeout applied
- agent session reference when available
- prompt/transcript/result artifacts when available
- diff/test/review output artifacts
- inbox item and finding references when action is needed

Live output is an operator observation surface, not a source of truth for
workflow decisions. Use official structured streams when available. For example,
Codex JSONL event streams and final-message outputs are stronger evidence than
plain stdout/stderr tee output.

Minimum product records:

- workflow run
- step
- activity attempt
- agent session reference
- artifact
- finding
- inbox item

Status should distinguish succeeded, failed, timed out, skipped, blocked,
waiting for user, cancelled, and running states where applicable.

The local operator surface and CLI must read product state through Temporal
workflow result, history, query, signal, update, describe, or visibility APIs.
They must not reconstruct state by scanning artifact directories.

Deterministic checks should reject clearly broken work before spending AI quota.
Semantic review should be used where deterministic checks cannot decide.

Background mutation must use an isolated worktree. The active project working
tree is not mutated directly by background automation.

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
(already used for `policies.interaction` start-time snapshots), `namespace`
(the Temporal logical isolation unit), and `environment` (which would imply a
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
| Temporal frontend port | `7233` | `17000 + fnv1a32(<name>) mod 1000` |
| Temporal UI port | `8233` | frontend port `+ 1` |
| Temporal address | `127.0.0.1:7233` | `127.0.0.1:<derived frontend port>` |
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

- `--address`, `--frontend-port`, `--ui-port`, `--task-queue`, `--namespace`
- `$TYCHONIC_STATE_HOME`, `$TYCHONIC_LOG_HOME`
- the web server port

This is the same replace-not-merge precedence that applies between a bundle's
`config.yaml` and `--config <file>`, scoped to a single CLI invocation. There
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
`service install`, which on the operational path populates the module
registry with the packaged sample bundles (`simpleWorkflow`,
`checkpointWorkflow`, `selfRepairWorkflow`, and any other bundles shipped
under `dist/workflow-bundles/`), is rejected under an instance. The operator
must therefore call `tychonic workflows install <directory> --instance
<name>` for every bundle the instance needs — whether that directory is a
packaged sample (`dist/workflow-bundles/simpleWorkflow`) or a user plugin
(`examples/workflows/architectBuilderQaWorkflow`). Tychonic makes no
distinction between these two sources; both flow through the same install
path. `runtime up --instance <name>` refuses to start (both foreground and
`--detach`) when the instance's module registry is empty, so the operator
gets the correct guidance to install the bundles they need instead of a
detached child that dies silently a few seconds after reporting a PID.

Lifecycle commands:

- `tychonic runtime up --instance <name>` — starts Temporal if needed and
  runs the worker (and, by default, the web server) in the foreground.
- `tychonic runtime up --instance <name> --detach` — spawns the same runtime
  in a new session and exits. Writes the child PID to
  `<instance-state>/runtime.pid` and appends stdout/stderr into
  `<instance-log>/runtime.log`. Requires `--instance`; `--detach` is not
  available on the operational path. If a live PID already occupies the
  PID file, the command refuses rather than overwriting it.
- `tychonic workflows install <bundle> --instance <name>` — copies the
  bundle into `<instance-state>/workflows/modules/<name>/`. Does not call
  any launchd operation. The JSON response includes a note that the
  operator must restart `runtime up --instance <name>` for the worker to
  load the new bundle.
- `tychonic runtime reset --instance <name>` — terminates any detached
  runtime recorded in the instance PID file (SIGTERM, 10 second wait,
  SIGKILL), then removes `<instance-state>/` and `<instance-log>/`.
  Rejects invocation without `--instance`; operational paths are never
  reset through this command. Without `--yes`, it prints the paths it is
  about to remove and reads a confirmation from stdin. AI agents pass
  `--yes` for non-interactive cleanup.

Instance isolation changes only the runtime directory layout and the
Temporal connection parameters the CLI generates. It does not change the
bundle configuration schema, the workflow code, the `policies.interaction`
start-time profile snapshot, or the rule that Temporal workflow history is
the sole Source Of Truth. The instance's Temporal DB file is a different
file on disk from the operational DB, and the two catalogues do not share
workflow identities even when both use the `default` namespace.

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

Each bundle directory contains:

- `workflow.mjs`
- `config.yaml`
- `README.md` (optional)

Nothing else. A directory that does not match this shape is not a bundle
and is ignored by the worker at load time.

The worker's webpack resolver extension (see "Plugin dependency
resolution") applies uniformly to every bundle under this directory.
Packaged product bundles (`simpleWorkflow`, `checkpointWorkflow`, `selfRepairWorkflow`) share the
same directory as operator-supplied bundles with no reserved prefix.

## Verification Boundary

Verification splits along the worktree boundary. Worker activities run
in an isolated worktree and must only perform checks that complete
inside that worktree. Release-gate checks that require external network
or machine state belong on the operator side, after the operator applies
a patch to the source tree.

- **Worker-side verification** (`npm run verify:worker`): typecheck,
  unit tests, build, example validation, and guardrails. Runs
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

## Interfaces

- CLI is required.
- Local operator surface is experimental but must remain loopback-bound by
  default.
- Notification should only be used for actionable states such as waiting,
  blocked, or failed.
- Web/API mutation endpoints are not authenticated in public alpha and must not
  be exposed to untrusted networks.

## Implementation Language

The active product path is TypeScript.

The Tychonic package itself — CLI, local Web API, built-in Temporal
workflow activities, bundle config schema, adapters — stays in one
TypeScript package and type system.

Operator-authored workflow bundles (`workflow.mjs` + `config.yaml`,
documented in `docs/plugin-workflows.md`) are written in JavaScript
(ESM) so Temporal's workflow sandbox can consume them directly
without a TypeScript build step. Bundles are a first-class product
surface and are not covered by this "TypeScript-only" rule.

Non-TypeScript Temporal SDK bindings (Go, Python, Java) are not part
of the current product path.
