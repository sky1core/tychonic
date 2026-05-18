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
