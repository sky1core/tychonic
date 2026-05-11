# Runtime Module SPEC

This file applies to local runtime and service operations under `src/runtime/`
and related service code.

## Runtime

Runtime modes:

- `managed-local`: Tychonic starts or reuses local Temporal and runs the worker
  either in the foreground or through macOS LaunchAgents.
- `external`: the user provides Temporal address, namespace, and task queue for
  an explicitly configured single-user runtime. This does not make remote/team
  deployment part of the public alpha scope.

Both modes use Temporal APIs for state. Tychonic never reads Temporal
persistence files directly.

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

## Isolated Dev Instances

Tychonic's local runtime supports **named isolated instances** for workflow
development and integration smokes. An instance is a deterministic derivation of
the operational runtime paths and Temporal connection parameters from a single
name. It is not a new domain concept: the operational runtime has no named
instance, and Temporal workflow history remains the sole Source Of Truth. The
name `instance` is chosen to avoid collision with `profile` (already used for
workflow configuration snapshots), `namespace` (the Temporal logical isolation
unit), and `environment` (which would imply a deployment pipeline not present in
this single-user product).

An instance is activated by `--instance <name>` on any Tychonic CLI command, or
by `TYCHONIC_INSTANCE=<name>` in the shell environment. When both are set,
`--instance` wins. When neither is set, the command targets the operational
paths.

Instance names must match `^[a-z][a-z0-9-]{0,31}$`. The names `default`,
`prod`, `production`, and `service` are reserved and rejected. The allowed
character set is the intersection of what is safe inside filesystem paths,
launchd labels, and Temporal task-queue identifiers.

When an instance is active, Tychonic derives the following values from `<name>`
and uses them in place of the operational defaults:

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

Instance activation never creates a registry file, an entry in a global index,
or any other secondary record of the instance's existence. The presence of
`<default-state>/instances/<name>/` is the only artifact; nothing else tracks
which instances have ever been used.

Explicit overrides still win over instance-derived values at the field level.
The field-level precedence is **explicit > instance-derived > operational
default**, applied independently to each of:

- `--temporal-mode`, `--temporal-port`, `--temporal-address`,
  `--temporal-task-queue`, `--temporal-namespace`
- `$TYCHONIC_STATE_HOME`, `$TYCHONIC_LOG_HOME`

This is the same replace-not-merge precedence that applies between a bundle's
`defaultProfile` and `--config <file>`, scoped to a single CLI invocation. There
is no block-level replacement and no implicit merging across fields. When
`$TYCHONIC_STATE_HOME` or `$TYCHONIC_LOG_HOME` is set while an instance is
active, the explicit env value wins and Tychonic emits a warning on stderr
identifying which instance-derived path was overridden.

Operational launchd services (`com.tychonic.temporal`, `com.tychonic.worker`)
are not touched by any command run under an instance. The `service` command
group (`service install`, `service status`, `service uninstall`,
`service restart-worker`, `service terminate-worker`) rejects invocation while
an instance is active. `workflows install <bundle>` and `workflows remove` under
an instance copy or delete bundle files in the instance's module registry only —
they never replace a LaunchAgent worker, and the command output carries a note
instructing the operator to restart `tychonic runtime up --instance <name>` to
pick up the change.

**Bundle registry starts empty.** A fresh instance has no workflow bundles.
`service install` is rejected under an instance, and the operational path itself
ships no bundled workflows: every bundle reaches the registry through
`tychonic workflows install <directory>`. The operator therefore calls
`tychonic workflows install <directory> --instance <name>` for every bundle the
instance needs (for example, any directory under `examples/workflows/`, or a
hand-authored bundle). Tychonic makes no distinction between sources; all
bundles flow through the same install path. `runtime up --instance <name>`
refuses to start (both foreground and `--detach`) when the instance's module
registry is empty, so the operator gets the correct guidance to install the
bundles they need instead of a detached child that dies silently a few seconds
after reporting a PID.

Lifecycle commands:

- `tychonic runtime up --instance <name>` — starts Temporal if needed and runs
  the worker in the foreground. It records the runtime parent PID in
  `<instance-state>/runtime.pid` and removes that PID file on normal process
  exit when it still owns the file.
- `tychonic runtime up --instance <name> --detach` — spawns the same runtime in
  a new session and exits. Writes the child PID to
  `<instance-state>/runtime.pid` and appends stdout/stderr into
  `<instance-log>/runtime.log`. Requires `--instance`; `--detach` is not
  available on the operational path. If a live PID already occupies the PID
  file, the command refuses rather than overwriting it.
- `tychonic runtime stop --instance <name>` — sends SIGTERM to the runtime PID
  recorded in `<instance-state>/runtime.pid`, waits for it to exit, removes only
  that PID file, and then asks the same instance's managed-local Temporal
  process to stop if one remains. It never escalates to SIGKILL and never
  removes state or log directories. If the runtime process remains alive, the
  command reports timeout instead of forcing cleanup.
- `tychonic workflows install <bundle> --instance <name>` — copies the bundle
  into `<instance-state>/workflows/modules/<name>/`. Does not call any launchd
  operation. The JSON response includes a note that the operator must restart
  `runtime up --instance <name>` for the worker to load the new bundle.
- `tychonic runtime reset --instance <name>` — terminates any runtime recorded
  in the instance PID file (SIGTERM, 10 second wait, SIGKILL), then removes
  `<instance-state>/` and `<instance-log>/`. Rejects invocation without
  `--instance`; operational paths are never reset through this command. Without
  `--yes`, it prints the paths it is about to remove and reads a confirmation
  from stdin. AI agents pass `--yes` for non-interactive cleanup.

Instance isolation changes only the runtime directory layout and the Temporal
connection parameters the CLI generates. It does not change the bundle
configuration schema, the workflow code, the workflow configuration snapshot, or
the rule that Temporal workflow history is the sole Source Of Truth. The
instance's Temporal DB file is a different file on disk from the operational DB,
and the two catalogues do not share workflow identities even when both use the
`default` namespace.

The derivation uses standard mechanisms only: existing `TYCHONIC_STATE_HOME` and
`TYCHONIC_LOG_HOME` env rules, the commander program's global option and
`preAction` hook, the Temporal CLI's existing port and namespace flags, and
POSIX `start_new_session` for `--detach`. No staging directory, symlink array,
or private node_modules layout is introduced for instance resolution.

## Bundle Layout On Disk

Installed workflow bundles live under `<state>/workflows/modules/<name>/`, where
`<state>` is `tychonicRuntimeDirs().stateDir` (macOS default:
`~/Library/Application Support/Tychonic`).

Each bundle directory contains at minimum:

- `workflow.mjs`

It may also contain `README.md`, `package.json`, lockfiles, `node_modules`,
relative support modules, and pre-bundled assets. This mirrors the install-time
bundle contract in `src/temporal/SPEC.md`: Tychonic provides the
`@temporalio/workflow` and `tychonic/workflow` imports, while all other package
dependencies resolve through the installed bundle directory's standard package
layout. Tychonic does not add arbitrary host `node_modules`, symlinks, or
private resolver state when the worker bundles installed workflows.
