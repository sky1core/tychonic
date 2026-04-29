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

Install the smallest example workflow bundle first. It runs only deterministic
shell checks, so it proves the runtime path before any agent CLI is involved.
If you installed from npm, set `EXAMPLES_DIR="$(npm root -g)/tychonic/examples/workflows"`.
From a source checkout, use `EXAMPLES_DIR="./examples/workflows"`.

```sh
# Source checkout:
EXAMPLES_DIR="./examples/workflows"
# npm global install:
# EXAMPLES_DIR="$(npm root -g)/tychonic/examples/workflows"
(cd "$EXAMPLES_DIR/verifyOnlyWorkflow" && npm install)
tychonic workflows install "$EXAMPLES_DIR/verifyOnlyWorkflow"
tychonic workflows list
```

Start the local runtime in one terminal. This starts Temporal if needed and
runs the worker.

```sh
tychonic runtime up
```

Stop the foreground runtime with `Ctrl-C`. Detached isolated runtimes print a
`stopCommand`; run that command to stop them.

Start a run from another terminal:

```sh
cat > ./verify-input.json <<'JSON'
{
  "cwd": "/absolute/path/to/a/git/repo"
}
JSON

tychonic run verifyOnlyWorkflow --input-file ./verify-input.json --wait
```

The input `cwd` is the git repository to check. It does not have to be the
Tychonic source checkout.

`--wait` waits until the workflow reaches the next point where the caller can
act or report the result. Read the `message` field first; it is written as the
plain-language outcome for a human or an LLM operator.

Use `--wait` when the caller should report the result before doing anything
else. Omit it when the caller should start the workflow and continue with other
work; the no-wait response includes the `workflowId` needed for `tychonic wait`.

The first smoke normally finishes like this:

```json
{ "ok": true, "message": "Workflow finished with status 'succeeded'. Read the result with `tychonic status --workflow-id wf_123`.", "workflowId": "wf_123", "status": "succeeded" }
```

Interactive workflows can also return a waiting state:

```json
{ "ok": true, "message": "Workflow is waiting for input at state 'qa'. Inspect evidence with `tychonic status --workflow-id wf_123`; it lists inbox, artifacts, logs, and sessions. Then run `tychonic approve wf_123 --state qa`, `tychonic reject wf_123 --state qa --feedback \"<feedback>\"`, or `tychonic modify wf_123 --state qa --note \"<note>\"`.", "workflowId": "wf_123", "state": "qa" }
```

To start a workflow and keep working without waiting, omit the wait flag:

```sh
tychonic run verifyOnlyWorkflow --input-file ./verify-input.json
```

The no-wait response includes the handle to use later:

```json
{ "ok": true, "message": "Workflow started. To wait until it needs caller action or returns a result, run `tychonic wait wf_123`.", "workflowId": "wf_123", "runId": "run_456" }
```

To wait for a workflow you already started, pass the returned `workflowId`.
The response may also include `runId`; ordinary follow-up commands use
`workflowId`.

```sh
tychonic wait <workflow-id>
```

Inspect a run. `status --workflow-id` includes an evidence summary and the read
commands for artifacts and logs.

```sh
tychonic status --workflow-id <id>
```

Use the focused commands when you need a specific list or raw content:

```sh
tychonic inbox --workflow-id <id>
tychonic artifacts --workflow-id <id>
tychonic logs --workflow-id <id>
tychonic sessions --workflow-id <id>
```

Without `--workflow-id`, `status` lists recent workflows. With `--workflow-id`,
it includes the workflow's Tychonic run result and evidence summary when
available.

After the no-agent smoke passes, install an agent workflow such as
`simpleWorkflow`. Its default profile uses external agent CLIs and verifies
with `npm run typecheck`, `npm run build`, and `npm test`, so make sure those
CLIs and scripts are available in the target repository.

```sh
(cd "$EXAMPLES_DIR/simpleWorkflow" && npm install)
tychonic workflows install "$EXAMPLES_DIR/simpleWorkflow"
tychonic config show --workflow-name simpleWorkflow --format yaml
```

Then run it with task input:

```sh
cat > ./simple-input.json <<'JSON'
{
  "cwd": "/absolute/path/to/a/git/repo",
  "goal": "Implement the requested change and leave evidence in artifacts."
}
JSON

tychonic run simpleWorkflow --input-file ./simple-input.json --wait
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

The CLI and README are the primary interface. The included skill is an optional
helper for agents that operate Tychonic frequently:

```sh
npx skills add ./skills -a claude-code codex
```

Pass `-a` intentionally; otherwise the installer may target every detected
agent. Do not rely on the skill to explain behavior that the CLI output should
make clear.

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
