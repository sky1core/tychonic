# Tychonic

[한국어 README](README.ko.md)

Tychonic is a macOS-local workflow runner for delegated AI work. It runs
existing agent CLIs and deterministic checks through Temporal, keeps durable
run history, and records the evidence needed to inspect what happened.

It is not a coding agent, chat wrapper, dashboard, or team service. Tychonic is
the orchestration layer around Codex, Claude Code, Gemini CLI, Kiro CLI, shell
checks, and review gates.

## Why Use It

- Run work as explicit workflow states: `work`, `verify`, and `review`.
- Keep run state in Temporal so progress survives CLI exits and restarts.
- Execute agent work in isolated worktrees until the operator applies a result.
- Record prompts, outputs, sessions, artifacts, findings, and inbox items.
- Select the right agent, model, and reasoning effort per state instead of
  forcing one global model.
- Spread work across agent CLIs and model accounts when that is useful for
  quality, cost, or token usage.

Tychonic core ships no built-in workflows. Workflows are installed bundles.
Reference examples live under `examples/workflows/` and are opt-in.

## Requirements

- macOS
- Node.js 22+
- Temporal CLI on `PATH`
- Installed and authenticated agent CLIs for the agents your workflow uses

Tychonic does not currently ship a public web UI/API surface. Use the CLI.

## Install

From a source checkout:

```sh
git clone https://github.com/sky1core/tychonic.git
cd tychonic
npm install
npm run build
npm run install:local
tychonic temporal doctor
```

From npm:

```sh
npm install -g tychonic
tychonic temporal doctor
```

## Quick Start

Install an example workflow bundle:

```sh
(cd examples/workflows/simpleWorkflow && npm install)
tychonic workflows install ./examples/workflows/simpleWorkflow
```

Start the local runtime in one terminal. This starts Temporal if needed and
runs the worker.

```sh
tychonic runtime up --project-dir "$PWD"
```

Start a run from another terminal:

```sh
cat > ./simple-workflow-input.json <<'JSON'
{
  "cwd": "/absolute/path/to/a/git/repo",
  "goal": "Implement the requested change and leave evidence in artifacts."
}
JSON

tychonic run simpleWorkflow --input-file ./simple-workflow-input.json --wait
```

`tychonic run --wait` prints JSON. The product outcome is `result.status`; a
successful CLI command only means the workflow returned a result.

Inspect a run:

```sh
tychonic status --workflow-id <id> --include-result
tychonic inbox --workflow-id <id>
tychonic artifacts --workflow-id <id>
tychonic logs --workflow-id <id>
tychonic sessions --workflow-id <id>
```

## Workflow Config

A workflow bundle contains `workflow.mjs` and a `defaultProfile`. The workflow
author owns that profile. A run can replace it with `--config <file>`, but the
replacement is whole-object replacement, not merge.

Workflow JSON input is task data only. Do not put config under `profile`;
Tychonic reserves that field for the effective profile it passes into workflow
code.

Recommended profile pattern:

```yaml
version: tychonic.config.v1
states:
  work:
    type: work
    agent: codex
    model: gpt-5.5
    reasoning_effort: xhigh
  verify:
    type: verify
    command: |
      npm run typecheck
      npm run build
      npm test
  review:
    type: review
    agent: claude
    model: opus
    reasoning_effort: max
```

`model` is recommended for repeatable agent states. `reasoning_effort` is
recommended for Claude/Codex states whose quality depends on reasoning depth.
Other knobs such as `resume`, permissions, sandbox, timeout, trust, and policy
settings should appear only when the workflow behavior needs them.

Use `agent: "<name>"` for built-in adapters. Use `command` only as an escape
hatch for custom CLIs, unusual flags, or test stubs. A state sets exactly one
of `agent` or `command`.

## Built-In Agents

| Agent | Work | Review | Same-session resume |
|---|---:|---:|---:|
| `claude` | yes | yes | yes |
| `codex` | yes | yes | yes |
| `kiro` | yes | with normalizer | yes |
| `gemini` | yes | with normalizer | no |

For review states, `gemini` and `kiro` require `normalizer: claude` or
`normalizer: codex`. The primary agent performs the review; the normalizer only
structures that output into Tychonic's review result.

Kiro uses ACP session APIs for session capture and resume. Kiro review states
may inspect files and run checks, but the adapter rejects direct file writes
and fails the review if tracked files change during the review turn.

## Example Workflows

- `verifyOnlyWorkflow`: no-agent runtime smoke.
- `simpleWorkflow`: one work state, one verify state, one review state.
- `architectBuilderQaWorkflow`: standard architect/build/QA pattern.
- `architectBuilderKiroQaWorkflow`: Kiro performs QA review, then a normalizer
  structures the verdict.
- `architectBuilderKiroRepairQaWorkflow`: Kiro performs a pre-review repair
  pass before final structured QA.

Read each bundle's `README.md` before changing its input or config shape.

## Agent Skill

Install the included skill when an agent CLI should operate Tychonic directly:

```sh
npx skills add ./skills -a claude-code codex
```

Pass `-a` intentionally; otherwise the installer may target every detected
agent.

## Security

Tychonic is designed for a single local operator. It currently exposes the CLI
as the public control surface; do not wrap it in an unauthenticated network
service.

Do not put literal tokens, passwords, or private keys in workflow commands. Use
the agent CLI's auth store or inherited environment references.

macOS notifications use the normal system notification permission. If a
notification does not appear, open System Settings -> Notifications and allow
`TychonicNotify`. Detailed troubleshooting is in
[notifications-troubleshooting.md](skills/tychonic-cli/notifications-troubleshooting.md).

## More Documentation

- [SPEC.md](SPEC.md): product contract
- [docs/plugin-workflows.md](docs/plugin-workflows.md): workflow authoring guide
- [skills/tychonic-cli/SKILL.md](skills/tychonic-cli/SKILL.md): agent-facing CLI operating guide
- [SECURITY.md](SECURITY.md): security boundary and reporting
- [AGENTS.md](AGENTS.md): repository rules for contributors and agents
- [GUARDRAILS.md](GUARDRAILS.md): repeated project-specific failure patterns
