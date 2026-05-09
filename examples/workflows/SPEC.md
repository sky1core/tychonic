# Example Workflows SPEC

This file applies to reference workflow bundle sources under
`examples/workflows/`.

Reference example bundles are opt-in source material for workflow authors. They
are not host defaults, not bundled execution paths, and not universal
recommendations for every operator account.

Each example workflow directory is a normal workflow bundle source. It must
contain:

- `workflow.mjs`
- `runInput.mjs`
- `README.md`

Example bundle names, state NAMEs, prompts, policies, model strings, and agent
selections exist to demonstrate the bundle contract. Operators must adapt them
to their own installed agent CLIs, model access, quota, pricing, region/country
availability, and organization policy before installing and running them.

An example README documents only that example's workflow-owned contract:
state order, promptable state NAMEs, policy keys, signals, and recovery paths.
It must not describe the example as a built-in workflow, official default, or
host-provided workflow.
