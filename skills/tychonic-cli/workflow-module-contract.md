# Workflow Module Authoring Contract

Use this when writing or changing workflow bundles.

## Bundle Shape

A workflow bundle is a directory containing `workflow.mjs`. The directory name
must equal the exported workflow function name, and that name is what users pass
to `tychonic run <name>`.

`workflow.mjs` must export `defaultProfile`:

```js
export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    work: { type: "work", agent: "codex" },
    verify: {
      type: "verify",
      command: `npm run typecheck
npm run build
npm test`
    },
    review: { type: "review", agent: "claude" }
  }
};
```

At workflow start, Tychonic injects the effective profile into the workflow
input's reserved `profile` field. Workflow code passes that profile to
activities. Operators pass workflow input as a JSON object and replace config
with `tychonic run --config <file>`, not by putting `profile` in workflow JSON
input.

The bundle may include `README.md`, `package.json`, lockfiles, relative modules
imported by `workflow.mjs`, assets, and `node_modules`. If `workflow.mjs`
imports a package, install that package in the bundle directory or pre-bundle it
into `workflow.mjs`.
Tychonic does not synthesize resolver state during install.

## Boundaries

- Workflow code decides order, branching, loops, retry, gating, and stop
  conditions.
- Config declares named state blocks and workflow-owned policies.
- Activities execute one state invocation at a time.
- State NAME is workflow-defined and product-facing.
- Activity TYPE selects the activity contract.
- Activity TYPE is exactly `work`, `verify`, or `review`; do not create
  narrower TYPES such as architect, builder, QA, repair, or pre-review.
  Express those roles as state NAMEs.

Do not encode workflow graph behavior in config. Do not add source-tree
shortcuts or built-in workflow execution paths.

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

`model` applies to the primary `agent` in the same state block. For repeatable
workflows, pin `model` on states whose quality, latency, or cost profile
matters. `reasoning_effort` is supported by `claude` and `codex`; set it on
Claude/Codex states whose quality depends on reasoning depth. Omitted fields
become omitted CLI flags/config overrides and delegate to the selected external
CLI's default or auto-selection behavior.

For `agent: claude`, use Claude CLI model values. Versionless aliases such as
`opus` let the installed Claude CLI resolve the current model.
Exact versioned names are valid only after verifying that this installed Claude
CLI accepts that exact string; `claude-opus-4-7` is an example after a
successful smoke in this environment. For example, a Claude state may set
`model: opus` for a versionless alias or `model: claude-opus-4-7` for an
exact versioned name. Do not reuse Kiro model ids or stale versioned strings
for Claude states. Before pinning or documenting a Claude exact versioned
name, verify it with a small `claude -p --model <name>` smoke; Tychonic only
passes the string through.

High-model examples should use `model: gpt-5.5` for `codex`,
`model: gemini-3.1-pro-preview` for `gemini`, and
`model: claude-sonnet-4.5` for `kiro` when those exact strings
are available in the installed CLIs. High reasoning examples should use
`reasoning_effort: max` for `claude` and `reasoning_effort: xhigh` for
`codex`; `gemini` and `kiro` do not expose a supported reasoning
effort setting through Tychonic.

Kiro states may set `model`, but not
`reasoning_effort`; the installed Kiro CLI ACP surface exposes no stable
reasoning/effort/thinking option. Do not add normalizer model fields;
Tychonic supplies the lightweight normalizer model flag internally (`claude`
gets `haiku`; `codex` gets `gpt-5.3-codex-spark`).

QA/review is allowed to run checks; it is not limited to visual inspection.
The boundary is source modification. Kiro review states may use
`trust_all_tools: true` when they need non-interactive inspection or test
execution, but the Kiro review adapter rejects direct file writes and fails the
review if tracked files change during the turn. Automated repair belongs in an
explicit work state, not inside review.

`resume` is a numeric budget a workflow may read when it explicitly chooses to
continue a recorded session. Omit it unless the workflow needs same-session
continuation.

## Activities

Bundles call activities through `proxyActivities` from `@temporalio/workflow`.

Available activities:

- `startRunActivity`
- `collectGitFactsActivity`
- `createWorktreeActivity`
- `runVerifyActivity`
- `runWorkerActivity`
- `runReviewActivity`
- `finalizeRunActivity`

Activity call inputs carry runtime data only: state name, run record, effective
profile, cwd, worktree path, prompt text, session id, and similar values. They
must not choose which command or agent runs.

Activities return `ActivityResult`. They do not mutate `input.run`; workflow
code must merge returned states, attempts, artifacts, sessions, inbox items, and
status into its local run copy. Parsed review findings are returned under
`reviewOutcome.result.findings`; workflow code appends them to `run.findings`
and the source state's `finding_ids` when the workflow wants run-level finding
records.

## Workflow Sandbox

Temporal workflow code is deterministic.

- Do not import Node I/O APIs (`node:fs`, `node:child_process`, `node:net`) in
  workflow code.
- Do not make workflow decisions from top-level non-deterministic values.
- Put file, shell, network, and OS work in activities.
- Use only `@temporalio/workflow`, relative modules shipped in the bundle, and
  installed bundle dependencies.

## Signals

A workflow may register any signal/query names it owns. Document each name,
payload shape, and recovery behavior in the bundle README.

Register `tychonic.workflow_state` when the workflow should support
`tychonic run --wait` or `tychonic wait <workflow-id>` before final completion.
The query returns the workflow's current run-result snapshot.

Standard interaction names are optional. Register them only if the workflow is
designed to be driven by `tychonic approve`, `tychonic reject`, or
`tychonic modify`:

- `tychonic.interaction.approve_state`
- `tychonic.interaction.reject_state`
- `tychonic.interaction.modify_state`
- `tychonic.interaction.pending_state` query
