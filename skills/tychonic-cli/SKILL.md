---
name: tychonic-cli
description: Use when operating, documenting, or debugging Tychonic CLI workflows, runtime startup, Temporal-backed state, activity-centric configuration, agent permissions, session resume, or verification.
---

# Tychonic CLI

Use this skill when a task involves Tychonic commands, workflow configs,
runtime startup, workflow bundles, agent adapters, session resume, or
verification.

## Product Model

- Temporal workflow history and Temporal APIs are the product state authority.
- Tychonic core ships no host-owned workflows.
- Workflows are installed bundles with `workflow.mjs` and `defaultProfile`.
- Workflow code owns ordering, branching, loops, retry, recovery, and signals.
- Config declares named `states.<name>` blocks and workflow-owned
  `policies.<name>` blocks. It is not a workflow graph.

Do not read `.tychonic/runs` as product state. Use CLI commands backed by
Temporal.

## Health And Runtime

Common checks:

```sh
tychonic temporal doctor
tychonic temporal status
tychonic status
```

Foreground runtime:

```sh
tychonic runtime up --project-dir "$PWD"
```

Detached/isolated instance flags are development tools. Use them only when the
task explicitly needs isolated runtime state. Prefer `tychonic --help` and
command-specific `--help` for uncommon flags instead of copying options into
instructions.

If the runtime cannot bind/connect to the local Temporal API port, report the
smoke as environment-blocked. Do not switch to another operational service to
hide the failure.

## Running Workflows

Install and run a bundle:

```sh
(cd ./examples/workflows/<name> && npm install)
tychonic workflows validate ./examples/workflows/<name>
tychonic workflows install ./examples/workflows/<name>
tychonic run <workflow-name> --input-file ./input.json --wait
```

Inspect a run:

```sh
tychonic status --workflow-id <id> --include-result
tychonic inbox --workflow-id <id>
tychonic artifacts --workflow-id <id>
tychonic artifacts --workflow-id <id> --artifact <art-id>
tychonic logs --workflow-id <id>
tychonic sessions --workflow-id <id>
```

`tychonic run` prints a JSON object. With `--wait`, the Tychonic product
outcome is `result.status`; Temporal completion alone does not mean the
workflow achieved its goal.

Each workflow owns its own input shape, policy keys, artifacts, inbox items,
signals, and recovery flow. Read the bundle README before configuring or
operating that workflow.

## Bundle Config

The installed bundle's `defaultProfile` is the default config source.
`--config <file>` replaces that profile for one invocation as a whole object.
There is no merge.

Workflow input must be a JSON object. Do not put `profile` in `--input` or
`--input-file`; Tychonic reserves that field for the effective config it
passes internally to workflow code.

Minimal state profile shape:

```yaml
version: tychonic.config.v1
states:
  work:
    type: work
    agent: codex
  verify:
    type: verify
    command: |
      npm run typecheck
      npm run build
      npm test
  review:
    type: review
    agent: claude
```

Use optional fields only when they express behavior the workflow actually
needs. Do not add `resume`, permission, sandbox, timeout, or policy knobs just
because the schema accepts them.

Allowed state-block fields are `type`, `agent`, `normalizer`, `command`, `resume`,
`timeout`, `sandbox`, `approval`, `permission_mode`, and `trust_all_tools`.
Vendor-owned values such as model name, reasoning effort, thinking budget, and
provider approval mode belong in the external CLI config or in an explicit
`command`.

## Agents

Use `agent: "<name>"` for built-in adapters:

| Agent | Worker | Review | Same-session resume |
|---|---:|---:|---:|
| `claude` | yes | yes | yes |
| `codex` | yes | yes | yes |
| `kiro-acp` | yes | with normalizer | yes |
| `kiro` | yes | with normalizer | yes |
| `gemini` | yes | with normalizer | no |

Use `command` only as an escape hatch for custom CLIs, unusual flags, or test
stubs. A state sets exactly one of `agent` or `command`.

For review states, `gemini`, `kiro`, and `kiro-acp` require `normalizer:
claude` or `normalizer: codex`. The primary agent performs the review; the
normalizer structures that output into the semantic review payload.

Use `kiro-acp` rather than `kiro` for Kiro worker states when the installed
Kiro CLI supports ACP. The plain `kiro` adapter is the legacy chat-wrapper
path.

`TYCHONIC_AGENT_PATH` prepends directories to the agent CLI lookup path. Use it
when a smoke test or local setup needs Tychonic to find agent binaries outside
the normal `PATH`, for example a temporary stub directory or a locally installed
CLI. It is not workflow config and ordinary workflow input should not mention
it.

Built-in review adapters ask the model for the semantic payload:

```json
{
  "status": "pass",
  "summary": "all checks satisfied",
  "findings": []
}
```

The host normalizes built-in reviewer output into `tychonic.review.v1`.
Escape-hatch `command` reviewers bypass that normalization, so their stdout
must emit the full documented wire object.

## Workflow Authoring

When writing or changing a workflow bundle, read
[workflow-module-contract.md](./workflow-module-contract.md). Keep workflow
code deterministic and keep file/shell/network work inside activities.

Workflow bundles are normal package directories. Install dependencies in the
bundle directory before `tychonic workflows install`. Tychonic does not run
`npm install`, synthesize `node_modules`, add symlinks, or rewrite resolver
paths.

## Waiting User And Signals

`waiting_user` means the workflow decided it cannot proceed automatically.
Recovery is workflow-defined. Many workflows require a fresh run with adjusted
input or config; interactive workflows may remain parked and accept signals.

Use documented workflow signals only:

```sh
tychonic signal <workflow-id> <signal-name> --payload-file ./payload.json
```

For workflows that register standard interaction signals, use:

```sh
tychonic approve <workflow-id>
tychonic reject <workflow-id> --feedback "..."
tychonic modify <workflow-id> --note "..."
```

## Verification

Use the gate that matches the environment:

```sh
npm run verify:worker
npm run verify
```

`verify:worker` is the in-worktree gate. `verify` adds release checks that may
need network access and should run on the source tree after applying a patch.
Do not add conditional skips or offline shims to make the wrong gate pass.

Live agent resume checks use real authenticated agent CLIs and may consume
provider quota:

```sh
npm run verify:agents-live
```

## Guardrails

- Use Temporal-backed CLI commands for state.
- Do not add repo-local workflow state stores.
- Do not fake bundle resolution with symlinks, copied host `node_modules`, or
  environment rewrites.
- Keep user-facing docs focused on product behavior. Put workflow-specific
  behavior in that workflow's bundle README.
- For notification troubleshooting, use
  [notifications-troubleshooting.md](./notifications-troubleshooting.md).
