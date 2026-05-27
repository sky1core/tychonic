# Service Module SPEC

This file applies to macOS service and LaunchAgent helpers under
`src/service/`.

## LaunchAgent Boundary

LaunchAgent service mode is part of the local runtime contract documented in
`src/runtime/SPEC.md`.

Service helpers may install, inspect, restart, or uninstall the documented
Tychonic LaunchAgents (`com.tychonic.temporal`, `com.tychonic.worker`, and
`com.tychonic.web`) through the CLI paths that own those operations. They must
not create alternate runtime state stores or infer workflow state from launchd
process state.

Service mode must run from an installed package build by default, not a mutable
source checkout. Agent CLI discovery must use the deterministic resolver shared
with foreground runtime mode.

Operational LaunchAgent service mode and the operational `runtime up` daemon are
mutually exclusive operator paths. Once the Tychonic LaunchAgents are loaded,
operators inspect/manage that runtime through `tychonic service status` and the
service commands; they must not start a second operational runtime with
`tychonic runtime up`. Named `runtime up --instance <name>` development runtimes
remain separate from operational LaunchAgents.
Conversely, `service install` refuses while a verified operational
`tychonic runtime up` daemon is running; the operator must stop the manual
runtime before installing the LaunchAgent set.

`service install` refreshes only workflows already present in the operational
runtime module registry. It must not seed examples or any other host-owned
workflow. The refresh validates all installed `workflow.yaml` files and
regenerates generated workflow artifacts before LaunchAgents are written or
reloaded; any validation failure, including a missing built-in agent executable
required by an installed workflow, aborts the service install before service
processes are touched.
