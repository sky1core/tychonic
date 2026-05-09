# Workflows Module SPEC

This file applies to workflow helper code under `src/workflows/` and to the
public `tychonic/workflow` helper surface. It does not define built-in workflow
modules; Tychonic core contains none.

## Workflow Model

Workflows are TypeScript Temporal workflow code. They invoke the activity
function for each state they enter, passing the state NAME and the effective
profile. They do not read YAML and they do not branch on activity TYPE.

Configuration declares named state config blocks and named policies.
Configuration does not define workflow graphs, node order, edges, join policies,
arbitrary branching, new activity kinds, task queue lifecycle, or local state
storage.

Allowed configuration content:

- state config blocks keyed by state NAME (`states.<name>`), each carrying a
  `type` field that binds the state to an activity function and the settings
  that TYPE requires
- named policy values (`policies.<name>`) for workflow-level orchestration
  knobs. The top-level `policies` value must be an object. The host config
  schema treats each `policies.<name>` entry as an opaque workflow-owned value
  keyed by string; each workflow bundle defines, validates, and consumes the
  policy keys and value shapes it cares about. Common bundle-defined keys
  include `policies.loop`, `policies.integration`, and `policies.interaction`.

Ordering, branching, loops, fan-out, joins, retry, and multi-activity
aggregation belong in Temporal workflow code. If a project needs custom
ordering, write or generate a compiled, self-contained ESM workflow module that
exports Temporal workflow functions, install it into the runtime workflow
module registry, and make the relevant runtime load that registry through its
documented runtime path.

Workflow authoring must stay simple. A workflow module should expose the
workflow's state order, branches, loops, prompts, and stop conditions without
forcing authors to copy Tychonic run-record plumbing. `tychonic/workflow`
helpers may automate common bookkeeping around explicit state calls: applying
activity results, attaching artifacts and parsed review findings, publishing
run-state snapshots, standard interaction-gate retry plumbing, and finalizing a
run. Those helpers must remain NAME-parameterized and must not decide which
state runs next, encode workflow graphs, rotate candidates, or branch by TYPE.

A workflow module's `defaultProfile` export pulls the state and policy contract
into the workflow code itself: it is the workflow's author-supplied
`TychonicConfig` that ships with the bundle and is validated once at install
time. Workflow start still validates the effective config under
`TychonicConfigSchema`.

## State Identity And Activity TYPE

A state and the activity it invokes share exactly two axes.

- **NAME** — a user-chosen identifier unique within the effective
  configuration. NAME belongs to the state: `state.name` on the runtime record
  equals the state NAME the workflow used when it invoked the activity, and
  equals the key under which the state's config block lives
  (`profile.states.<name>`).
- **TYPE** — a product-controlled label drawn from the fixed
  `ActivityTypeSchema` set (`work`, `verify`, `review`). TYPE selects the
  activity function the workflow must call for a given state, and the contract
  that activity runs.

Tychonic exposes one state-producing activity function per TYPE. An activity
accepts a state NAME as a parameter, never as a hardcoded identifier in its own
source. Workflow code owns every NAME literal that reaches an activity call
site. The same activity function is called any number of times per run with
distinct state NAMEs — a workflow that needs three reviews calls
`runReviewActivity` with three state NAMEs, and the configuration declares
three state config blocks of `type: review`.

A workflow never branches, retries, or aggregates based on TYPE. TYPE exists
only for schema validation (`type: review` rejects a block that carries
shell-command settings) and for binding a state to its activity function. Any
runtime behavior that depends on which specific state to run must be expressed
through the state NAME the workflow passes to the activity call.

## Plugin Composition Path

A custom workflow is a bundle directory installed through the runtime workflow
module registry with `tychonic workflows install <directory>`. The bundle's
`workflow.mjs` composes exported activities in whatever order, loop structure,
or conditional shape its implementation needs, using NAME literals it chooses,
and exports a `defaultProfile` object that declares the matching state blocks.
No Tychonic source change is required to add a new workflow, introduce a new
NAME, or run the same TYPE any number of times.

Adding a new TYPE (extending the product contract) does require a Tychonic
release and is explicitly out of scope for plugin authors. Plugins consume the
TYPE set Tychonic exposes.

## Workflow Loop Semantics

Workflow loop shape — whether a workflow loops at all, how it caps that loop,
which activity it retries on review `fail`, and how it transitions to
`waiting_user` — is defined inside each bundle's `workflow.mjs`. This section
states only the host-side invariants every workflow must respect. Per-workflow
loop contracts (counters, signal payloads, inbox titles) live in the bundle's
`README.md`.

Host-side invariants:

- A workflow continuation appends new Temporal workflow history. It does not
  rewrite earlier attempts.
- Review findings must target the relevant prior activity attempt, file, or
  agent session when possible.
- Deterministic verification should run before semantic review when the
  deterministic check can cheaply reject bad work.
- Integration checks run only when configuration and policy allow it; skipped
  checks must record a reason.
- `waiting_user` means the run needs human attention. It does not by itself
  mean the Temporal workflow execution is still open.
- A workflow that keeps execution open for operator-driven continuation must
  expose a workflow-owned signal/query surface: either the standard Tychonic
  interaction helper or custom signals documented by that bundle. The workflow
  start input must opt into that hold-open behavior.
- A terminal `waiting_user` result may require a fresh run with adjusted input
  or config. That recovery path must be documented by the bundle.

## State Rerun Recovery

Recoverable state failure is part of the workflow state machine. If a
state-producing activity fails, times out, or blocks because of an
external/transient problem — for example network loss, unavailable external CLI,
temporary provider failure, interrupted command execution, or process timeout —
the workflow must not make the operator start over from the beginning when the
same state can be safely tried again.

A recoverable state rerun has this contract:

- the failed attempt remains in Temporal history and in the Tychonic run record
- output, logs, artifacts, findings, and session references from the failed
  attempt remain inspectable evidence
- the workflow execution remains open while rerun recovery is offered
- rerun is driven by an explicit workflow-owned signal, not by Temporal activity
  proxy retry
- rerun invokes the same state NAME again and appends a new
  `WorkflowStateRecord` / `ActivityAttemptRecord`
- the workflow code owns whether rerun continues to the next state, returns to
  an interaction gate, or stops after the rerun attempt

A closed workflow execution cannot be resumed by signal. If a workflow returns a
terminal result instead of keeping the execution open, it is declaring that
state-level rerun is no longer available and the documented recovery path is a
fresh run.

Rerun recovery does not create a generic config-driven retry list. Workflow code
must name the state it is willing to rerun and must document the rerunnable
state NAMEs, stop conditions, and unsafe cases in the bundle README.

## Agent Session Continuity

Agent session continuity is a host capability, not a host policy. Tychonic
exposes the activity layer needed for a workflow to resume the same external
agent session across iterations: `runWorkerActivity` accepts an explicit
`sessionId`, and the built-in adapter for that session's agent issues the CLI's
own resume invocation. A workflow that wants same-session continuity calls
`runWorkerActivity` with the prior session id; a workflow that wants a fresh
session omits `sessionId`. When a given agent CLI cannot expose a durable
session reference (for example the partial gemini adapter), the activity records
the session as non-resumable evidence.

`states.<name>.resume` (non-negative integer, default `0`) is the optional
budget for that explicit continuation path. Omitted or `0` means no
same-session continuation budget. The host does not attach resume semantics to
any state NAME or role. When the budget is exhausted, the workflow decides its
own recovery path and documents that behavior in the bundle's README.

## Integration Policy

`policies.integration` is workflow-specific policy. The host schema treats it
as opaque data and does not assign integration behavior.

The checkpoint example uses only `policies.integration.position`:

- `before_ai_review`: run before semantic review
- `after_ai_review`: defer until after semantic review
- `final_gate`: run after a workflow's review loop as the final gate

A workflow that uses this policy reads `profile.policies.integration.position`
and routes its own integration state NAME to `runVerifyActivity` accordingly.
Other workflows may define a different `policies.integration` value shape, but
they must document and validate the keys they consume.
