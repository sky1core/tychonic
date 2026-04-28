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

Built-in adapters are `claude`, `codex`, `gemini`, `kiro`, and `kiro-acp`.
`claude` and `codex` can serve review states directly. `gemini`, `kiro`, and
`kiro-acp` can serve review states only with `normalizer: claude` or
`normalizer: codex`; the normalizer structures the primary review output and
must not invent findings. Vendor-owned settings such as model name and
reasoning effort stay in the external CLI configuration or an explicit
`command`.

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

Standard interaction names are optional. Register them only if the workflow is
designed to be driven by `tychonic approve`, `tychonic reject`, or
`tychonic modify`:

- `tychonic.interaction.approve_state`
- `tychonic.interaction.reject_state`
- `tychonic.interaction.modify_state`
- `tychonic.interaction.pending_state` query
