# Tychonic

Tychonic is a macOS-local AI work operations manager. It runs existing agent
CLIs and deterministic checks through Temporal so a user can delegate work,
review results, continue failed review/work loops, resume agent sessions, and
inspect evidence from one local control surface.

Tychonic is not a replacement coding agent. It orchestrates tools such as Codex,
Claude Code, Kiro CLI, Gemini CLI, test commands, review commands, Playwright
checks, and task tools.

## Why Tychonic

You want to hand Codex or Claude a multi-hour coding task, walk away,
and come back to a patch you can review. Doing that without Tychonic
breaks in familiar ways: the agent edits files you were using, a
mid-task crash loses everything, and the review output is something
you end up parsing by eye.

Tychonic is for a macOS single-user developer who wants to delegate
that work and come back to a reviewable patch.

- **Leave it running and come back.** Start the task and close the
  terminal; the local service keeps the workflow alive. Laptop sleep,
  a service restart, or a flaky test won't reset progress — Tychonic
  records every activity in Temporal workflow history, so the state of
  a run survives crashes that would wipe a hand-rolled script.
- **Your working copy stays untouched until you approve.** The agent
  works on an isolated copy and produces a proposed diff. The change
  only lands when you read the diff and apply it yourself; each
  workflow's bundle README documents the exact apply step it uses.
- **Review is an enforced gate, not decoration.** A reviewer must
  return a structured verdict. Malformed or chatty output is routed
  to a triage inbox instead of quietly passing the loop.
- **Agent memory can survive across iterations, and every session is
  transparent.** A workflow that wants same-session continuation can
  resume an existing external agent session with its prior context
  intact. The per-state numeric `resume` budget defaults to `0`; bundle
  authors opt into a higher value only when their workflow explicitly
  calls a resume-capable path. Each run also records the agent
  session id, prompts, responses, live stdout/stderr, diffs, and
  review verdicts as on-disk artifacts — watch live, audit after the
  fact, or reattach manually with the agent's own CLI.
- **Any supported agent, your own config, installable by your own
  agent.** Codex, Claude, Gemini, Kiro, or a custom command can play
  worker or reviewer (subject to the role's contract), and your agent
  CLI settings stay in charge while Tychonic drives them. Install the
  included skill and your agent can configure and launch Tychonic for
  you without you memorising its CLI flags. See
  [Agents](#agents) and [Agent Skill](#agent-skill).

What Tychonic is not: a new coding agent, a multi-user platform, or a
web dashboard. Scope is listed in [Status](#status).

## Status

Tychonic `0.1.x` is a public alpha candidate.

Supported:

- macOS single-user local runtime
- Node.js 22+
- TypeScript product path
- managed-local Temporal and explicit external Temporal connection
- local-only Web UI/API
- installed and authenticated external agent CLIs

Not supported:

- remote/team deployment
- multi-user or multi-tenant operation
- public network exposure of the Web API
- non-macOS service management
- stable compatibility guarantees

Read [SECURITY.md](SECURITY.md) before exposing any service.

## Install

From a source checkout:

```sh
git clone https://github.com/sky1core/tychonic.git
cd tychonic
npm install
npm run build
node dist/cli/main.js --help
node dist/cli/main.js temporal doctor
```

When running from source without a global install, replace `tychonic` in examples
with `node dist/cli/main.js`.

For a local package-style install before an npm registry release:

```sh
npm run install:local
tychonic --help
tychonic temporal doctor
```

After an npm registry release:

```sh
npm install -g tychonic
tychonic --help
tychonic temporal doctor
```

## Agent Skill

Install the included skill so your agent CLI (Codex, Claude Code, etc.)
can drive Tychonic on your behalf:

```sh
npx skills add ./skills -a claude-code codex
```

Always pass `-a`; omitting the agent list can install into every detected
agent target.

Once installed, you can ask your agent in plain language — for example:

> Install one of the example workflow bundles under `examples/workflows/`
> (such as `examples/workflows/simpleWorkflow/`) and run it in this repo
> with Codex as the worker and a verify gate that runs typecheck, build,
> tests, and example validation.

The agent reads the skill and drives the CLI, so you do not need to
memorise Tychonic's flags or YAML schema up front.

## Runtime

Foreground runtime:

```sh
tychonic runtime up --project-dir "$PWD"
tychonic runtime up --project-dir "$PWD" --no-web
tychonic runtime up --project-dir "$PWD" --temporal-port 9233
```

Isolated instance runtime stop:

```sh
tychonic runtime stop --instance dev-a
```

`runtime stop` sends SIGTERM to the recorded instance runtime, then also asks
that instance's managed-local Temporal process to stop if one remains. It does
not remove state or log directories. Use `runtime reset --instance <name>` only
for destructive isolated-instance cleanup.

Service runtime:

```sh
tychonic service install --project-dir "$PWD" --web-port 8765
tychonic service install --project-dir "$PWD" --temporal-port 9233 --web-port 8765
tychonic service status
tychonic service uninstall
```

Both modes use Temporal workflows. `runtime up` keeps the worker in the current
terminal. `service install` runs the same worker path through macOS LaunchAgents.

Managed-local defaults:

- Temporal API: `127.0.0.1:7233`
- namespace: `default`
- task queue: `tychonic`

If another local Temporal API endpoint already uses port `7233`, start the
managed-local runtime with `--temporal-port <port>`. Follow-up commands that
connect to that runtime can use the same flag:

```sh
tychonic temporal doctor --temporal-port 9233
tychonic status --temporal-port 9233
```

For a trusted single-user external Temporal runtime, pass
`--temporal-mode external`, `--temporal-address`,
`--temporal-namespace`, and `--temporal-task-queue` to runtime,
workflow, or status commands.

Tychonic uses Temporal APIs only; it does not read Temporal persistence files
directly.

Useful status commands:

```sh
tychonic temporal doctor
tychonic status
tychonic temporal status
```

## Agent CLI Discovery

Built-in agent CLIs are resolved through a stable search path:

1. `TYCHONIC_AGENT_PATH`
2. current process `PATH`
3. `$HOME/.local/bin`
4. `$HOME/.npm-global/bin`
5. `$HOME/bin`
6. `/opt/homebrew/bin`
7. `/usr/local/bin`
8. `/usr/bin`
9. `/bin`

Service mode writes only the stable service path plus `TYCHONIC_AGENT_PATH`.
Do not fix service mode by copying an interactive shell `PATH` into a plist.

## Configuration

A workflow's configuration lives in the **bundle** that ships the workflow.
A bundle is a directory containing `workflow.mjs`. It may also be a standard
package directory with `package.json`, lockfiles, helper modules, and
`node_modules` installed before `tychonic workflows install`. The
`workflow.mjs` exports a `defaultProfile` object that is the only config
source for that workflow.

State config blocks inherit per-type timeout defaults; see
[SPEC.md](SPEC.md#state-config-block-contract) for the full table. Multi-line
commands run in fail-fast shell mode.

### File format

A config file has two top-level groups: `states.<name>` blocks and
`policies.<name>` blocks. Each block is self-contained. Allowed fields
inside a state block are exactly `type`, `agent`, `command`,
`resume`, `timeout`, `sandbox`, `approval`, `permission_mode`,
and `trust_all_tools`. Vendor-owned
pass-through values such as `model`, `reasoning_effort`, and
`thinking_budget` belong in the external agent CLI's own config or in an
explicit escape-hatch `command`, not as Tychonic config fields.

```yaml
version: tychonic.config.v1
states:
  verify:
    type: verify
    command: |
      npm run typecheck
      npm run build
      npm test
      npm run validate:examples
    timeout: 45m
  review:
    type: review
    agent: codex
policies:
  integration:
    mode: disabled
    position: final_gate
```

Validate a bundle before installing it:

```sh
tychonic workflows validate ./examples/workflows/pipelineWorkflow
```

### Interactive workflow commands

Some bundles document an interaction policy and register the interaction
signal/query names that Tychonic's CLI can send. The policy shape and the
effect of approve/reject/modify are owned by that bundle's workflow contract,
not by the host config schema.

The CLI commands are:

- `tychonic approve <workflow-id> [--state <name>]`
- `tychonic reject <workflow-id> [--state <name>] --feedback <text>`
- `tychonic modify <workflow-id> [--state <name>] [--status <status>]
  [--reason <text>] [--note <text>] [--patch-file <path.json>]`

When `--state` is omitted, the CLI queries the workflow for its currently
awaited state name. Bundles that do not register the interaction query require
the operator to pass `--state` explicitly or avoid these commands. See the
bundle README for the exact policy key, signal behavior, and retry semantics.

### Bundle install

Bundles are installed through the runtime workflow module registry. The
install command also replaces the LaunchAgent worker in the same step
when the service is installed:

```sh
(cd examples/workflows/pipelineWorkflow && npm install)
tychonic workflows install ./examples/workflows/pipelineWorkflow
tychonic workflows remove  pipelineWorkflow
tychonic workflows list
```

Workflow selection happens at invocation time, using the exact workflow
export name (which equals the bundle directory name) and explicit JSON
input:

```sh
tychonic run <workflow-name> --input-file ./input.json
```

For a one-off override of the bundle's `defaultProfile` on this single
invocation, also pass `--config <file>`:

```sh
tychonic run <workflow-name> --input-file ./input.json --config ./one-off.yaml
```

After installing one of the example bundles such as
`examples/workflows/simpleWorkflow/`, the same shape becomes:

```sh
tychonic run simpleWorkflow --input-file ./simple-workflow-input.json
```

### Overriding a bundle's config

A one-off override replaces the bundle's `defaultProfile` as a single whole
object for one invocation. Pass `--config <file>` on the relevant CLI
command. The override file must be self-contained: there is no
field-level merge.

```sh
tychonic config show --workflow-name <name> --config ./one-off.yaml
tychonic run <name> --input-file ./input.json --config ./one-off.yaml
```

Running workflows never re-read any config file.

### Example configs

Example workflow bundles live under `examples/workflows/`. Each one is a
user-installable bundle, not a built-in:

- `examples/workflows/pipelineWorkflow/` — 7-stage pipeline with two
  review-TYPE instances sharing the same activity function
- `examples/workflows/simpleWorkflow/` — work / verify / review
  development loop with auto-continue caps and recovery signals
- `examples/workflows/checkpointWorkflow/` — lint, unit_test,
  integration, semantic review, and test-review pipeline
- `examples/workflows/selfRepairWorkflow/` — iterative bug detection,
  regression tests, fixes, and re-scan
- `examples/workflows/architectBuilderQaWorkflow/` — interactive
  three-stage architect / builder / QA pipeline

## Plugin Workflows

A custom workflow is a bundle directory with a compiled ESM
`workflow.mjs` that exports a `defaultProfile`. Install with:

```sh
(cd examples/workflows/pipelineWorkflow && npm install)
tychonic workflows install ./examples/workflows/pipelineWorkflow
```

The bundle is a normal package directory: dependencies must resolve from
that directory through standard package resolution, or be pre-bundled into
`workflow.mjs`. Ordinary workflow bundles should declare
`@temporalio/workflow` in their own `package.json` and run `npm install`
before installation. The install command copies the directory and replaces
the worker so the new bundle loads. See
[docs/plugin-workflows.md](docs/plugin-workflows.md) for the authoring
guide and [examples/workflows/pipelineWorkflow/](examples/workflows/pipelineWorkflow)
for a working reference.

## Agent Session Continuity

[Why Tychonic](#why-tychonic) summarises the continuity guarantee. This
section documents how it works and what happens when it can't.

When a workflow wants same-session continuity, it calls a resume-capable
activity with the prior agent session reference. For built-in adapters that
support automatic same-session resume (`claude`, `codex`, `kiro`), Tychonic
owns the adapter-specific resume invocation behind the adapter boundary.
`kiro` captures the fresh session id by having the same `kiro-cli chat`
process export its own `/chat save` JSON and using that `conversation_id`;
Tychonic never guesses from `kiro-cli chat --list-sessions` before/after
diffs. `gemini` is fresh-run only because its resume surface is not a stable
session id. The numeric
`states.<name>.resume` value defaults to `0` and bounds how many
same-session resumes that workflow may issue for that state. The common
pattern is to place it on a worker-like state, but that is a workflow
convention, not a host rule. Temporal workflow history plus the recorded
agent session metadata are what make continuity survive process restarts
and service redeploys. Each workflow defines its own recovery flow on top
of that — see the bundle's README for the recovery signals it accepts.

The escape-hatch `command` path is literal shell execution. Tychonic does
not infer how a custom command resumes its own session; if a workflow needs
resume-aware custom behavior, that belongs in the workflow or wrapper
contract, not in a separate Tychonic state field.

## Recovery signals

A workflow run reaches a recovery state (typically `waiting_user`) on
the conditions its bundle defines. From there, Tychonic ships a single
host-side recovery verb — `tychonic signal` — and the bundle README
documents the signal names and payload shapes that workflow accepts:

```sh
tychonic signal <workflow-id> <signal-name> --payload-file ./payload.json
```

## Agents

`agent` is the primary path for the four built-in adapters: `claude`,
`codex`, `gemini`, and `kiro`. The host owns command synthesis,
role-aware permission flags, session-id handling, and resume invocation where
the adapter supports same-session resume. No separate `agents.<name>`
registration exists.

`command` is the escape hatch for custom CLIs, unusual flag combinations,
or test stubs. Provider-specific settings such as model, reasoning, or
thinking-budget stay in the external CLI's own configuration or in that
explicit command string. Tychonic-owned orchestration fields such as
`sandbox`, `approval`, `permission_mode`, and `trust_all_tools` remain part
of the state-block schema.

Set exactly one execution selector per executable state: either `agent` or
`command`, not both.

Structured reviewers must emit the `tychonic.review.v1` JSON contract.

## Storage

Product state is owned by Temporal workflow history and Temporal APIs.
Repo-local files are not workflow/run/session/inbox/review state databases.

Default macOS service storage:

- state: `~/Library/Application Support/Tychonic`
- logs: `~/Library/Logs/Tychonic`
- LaunchAgents: `~/Library/LaunchAgents/com.tychonic.*.plist`

Project `.tychonic/` may hold artifacts, live output, patches, temporary
worktrees, and rebuildable projections. These files are not state authority.

## Verification

Verification splits along the worktree boundary. Worker activities
(running in an isolated worktree with no registry access) use the
sandbox-safe gate; release readiness uses the full gate after the
operator has applied a patch to the source tree.

Worker-side gate (runs inside any environment, no network required):

```sh
npm run verify:worker
```

This runs typecheck, tests, build, and example validation.

Release gate (run on the source tree after applying a patch):

```sh
npm run verify
```

Extends `verify:worker` with `npm audit`, `npm publish --dry-run`,
and the package smoke install. Those steps require network access
to the public registry, so they are only meaningful on the
operator's machine — not inside the worker sandbox. See
[SPEC.md](SPEC.md) "Verification Boundary" for the full contract.

Live resume verification uses real installed/authenticated agent
CLIs and may consume provider quota. By default it runs the
resume-capable built-in adapters (`claude`, `codex`, `kiro`). `gemini`
is not in the default set because its built-in adapter has no stable
resume-by-id surface; explicitly selecting it reports `resume_unsupported`.

```sh
npm run verify:agents-live
TYCHONIC_LIVE_AGENTS=kiro npm run verify:agents-live
TYCHONIC_LIVE_AGENTS=codex,claude,kiro npm run verify:agents-live
```

## Security

The Web UI/API is local-only. It has no login and can change workflows, so use
it on `127.0.0.1` only. Do not bind it to `0.0.0.0`, a public IP, or a shared
network. `--allow-network-bind` is only for trusted private-network experiments
and still does not add login.

Do not put literal tokens, passwords, or private keys in configured commands
or activity commands. Use each agent CLI's auth store or inherited
environment references instead.

## Project Docs

- [SPEC.md](SPEC.md): product contract
- [AGENTS.md](AGENTS.md): repository rules for agents
- [SECURITY.md](SECURITY.md): security boundary and reporting
- [skills/tychonic-cli/SKILL.md](skills/tychonic-cli/SKILL.md): CLI skill

Release notes are published through GitHub Releases.
