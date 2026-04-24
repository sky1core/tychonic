# Workflow Module Authoring Contract

When writing or changing workflow modules, follow this contract exactly.

## Bundle shape

A workflow module is a **bundle directory** containing exactly
`workflow.mjs`, `config.yaml`, and optionally `README.md`. The bundle
directory name equals the name of the single workflow function exported
from `workflow.mjs` — the same name users pass to `tychonic run
<name>`. `workflow.mjs` must also export a `requires` object declaring
the state names and types the workflow calls:

```js
export const requires = {
  states: [
    { name: "work", type: "work" },
    { name: "verify", type: "verify" },
    { name: "review", type: "review" }
  ]
};
```

The bundle's `config.yaml` is the sole source of configuration for the
workflow at install and run time. `tychonic workflows install
<directory>` validates the file shape, parses the config, imports the
workflow, cross-checks `requires` against `config.yaml`, and replaces
the worker.

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

- YAML/config declares named state blocks and policies.
- Workflow code decides graph shape and state transitions.
- Activities execute one state invocation at a time.
- A state name is not an adapter type, and an activity type is not a workflow.

If a proposed change starts describing workflow order in config, or starts
treating an activity adapter as if it were the workflow itself, stop and fix
the design first.

- Workflow modules are the runtime product surface. They are installed into
  the runtime workflow module registry and executed from there.
- Workflow exports such as `simpleWorkflow`, `checkpointWorkflow`, and
  `selfRepairWorkflow` are normal runtime workflow modules, not special
  source-tree exceptions.
- Do not create or preserve a second "built-in" execution path in source
  code for a workflow or adapter that also exists as an installed module.
- Runtime code must execute workflow modules plus explicit state
  commands. It must not silently regenerate built-in vendor behavior for
  workers, reviewers, or session resume.

Public adapter contract for workflow modules:

- activity execution is command-only
- `agent` is metadata, not a command synthesis trigger
- `resume_command` is explicit operator-owned data; do not synthesize it
  from a built-in preset
- reviewer activities in a `review` slot must declare
  `emits: ["tychonic.review.v1"]`

## State Authoring Rules

- State names are explicit product contract. Do not create alias paths or
  hidden fallback names for the same state.
- Workflow code must call activities by state name, not by inferred type.
- A state block configures one state. It must not encode edges, loops, or
  branching rules.
- `resume` is a state-level continuity property, not a second workflow path.
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
