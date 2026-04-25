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
  only lands when you read it and run `tychonic simple_workflow:patch --apply`.
- **Review is an enforced gate, not decoration.** A reviewer must
  return a structured verdict. Malformed or chatty output is routed
  to a triage inbox instead of quietly passing the loop.
- **Agent memory survives across iterations, and every session is
  transparent.** When review fails and the loop continues, the worker
  resumes the same conversation with its goals, prior edits, and
  review feedback intact. Each run also records the external session
  id, prompts, responses, live stdout/stderr, diffs, and review
  verdicts as on-disk artifacts — watch live, audit after the fact,
  or reattach manually with the agent's own CLI.
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
- localhost-only Web API and experimental local operator UI
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

> Set up Tychonic to run `simpleWorkflow` in this repo with Codex as the worker,
> `npm test` as verify, and `holdOpenOnWaiting: true` in the workflow input.

The agent reads the skill and drives the CLI, so you do not need to
memorise Tychonic's flags or YAML schema up front.

## Runtime

Foreground runtime:

```sh
tychonic runtime up --cwd "$PWD"
tychonic runtime up --cwd "$PWD" --no-web
tychonic runtime up --cwd "$PWD" --frontend-port 9233 --ui-port 10233
```

Service runtime:

```sh
tychonic service install --project-cwd "$PWD" --web-port 8765
tychonic service install --project-cwd "$PWD" --frontend-port 9233 --ui-port 10233
tychonic service status
tychonic service uninstall
```

Both modes use Temporal workflows. `runtime up` keeps the worker in the current
terminal. `service install` runs the same worker path through macOS LaunchAgents.

Managed-local defaults:

- frontend: `127.0.0.1:7233`
- UI: `127.0.0.1:8233`
- namespace: `default`
- task queue: `tychonic`

If another local Temporal is already using those ports, start Tychonic with a
different frontend/UI pair. `--frontend-port` rewrites the managed-local
frontend address; `--ui-port` rewrites the managed-local UI port.

For a trusted single-user external Temporal runtime, pass `--mode external`,
`--address`, `--namespace`, and `--task-queue` to runtime, workflow, or status
commands. For a managed-local runtime running on a non-default frontend port,
use the same `--address` on follow-up commands that connect to it.

```sh
# Start managed-local Temporal on non-default ports.
tychonic runtime up --cwd "$PWD" --frontend-port 9233 --ui-port 10233

# Point follow-up commands at that frontend.
tychonic temporal doctor --address 127.0.0.1:9233
tychonic status --address 127.0.0.1:9233
```

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
A bundle is a directory with exactly `workflow.mjs` + `config.yaml` (and an
optional `README.md`). The bundle's `config.yaml` is the only config source
for that workflow.

State config blocks inherit per-type timeout defaults; see
[SPEC.md](SPEC.md#activity-contract) for the full table. Multi-line
commands run in fail-fast shell mode.

### File format

A config file has two top-level groups: `states.<name>` blocks and
`policies.<name>` blocks. Each block is self-contained. Allowed fields
inside a state block are exactly `type`, `agent`, `command`,
`resume_command`, `timeout`, `sandbox`, `approval`, `permission_mode`,
`trust_all_tools`, and `emits` (review TYPE only). Vendor-owned
pass-through values such as `model`, `reasoning_effort`, and
`thinking_budget` belong in the external agent CLI's own config or in the
explicit `command` / `resume_command` strings, not as Tychonic config fields.

```yaml
version: tychonic.config.v1
states:
  verify:
    type: verify
    command: |
      npm run typecheck
      npm test
    timeout: 45m
  review:
    type: review
    agent: codex
    command: codex exec --skip-git-repo-check --json -
    emits:
      - tychonic.review.v1
policies:
  integration:
    mode: disabled
    position: final_gate
```

Validate a bundle before installing it:

```sh
tychonic workflows validate ./examples/workflows/pipelineWorkflow
```

### Interactive mode

Add `policies.interaction.mode: interactive` to a bundle's `config.yaml`
to gate every state transition on an external decision:

```yaml
policies:
  interaction:
    mode: interactive
    max_reject_iterations: 3
```

With `mode: interactive` the workflow pauses after each activity call
and waits for one of three CLI signals, targeting the state that just
finished:

- `tychonic approve <workflow-id> [--state <name>]` — proceed to the next
  state.
- `tychonic reject <workflow-id> [--state <name>] --feedback <text>` —
  re-run the same state with the feedback string threaded into the next
  attempt. Bounded by `max_reject_iterations` (default 5). This cap is
  independent of `policies.loop.max_review_iterations`, which bounds the
  internal review-fail → work-retry loop.
- `tychonic modify <workflow-id> [--state <name>] [--status <status>]
  [--reason <text>] [--note <text>] [--patch-file <path.json>]` — overlay
  a `StateRecordPatch` on the latest state record for `<name>`.

Omitting the block is identical to `mode: auto`. `--state` is optional
for the three commands; when absent, the CLI queries the workflow's
currently-awaited state name.

### Bundle install

Bundles are installed through the runtime workflow module registry. The
install command also replaces the LaunchAgent worker in the same step
when the service is installed:

```sh
tychonic workflows install ./examples/workflows/pipelineWorkflow
tychonic workflows remove  pipelineWorkflow
tychonic workflows list
```

Workflow selection happens at invocation time, using the exact workflow
export name (which equals the bundle directory name) and explicit JSON
input:

```sh
tychonic run simpleWorkflow      --input-file ./simple-workflow-input.json
tychonic run checkpointWorkflow  --input-file ./checkpoint-input.json
tychonic run selfRepairWorkflow  --input-file ./self-repair-input.json
```

### Overriding a bundle's config

A one-off override replaces the bundle's `config.yaml` as a single whole
object for one invocation or signal. Pass `--config <file>` on the
relevant CLI command. The override file must be self-contained: there is
no field-level merge.

```sh
tychonic config show --workflow simpleWorkflow --config ./one-off.yaml
tychonic inbox execute <item-id> --workflow-id <wf> --config ./one-off.yaml
```

Running workflows never re-read any config file.

### Example configs

The packaged product workflows each ship their own bundle under
`workflows/` in this repository:

- `workflows/simpleWorkflow/` — `simpleWorkflow` bundle (work → verify →
  review loop with Claude as the default worker)
- `workflows/checkpointWorkflow/` — `checkpointWorkflow` bundle with
  lint, unit_test, integration, semantic review, and test-review
- `workflows/selfRepairWorkflow/` — `selfRepairWorkflow` bundle for
  iterative bug detection, regression tests, fixes, and re-scan

Operator-supplied example bundles live under `examples/workflows/`:

- `examples/workflows/pipelineWorkflow/` — 7-stage pipeline with two
  review-TYPE instances sharing the same activity function

## Plugin Workflows

A custom workflow is a bundle directory with a compiled ESM
`workflow.mjs` plus its `config.yaml`. Install with:

```sh
tychonic workflows install ./examples/workflows/pipelineWorkflow
```

The same command replaces the worker so the new bundle loads. See
[docs/plugin-workflows.md](docs/plugin-workflows.md) for the authoring
guide and [examples/workflows/pipelineWorkflow/](examples/workflows/pipelineWorkflow)
for a working reference.

## Worker Session Continuity

[Why Tychonic](#why-tychonic) summarises the continuity guarantee. This
section documents how it works and what happens when it can't.

Tychonic only resumes a worker when the workflow has an explicit
`resume_command` for that worker session. That command can come from the
state config block itself, from CLI input, or from an explicit session
registration. When a review fails and auto-continue fires, the next work
activity uses that stored `resume_command`; otherwise the next work
activity runs as fresh work.

Each review runs as its own short-lived reviewer session. The worker's
session is the one that persists; the reviewer's is one-shot. Temporal
workflow history plus the recorded worker session metadata are what
make that continuity survive process restarts, service redeploys, and
operator recovery signals (`tychonic simple_workflow:continue`, etc.).

If no `resume_command` exists for the worker session, Tychonic leaves the
worker non-resumable. The next work activity runs as fresh work with the
review findings as its only context, and the workflow records the
non-resumable state in run artifacts.

## Resuming A Blocked Simple Workflow

When `simpleWorkflow` exhausts its review iteration budget and the
last review still fails, the run enters `waiting_user`. If the workflow input
set `holdOpenOnWaiting: true`, it remains open for operator signals.

Inbox-level signals process one pending finding at a time:

```sh
tychonic inbox --workflow-id <id>
tychonic inbox execute <item-id> --workflow-id <id> --config <file>
tychonic inbox dismiss <item-id> --workflow-id <id>
```

Or resume the full auto-continue loop with a fresh iteration budget that
sweeps every remaining open inbox item:

```sh
tychonic simple_workflow:continue --workflow-id <id> --max-iterations 5
```

`simple_workflow:continue` reuses the workflow's captured start-time snapshot for
defaults; only explicit flags (`--verify-command`, `--command-timeout`, or
Temporal connection options) apply as CLI-layer overrides. The budget
defaults to the workflow's original `max_review_iterations`, falling
back to 5 when unset.

## Agents

Each activity block runs an explicit `command`. `agent` is optional
metadata only; it labels logs, sessions, and UI output, but it does not
trigger provider-specific command synthesis or defaults. No
separate `agents.<name>` registration exists.

Provider-specific flags belong inside `command` and `resume_command`
strings, owned by the external CLI itself. Tychonic does not define typed
provider settings such as model, reasoning, or thinking-budget fields.
Tychonic-owned orchestration fields such as `sandbox`, `approval`,
`permission_mode`, and `trust_all_tools` remain part of the state-block
schema.

Structured reviewers must emit the `tychonic.review.v1` JSON contract and
declare `emits: ["tychonic.review.v1"]` in config.

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

This runs typecheck, tests, build, example validation, and
guardrails.

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
CLIs and may consume provider quota:

```sh
npm run verify:agents-live
TYCHONIC_LIVE_AGENTS=codex,claude npm run verify:agents-live
```

## Security

The local Web API has no authentication in public alpha. It binds to loopback by
default and refuses non-loopback binds unless `--allow-network-bind` is passed.

Do not put literal tokens, passwords, or private keys in configured commands,
resume commands, or activity commands. Use each agent CLI's auth store or
inherited environment references instead.

## Project Docs

- [SPEC.md](SPEC.md): product contract
- [AGENTS.md](AGENTS.md): repository rules for agents
- [SECURITY.md](SECURITY.md): security boundary and reporting
- [skills/tychonic-cli/SKILL.md](skills/tychonic-cli/SKILL.md): CLI skill

Release notes are published through GitHub Releases.
