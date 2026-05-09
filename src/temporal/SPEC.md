# Temporal Module SPEC

This file applies to Temporal client, worker, workflow module registry, bundle
validation, and run-input preflight code under `src/temporal/`.

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
- every bundle contains `runInput.mjs`. It exports `validateRunInput(input)`.
  `tychonic run` calls that validator with the effective input before starting
  Temporal. Workflow code calls the same validator at workflow start. This is
  the workflow-owned check for task input, `promptAdditions`, and policy values
  after `--config <file>` replacement.
- a bundle may also be a normal package directory: `README.md`, `package.json`,
  lockfiles, `node_modules`, relative support modules, and pre-bundled assets
  are allowed.
  `@temporalio/workflow` and `tychonic/workflow` are part of Tychonic's
  workflow runtime surface and are resolved from the installed Tychonic package
  while the worker bundles workflow code. Bundle authors do not install
  `@temporalio/workflow` just to use Temporal workflow helpers such as
  `proxyActivities`, and do not install `tychonic/workflow` just to publish
  Tychonic's standard run-state snapshot or standard interaction handlers.
  Any other package dependency must be shipped with the bundle: prepare it in
  the bundle directory before `tychonic workflows install`, or pre-bundle it
  into `workflow.mjs`. Tychonic copies the directory tree verbatim and does not
  run a package manager during install.

Bundles are installed with `tychonic workflows install <directory>`.
Installation copies the directory tree verbatim to
`<state>/workflows/modules/<name>/` where `<state>` is
`tychonicRuntimeDirs().stateDir` and validates the bundle (below). The install
command fails if another installed bundle already exports a workflow function
with the same name, or if two bundles would share the same directory name.

`tychonic workflows remove <name>` deletes the installed bundle directory from
the same registry. On the operational service path, install and remove also
refresh the LaunchAgent worker when that worker is installed. Under an isolated
`--instance`, install and remove update only that instance's module registry;
the operator restarts that isolated runtime to load the change.
`tychonic service restart-worker` remains as an independent manual recovery
command for the operational service path.

The runtime workflow module registry is the set of installed bundle
directories. The worker loads every `<name>/workflow.mjs` under that registry
and rejects startup if two bundles contribute the same exported workflow name.
Bundle imports resolve through standard package resolution from the installed
bundle directory, except `@temporalio/workflow` and `tychonic/workflow`, which
resolve to the Tychonic package's own workflow runtime surface. Tychonic does
not inject arbitrary host package `node_modules`, symlinks, or staging resolver
state.

Tychonic ships **no host-owned workflow modules**. A fresh `tychonic service
install` produces an empty workflow module registry. Reference example bundle
files may be present under `examples/workflows/`, including in package installs,
but they are inert files until an operator explicitly installs one with
`tychonic workflows install <directory>`. The operator installs whatever
bundles the project needs — hand-authored, or reference examples — through that
same command. There is no separate host-shipped workflow execution path.

## Workflow-default Profile

A bundle's `workflow.mjs` must export a `defaultProfile` object shaped like a
`TychonicConfig` (`version: "tychonic.config.v1"`) that declares the
`states.<name>` blocks and `policies.<name>` values the workflow depends on:

```js
export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    work:   { type: "work",   agent: "codex" },
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
- The state and policy default values for the workflow live in this one export.
  Workflow-specific input and policy validation lives in `runInput.mjs`. No
  separate manifest, schema file, or JSON companion file exists.

## Install-time Validation

`tychonic workflows install <directory>` performs exactly these checks, in
order. Any failure aborts the install without touching the runtime modules
directory.

1. The source path is a directory.
2. The directory contains `workflow.mjs` and `runInput.mjs`.
3. `workflow.mjs` is parsed as an ES module AST without importing it, creating a
   staging directory, or symlinking `node_modules`. The static inspection must
   find at least one named workflow export (function) and exactly one
   `defaultProfile` export.
4. `runInput.mjs` imports through standard package resolution and exports
   `validateRunInput(input)`.
5. The exported workflow function name equals the bundle directory name.
6. The extracted `defaultProfile` parses under `TychonicConfigSchema`.
7. No other installed bundle exports the same workflow function name.

Install-time validation confirms bundle shape and exported validators. For each
run, `tychonic run` parses the effective profile, calls
`validateRunInput(input)` before starting Temporal, and only then creates the
Temporal workflow. The workflow calls the same validator at start as a runtime
guard. Invalid workflow input or workflow-specific policy values must not enter
a Temporal workflow task retry loop.
