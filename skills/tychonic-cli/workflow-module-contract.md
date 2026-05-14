# Workflow Module Authoring Contract

Use this when writing or changing workflow bundles.

## Bundle Shape

A workflow bundle is a directory containing exactly one authoring entrypoint:
declarative `workflow.yaml`. The directory name is the workflow name users pass
to `tychonic run <name>`.

`workflow.yaml` must declare `name`, matching the bundle directory name.
Install validates the YAML, derives the bundle `defaultProfile`, generates an
explicit Temporal `workflow.mjs` wrapper, and writes `workflow.generated.mmd`.
Edit `workflow.yaml`, not generated files.

`tychonic run` validates the standard workflow input contract (required `cwd`,
optional `goal`, optional `promptAdditions`) at CLI preflight before starting
Temporal. `promptAdditions` keys are auto-derived from profile states with type
`work` or `review`. The generated wrapper uses
`createTychonicWorkflowContext`, which repeats that standard validation at
workflow start.

At workflow start, Tychonic injects the effective profile into the workflow
input's reserved `profile` field. Workflow code passes that profile to
activities. Operators pass workflow input as a JSON object and replace config
with `tychonic run --config <file>`, not by putting `profile` in workflow JSON
input.

Workflow run input must stay task-shaped. Public top-level input fields are
required `cwd`, optional `goal`, and optional `promptAdditions`. The host
auto-derives valid `promptAdditions` keys from profile states with type `work`
or `review` and rejects unknown keys. Workflow source defines its own prompts.
Do not expose top-level prompt fields or agent-named input keys. In
`workflow.yaml`, `prompt` is valid only for `work` and `review` states. Prompt
text may reference explicit `{{goal}}`; install rejects unknown `{{...}}`
variables. The generated wrapper renders `{{goal}}` from public input `goal`,
or from `(no explicit goal supplied)` when omitted, then appends validated
`promptAdditions[stateName]`.

The bundle may include `README.md` and reproducible supporting files, but
workflow behavior is authored in `workflow.yaml`. Tychonic provides
`@temporalio/workflow` and `tychonic/workflow` to the generated wrapper while
bundling workflow code. Tychonic does not synthesize resolver state during
install.

## Boundaries

- Workflow source decides order, branching, loops, retry, gating, and stop
  conditions.
- Workflow source should stay small enough that the state order and stop
  conditions are obvious.
- Config declares named state blocks and workflow-owned policy values.
- Every `review` state declares `on_fail_return_to`; the target must be a
  non-review state, and workflow code must route failed review feedback to that
  declared state when it implements a review loop.
- Activities execute one state invocation at a time.
- State NAME is workflow-defined and product-facing.
- Activity TYPE selects the activity contract.
- Activity TYPE is exactly `work`, `verify`, or `review`; do not create
  narrower TYPES such as architect, builder, QA, repair, or pre-review.
  Express those roles as state NAMEs.

Do not encode workflow graph behavior in runtime config. Do not add source-tree
shortcuts or alternate workflow execution paths.

## State Config

Use one execution selector per executable state:

- `agent: "<name>"` selects a built-in adapter.
- `command: "<shell command>"` is the escape hatch.

Do not set both. Do not create any second execution channel.

Built-in adapters are `claude`, `codex`, `gemini`, and `kiro`.
`claude` and `codex` can serve review states directly. `gemini` and
`kiro` can serve review states only with `normalizer: claude` or
`normalizer: codex`; the normalizer structures the primary review output and
must not invent findings.

`model` applies to the primary `agent` in the same state block. A workflow
author may explicitly choose `model` and supported `reasoning_effort` per state
only after checking the target account, model availability, plan/tier, quota,
pricing, region/country access, and organization policy. Omitted fields become
omitted CLI flags/config overrides and delegate to the selected external CLI's
default or auto-selection behavior.

For `agent: claude`, use Claude CLI model values. Versionless aliases such as
`opus` let the installed Claude CLI resolve the current model.
Exact versioned names are valid only after verifying that this installed Claude
CLI accepts that exact string; `claude-opus-4-7` is an example after a
successful smoke in this environment. For example, a Claude state may set
`model: opus` for a versionless alias or `model: claude-opus-4-7` for an
exact versioned name. Do not reuse Kiro model ids or stale versioned strings
for Claude states. Before pinning or documenting a Claude exact versioned
name, verify it with a small `claude -p --model <name>` smoke; Tychonic only
passes the string through. During execution, if a CLI reports the concrete
selected model and it differs from an exact versioned model string in state
config, Tychonic fails the activity instead of accepting a silent model
change. Claude aliases such as `opus` are not exact-match asserted because the
CLI resolves them to concrete model names internally.

The bundled reference examples currently declare `model: gpt-5.5` for `codex`,
`model: gemini-3.1-pro-preview` for `gemini`, and `model: claude-opus-4.6` for
`kiro` where those exact strings fit the author's environment. Some examples
also declare `reasoning_effort: max` for `claude` and `reasoning_effort: xhigh`
for `codex`; `gemini` and `kiro` do not expose a supported reasoning effort
setting through Tychonic. These values do not define a universal model choice.
Target account, model availability, plan/tier, quota, pricing, region/country
access, and organization policy differ by operator, so Tychonic does not
provide one default workflow profile to reuse unchanged.

Kiro states may set `model`, but not
`reasoning_effort`; the installed Kiro CLI ACP surface exposes no stable
reasoning/effort/thinking option. Kiro model availability may be account-,
tier-, or region-scoped: `kiro-cli chat --list-models` proves what this account
can run, not whether every documented Kiro model id exists globally. Do not
rewrite a documented dot-form Kiro id such as `claude-opus-4.6` solely because
it is not available in the current account. Do not add normalizer model fields;
Tychonic supplies the lightweight normalizer model flag internally (`claude`
gets `haiku`; `codex` gets `gpt-5.3-codex-spark`).

QA/review is allowed to run checks; it is not limited to visual inspection.
The boundary is source modification. Review activities compare the git
worktree before and after the reviewer command when a git worktree is
available; a net source mutation fails the review. Kiro review states may use
`trust_all_tools: true` when they need non-interactive inspection or test
execution, but the Kiro review adapter still rejects direct file writes.
Automated repair belongs in an explicit work state, not inside review.

`resume` is a numeric budget a workflow may read when it explicitly chooses to
continue a recorded session. Omit it unless the workflow needs same-session
continuation.

`policies.<name>` entries are workflow-owned values. The host requires the
top-level `policies` value to be an object, but it does not require each policy
value to be an object or to use the state NAME grammar. A workflow that consumes
a policy validates that policy value's shape. The standard interaction helper
validates the `policies.interaction` shape that it consumes.

## Generated Activity Calls

The installed generated wrapper calls activities through `proxyActivities` from
`@temporalio/workflow`. Bundle authors express those calls by declaring state
TYPE and state NAME in `workflow.yaml`; they do not hand-write activity calls.

Generated wrappers may call these activities:

- `startRunActivity`
- `collectGitFactsActivity`
- `createWorktreeActivity`
- `cleanupWorktreeActivity`
- `runVerifyActivity`
- `runWorkerActivity`
- `runReviewActivity`
- `finalizeRunActivity`

Activity call inputs carry runtime data only: state name, run record, effective
profile, cwd, worktree path, prompt text, session id, and similar values. They
must not choose which command or agent runs.

Activities return `ActivityResult`. They do not mutate `input.run`; workflow
code must merge returned states, attempts, artifacts, sessions, inbox items, and
status into its local run copy. The generated wrapper uses the
`tychonic/workflow` helper surface for that merge path. Parsed failed review
findings are promoted into run-level finding records by the standard helper;
workflow-specific inbox routing remains workflow-owned.

## Workflow Sandbox

Temporal workflow code is deterministic.

- Do not import Node I/O APIs (`node:fs`, `node:child_process`, `node:net`) in
  workflow code.
- Do not make workflow decisions from top-level non-deterministic values.
- Put file, shell, network, and OS work in activities.
- Use `@temporalio/workflow`, `tychonic/workflow`, relative modules shipped in
  the bundle, and installed bundle dependencies. Tychonic provides
  `@temporalio/workflow` and `tychonic/workflow`; other package dependencies
  must be shipped with the bundle.

## Signals

Signal/query names, payload shapes, and recovery behavior must be expressible in
the declarative YAML contract before bundle authors use them. Do not add a
hand-written workflow module to register custom signal/query names.

The installed generated wrapper uses `createTychonicWorkflowContext` and related
`tychonic/workflow` helpers for start/worktree/work/review/finalize bookkeeping
and standard status snapshots. Bundle authors do not hand-write `workflow.mjs`
to call those helpers. If a needed interaction or recovery shape is not
expressible in `workflow.yaml`, update the declarative product contract and
generator first instead of adding a hand-written workflow module.
