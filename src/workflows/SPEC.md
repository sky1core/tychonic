# Workflows Module SPEC

This file applies to workflow helper code under `src/workflows/` and to the
public `tychonic/workflow` helper surface. It does not define built-in workflow
modules; Tychonic core contains none.

## Workflow Model

Installed workflows are Temporal workflow code. Declarative bundles start from
`workflow.yaml`, but install translates that source into an explicit
`workflow.mjs` module before the worker loads it. The installed module invokes
the activity function for each state it enters, passing the state NAME and the
effective profile.

Runtime configuration declares named state config blocks and named policies.
Runtime configuration does not define workflow graphs, node order, edges, join
policies, arbitrary branching, new activity kinds, task queue lifecycle, or
local state storage. Declarative `workflow.yaml` is workflow source, not a
runtime configuration replacement.

Allowed configuration content:

- state config blocks keyed by state NAME (`states.<name>`), each carrying a
  `type` field that binds the state to an activity function and the settings
  that TYPE requires. Every `review` state also carries `on_fail_return_to`,
  the explicit non-review state NAME that failed review feedback returns to
  when the workflow loops. Generated YAML workflow code appends failed review
  summaries and structured findings to that return state's next prompt when
  the return state is prompt-bearing.
- named policy values (`policies.<name>`) for workflow-level orchestration
  knobs. The top-level `policies` value must be an object. The host config
  schema treats each `policies.<name>` entry as an opaque workflow-owned value
  keyed by string; each workflow bundle defines, validates, and consumes the
  policy keys and value shapes it cares about. The standard interaction helper
  validates the `policies.interaction` shape that it consumes.

Ordering, branching, loops, fan-out, joins, retry, and multi-activity
aggregation belong in workflow source and in the installed Temporal workflow
code generated from that source. If a project needs custom ordering, express it
in `workflow.yaml` and install it into the runtime workflow module registry.

Workflow authoring must stay simple. A workflow module should expose the
workflow's state order, branches, loops, prompts, and stop conditions without
forcing authors to copy Tychonic run-record plumbing. `tychonic/workflow`
helpers may automate common bookkeeping around explicit state calls: applying
activity results, attaching artifacts and parsed review findings, publishing
run-state snapshots, standard interaction-gate retry plumbing, and finalizing a
run. Those helpers must remain NAME-parameterized and must not decide which
state runs next, encode workflow graphs, rotate candidates, or branch by TYPE.
Install-time code generation may use TYPE only to emit the explicit activity
call for each declared state.

A workflow bundle's default profile comes from `workflow.yaml`. Bundles derive
the profile from their validated state-machine spec and generate the Temporal
wrapper at install time. Workflow start still validates the effective config
under `TychonicConfigSchema`.

The public `createTychonicWorkflowContext` helper exposes the current Temporal
workflow id through `ctx.workflowId()` so workflow-owned prompts can point
agents at copyable CLI evidence commands such as `tychonic status
--workflow-id <id>`. This value is a Temporal workflow identifier. It must not
be confused with `WorkflowRunRecord.id`, which is the product run id used in
run records, artifact paths, inbox references, and user-facing run evidence.

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
module registry with `tychonic workflows install <directory>`. Declarative
bundles use `workflow.yaml` to define state order, pass/fail transitions,
prompts, and config in one source. No Tychonic source change is required to add
a new workflow, introduce a new NAME, or run the same TYPE any number of times.

Adding a new TYPE (extending the product contract) does require a Tychonic
release and is explicitly out of scope for plugin authors. Plugins consume the
TYPE set Tychonic exposes.

## Workflow Loop Semantics

Workflow loop shape — whether a workflow loops at all, how it caps that loop,
which activity it retries on review `fail`, and how it transitions to
`waiting_user` — is defined inside `workflow.yaml`. This section states only
the host-side invariants every workflow must respect. Per-workflow loop contracts
(counters, signal payloads, inbox titles) live in the bundle's `README.md`.

Host-side invariants:

- A workflow continuation appends new Temporal workflow history. It does not
  rewrite earlier attempts.
- Each `type: review` state in the effective profile must declare
  `on_fail_return_to`. When workflow code routes failed review feedback, the
  destination must match that declaration and must be a non-review state; a
  workflow with a fixed review loop should assert the declared target before
  entering the loop. Declarative YAML workflows generated by install perform
  this routing for review fail transitions declared with `on_fail.goto`.
- Review findings must target the relevant prior activity attempt, file, or
  agent session when possible.
- Deterministic verification should run before semantic review when the
  deterministic check can cheaply reject bad work.
- Integration checks run only when configuration and policy allow it; skipped
  checks must record a reason.
- `waiting_user` means the run needs human attention. It does not by itself
  mean the Temporal workflow execution is still open.
- A workflow that keeps execution open for operator-driven continuation must
  expose a workflow-owned signal/query surface through the declarative contract
  and generated wrapper. The workflow start input must opt into that hold-open
  behavior.
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
