# Workflow Module Authoring Contract

When writing or changing workflow modules, follow this contract exactly.

## Bundle shape

A workflow module is a **bundle directory** containing `workflow.mjs`.
It may also be a normal package directory with `README.md`,
`package.json`, lockfiles, `node_modules`, helper modules, and assets.
The bundle directory name equals the name of the workflow function
exported from `workflow.mjs` — the same name users pass to
`tychonic run <name>`. `workflow.mjs` must also export a `defaultProfile` object: a
`TychonicConfig` (`version: "tychonic.config.v1"`) declaring the
`states.<name>` and `policies.<name>` blocks the workflow depends on.

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

`defaultProfile` is the workflow's author-supplied default profile. It
is the sole source of configuration for the workflow at install and run
time, and is the value `tychonic run` substitutes into `input.profile`
when the operator does not supply one. `tychonic workflows install
<directory>` validates the bundle file shape, parses `workflow.mjs` as
an ES module AST, extracts the `defaultProfile` object, parses it under
`TychonicConfigSchema`, and refreshes the operational LaunchAgent worker
when that worker is installed. A `--config <file>`
override on any signal-emitting command replaces the entire profile for
that one invocation; the override file uses the same
`tychonic.config.v1` shape in YAML or JSON.

## Core Concepts

- **Workflow module**: a compiled Temporal workflow export installed into the
  runtime workflow module registry. This is the executable runtime product
  surface.
- **Workflow**: TypeScript Temporal code that decides order, branching, loops,
  retries, joins, and stop conditions.
- **State**: a named position in that workflow's state machine. State names are
  product-facing identifiers and are unique within a run.
- **Activity**: backend execution code selected by a state's `type`. Activities
  are not workflow graphs and do not decide next-state ordering.

Never collapse these concepts into one another.

- `defaultProfile` declares named state blocks and policies.
- Workflow code decides graph shape and state transitions.
- Activities execute one state invocation at a time.
- A state name is not an adapter type, and an activity type is not a workflow.

If a proposed change starts describing workflow order in config, or starts
treating an activity adapter as if it were the workflow itself, stop and fix
the design first.

- Workflow modules are the runtime product surface. They are installed into
  the runtime workflow module registry and executed from there.
- Tychonic ships no bundled workflows inside the host package. Every workflow
  the runtime executes is operator-installed, with no source-tree exceptions.
- Do not create or preserve a second "built-in" execution path in source
  code for a workflow or adapter that also exists as an installed module.
- Runtime code must execute workflow modules plus state config blocks.
  Built-in agent adapter behavior belongs behind the adapter boundary;
  workflow code selects it with `agent: "<name>"`, not by spelling out
  vendor CLI flags.

Public adapter contract for workflow modules:

- `agent` is the primary path for the four built-in adapters:
  `claude`, `codex`, `gemini`, and `kiro`
- `command` is an escape hatch for custom CLIs, unusual flags, or test stubs
- `resume` is a numeric budget (default `0`) for workflows that explicitly
  choose to call a resume activity; there is no `resume_command` field
- reviewer activities with `type: "review"` must emit the structured
  `tychonic.review.v1` contract from their selected adapter or command;
  the config block does not declare a separate `emits` field

## State Authoring Rules

- State names are explicit product contract. Do not create alias paths or
  hidden fallback names for the same state.
- Workflow code must call activities by state name, not by inferred type.
- A state block configures one state. It must not encode edges, loops, or
  branching rules.
- `resume` is a state-level continuity budget, not a second workflow path.
- If the same capability appears once through a state command and again through
  a built-in shortcut, the design is wrong; keep exactly one execution path.

When delegating workflow-module work, explicitly state all of these:

- the installed-module path is the only runtime path
- package workflow modules must remain ordinary runtime modules
- do not add built-in Codex/Claude/Gemini/Kiro adapter branches
- do not maintain the same capability through both command and built-in
  preset paths

If a requested change appears to need a second execution path ("quick
built-in shortcut", "auto command generation", "special-case source-tree
workflow"), stop and report that it violates the workflow-module contract.

## Activities Available To A Bundle

A bundle's `workflow.mjs` reaches Tychonic activities through
`proxyActivities` from `@temporalio/workflow`. The host registers exactly
this set on the worker, and a bundle composes them in whatever order its
state machine needs:

- `runLintActivity`
- `runUnitTestActivity`
- `runIntegrationActivity`
- `runVerifyActivity`
- `runWorkerActivity`
- `runResumeWorkActivity`
- `runAutoContinueActivity`
- `runReviewActivity`
- `startRunActivity`
- `collectGitFactsActivity`
- `createWorktreeActivity`
- `finalizeRunActivity`

Each activity accepts a state `name`, the run record, the effective profile,
and explicit TYPE-specific runtime fields such as `prompt`, `worktreePath`,
`sessionId`, or `verificationCommands`. Runtime fields must not select the
command or agent; execution selection belongs to the state config block.
See SPEC §"State Identity And Activity TYPE" for the NAME/TYPE contract and
SPEC §"Activity Invariants" for what every activity guarantees.

Skeleton bundle:

```js
import { proxyActivities, setHandler, defineSignal, defineQuery, condition } from "@temporalio/workflow";

const { runWorkerActivity, runVerifyActivity, runReviewActivity } =
  proxyActivities({ startToCloseTimeout: "1 hour" });

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
    review: { type: "review", agent: "claude" }
  },
  policies: { loop: { auto_continue: true, max_review_iterations: 3 } }
};

export async function myWorkflow(input) {
  // ... compose activity calls, gating, and signal handling here.
}
```

The exported function name must equal the bundle directory name and is the
name users pass to `tychonic run <name>`.

## Signal Handlers

A workflow may register any signal handler it needs through Temporal's
`defineSignal` + `setHandler`. Tychonic's host CLI sends signals through
`tychonic signal <workflow-id> <signal-name> [--payload-file <file>]`; the
signal name and payload shape are part of the bundle's public contract.

Two host-controlled signal names that bundles **may opt into** by
registering matching handlers:

- `tychonic.interaction.approve_state` / `tychonic.interaction.reject_state`
  / `tychonic.interaction.modify_state` — the three signals delivered by
  `tychonic approve|reject|modify`. Bundles that gate states through
  `waitForStateApproval` (or implement equivalent gating directly) handle
  these. The payload shapes are documented in SPEC §"Workflow Model →
  `waitForStateApproval`".

Every other signal name is workflow-defined. Document each registered name,
its payload shape, and what it does in the bundle's `README.md` so
operators know exactly which `tychonic signal` invocations recover the run.
