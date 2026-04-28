# Tychonic

Tychonic is a macOS-local work-operations manager for delegated AI work. It
runs existing agent CLIs and deterministic checks through Temporal, records
evidence, and lets workflows continue through work, verify, and review states.

Tychonic is not a coding agent, chat wrapper, dashboard, or team service. It is
the local workflow layer around tools such as Codex, Claude Code, Gemini CLI,
Kiro CLI, shell checks, and review commands.

## What It Does

- Runs workflow bundles through Temporal so run state survives CLI exits and
  restarts.
- Keeps agent work in workflow-owned isolated worktrees until the operator
  applies a result.
- Lets each workflow state choose the right built-in agent or command.
- Records prompts, outputs, sessions, artifacts, findings, and inbox items as
  inspectable evidence.
- Supports same-session resume only where the selected built-in adapter exposes
  a stable resume surface.

Tychonic ships no host-owned workflows. Example bundles live under
`examples/workflows/` and are installed explicitly when you want to try one.

## Requirements

- macOS
- Node.js 22+
- Temporal CLI available on `PATH`
- Installed and authenticated agent CLIs for the agents your workflow uses

The local Web API has no login. Do not expose it to an untrusted network.

## Install

From source:

```sh
git clone https://github.com/sky1core/tychonic.git
cd tychonic
npm install
npm run build
node dist/cli/main.js --help
node dist/cli/main.js temporal doctor
```

Local package-style install:

```sh
npm run install:local
tychonic --help
tychonic temporal doctor
```

Global package install:

```sh
npm install -g tychonic
tychonic --help
tychonic temporal doctor
```

When running from source, replace `tychonic` in examples with
`node dist/cli/main.js`.

## Quick Start

Install an example workflow bundle and start the runtime:

```sh
npm install
npm run build
(cd examples/workflows/simpleWorkflow && npm install)
node dist/cli/main.js workflows install ./examples/workflows/simpleWorkflow
node dist/cli/main.js runtime up --project-dir "$PWD"
```

In another terminal, start a run:

```sh
cat > ./simple-workflow-input.json <<'JSON'
{
  "cwd": "/absolute/path/to/a/git/repo",
  "goal": "Implement the requested change and leave evidence in artifacts."
}
JSON

node dist/cli/main.js run simpleWorkflow --input-file ./simple-workflow-input.json --wait
```

Each workflow owns its own input shape, policy keys, artifacts, and recovery
flow. Read that bundle's `README.md` before writing non-trivial input or config.
For a no-agent runtime smoke, install `examples/workflows/verifyOnlyWorkflow`.
For architect/builder/QA patterns, start with `architectBuilderQaWorkflow`; use
the Kiro variants when Kiro should handle review or pre-review repair work.

Useful inspection commands:

```sh
tychonic status --workflow-id <id> --include-result
tychonic inbox --workflow-id <id>
tychonic artifacts --workflow-id <id>
tychonic logs --workflow-id <id>
tychonic sessions --workflow-id <id>
```

## Agent Skill

Install the included skill so your agent CLI can operate Tychonic without
memorising flags:

```sh
npx skills add ./skills -a claude-code codex
```

Pass `-a` intentionally; otherwise the installer may target every detected
agent.

## Workflows And Config

A workflow bundle is a directory with `workflow.mjs` and a `defaultProfile`.
The profile is the workflow author's default config. A run can replace it with
`--config <file>`, but replacement is whole-object replacement, not merge.
Workflow JSON input is task data only: pass a JSON object, and do not put
config under `profile`.

Minimal profile shape:

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

Start with the smallest profile that expresses the workflow. Add optional
fields only when the workflow actually needs the behavior.

Validate and install bundles:

```sh
tychonic workflows validate ./examples/workflows/simpleWorkflow
tychonic workflows install ./examples/workflows/simpleWorkflow
tychonic workflows list
```

## Agents

Built-in adapters:

| Agent | Worker | Review | Same-session resume |
|---|---:|---:|---:|
| `claude` | yes | yes | yes |
| `codex` | yes | yes | yes |
| `kiro-acp` | yes | with normalizer | yes |
| `kiro` | yes | with normalizer | yes |
| `gemini` | yes | with normalizer | no |

Use `agent: "<name>"` for the built-in path. Use `command` only as an escape
hatch for custom CLIs, unusual flags, or test stubs. A state sets exactly one of
`agent` or `command`.

For review states, `gemini`, `kiro`, and `kiro-acp` require `normalizer:
claude` or `normalizer: codex`.

Prefer `kiro-acp` over `kiro` when using Kiro for worker states. `kiro-acp`
uses Kiro's ACP session API; `kiro` remains the legacy chat wrapper path.

Model names, reasoning effort, thinking budget, and similar provider settings
belong to the external CLI configuration or to an explicit `command`; they are
not Tychonic config fields.

## Security

Tychonic is designed for a single local operator. Keep the local Web API on
loopback. Do not bind it to `0.0.0.0`, a public IP, or a shared network unless
you have separately secured the environment.

Do not put literal tokens, passwords, or private keys in workflow commands. Use
the agent CLI's auth store or inherited environment references.

macOS notifications use the normal system notification permission. If a
notification does not appear, open System Settings → Notifications and allow
`TychonicNotify`. Detailed troubleshooting is in
[notifications-troubleshooting.md](skills/tychonic-cli/notifications-troubleshooting.md).

## More Documentation

- [SPEC.md](SPEC.md): product contract
- [docs/plugin-workflows.md](docs/plugin-workflows.md): workflow authoring guide
- [skills/tychonic-cli/SKILL.md](skills/tychonic-cli/SKILL.md): agent-facing CLI operating guide
- [skills/tychonic-cli/notifications-troubleshooting.md](skills/tychonic-cli/notifications-troubleshooting.md): macOS notification troubleshooting
- [SECURITY.md](SECURITY.md): security boundary and reporting
- [AGENTS.md](AGENTS.md): repository rules for contributors and agents
- [GUARDRAILS.md](GUARDRAILS.md): repeated project-specific failure patterns
