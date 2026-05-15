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

Tychonic core contains no workflow modules. Workflows are installed bundles.
Reference examples live under `examples/workflows/`; packaged examples are
inert files until explicitly installed.
Reference examples are starting points for authors. Target account, model
availability, plan/tier, quota, pricing, region/country access, and
organization policy differ by operator, so Tychonic does not provide one
default workflow profile that should be reused unchanged.

Workflow authors can use declarative `workflow.yaml` bundles. The YAML file is
the source of truth; install validates it and generates the Temporal
`workflow.mjs` wrapper plus `workflow.generated.mmd` graph preview.

## Requirements

- macOS
- Node.js 22+
- Temporal CLI on `PATH`
- Installed and authenticated agent CLIs for the agents your workflow uses

Tychonic does not ship a public web UI/API surface. The CLI is the primary
machine interface. A local-only workflow status UI is available with
`tychonic web` for single-operator inspection on the same machine.

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
tychonic workflows install "$EXAMPLES_DIR/verifyOnlyWorkflow"
tychonic workflows list
```

Start or reuse the local runtime daemon. This starts Temporal if needed, starts
the worker, writes a runtime PID/log under the Tychonic runtime directories, and
returns to the shell.

```sh
tychonic runtime up
```

`runtime up` is idempotent: each runtime instance has one managed daemon. If it
is already running, the command reports the existing PID instead of failing
because the caller's PID is different. Stop it with:

```sh
tychonic runtime stop
```

For development/debugging, use `tychonic runtime up --foreground` to keep the
worker attached to the current terminal and stop it with `Ctrl-C`.

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
{ "ok": true, "message": "Workflow finished with status 'succeeded'. Inspect evidence with `tychonic status --workflow-id wf_123`.", "workflowId": "wf_123", "status": "succeeded" }
```

Interactive workflows can also return a waiting state:

```json
{ "ok": true, "message": "Workflow is waiting for input at state 'qa'. Inspect evidence with `tychonic status --workflow-id wf_123`; it lists inbox, artifacts, logs, and sessions. Then run `tychonic approve wf_123 --state qa`, `tychonic reject wf_123 --state qa --feedback \"<feedback>\"`, `tychonic modify wf_123 --state qa --note \"<note>\"`, or `tychonic rerun wf_123 --state qa --reason \"<reason>\"`.", "workflowId": "wf_123", "state": "qa" }
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

Inspect a run. `status --workflow-id` gives the workflow metadata, evidence
summary, timing summary, and read commands for artifacts and logs. It does not
dump the full raw run record by default.

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
it returns the evidence needed to decide the next operator action.

To inspect the same workflow status in a browser, start the local UI:

```sh
tychonic web
```

The command binds to `127.0.0.1` by default and serves a local status view over
Temporal-backed workflow summaries. It is not a team service or public API.

After the no-agent smoke passes, install an agent workflow such as
`simpleWorkflow`. Its `defaultProfile` uses external agent CLIs and verifies
with `npm run typecheck`, `npm run build`, and `npm test`, so make sure those
CLIs and scripts are available in the target repository.
Inspect the installed profile before running it; if its model or
`reasoning_effort` choices do not fit the target account, model availability,
plan/tier, quota, pricing, region/country access, or organization policy, pass a
whole-profile `--config <file>` replacement.

```sh
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

A workflow bundle contains declarative `workflow.yaml`. YAML is the
author-owned source of truth; install derives the `defaultProfile` and
generates the Temporal wrapper. A run can replace the profile with
`--config <file>`, but the replacement is whole-object replacement, not merge.

Workflow JSON input is task data only. Do not put config under `profile`;
Tychonic reserves that field for the effective profile it passes into workflow
code.

Workflow run input uses one stable task-shaped public contract: required `cwd`,
optional `goal`, and optional `promptAdditions` only when the workflow explicitly
supports additive per-state prompt instructions. The workflow source defines
its own prompts. Declarative prompt text may use explicit `{{goal}}`; unknown
`{{...}}` variables fail install validation. `promptAdditions` keys must match
promptable state NAMEs present in the effective profile. Do not use top-level
prompt fields or agent names as input keys.

Before running workflows from a changed checkout, run the contract gate:

```sh
npm run check:contracts
```

`tychonic run` validates the standard workflow input contract (required `cwd`,
optional `goal`, optional `promptAdditions`) before starting Temporal. Invalid
workflow input or a `--config` profile that does not match the config schema
fails before any Temporal workflow is created.

The gate calls the production config, workflow-input, review, and interaction
validators. It is a pre-run contract check, not evidence that a specific
workflow execution succeeded.

When changing review-loop workflow behavior, run the deterministic runtime
smoke gate:

```sh
npm run verify:workflow-review-loop
```

This installs the review-loop architect/builder example bundles into an
isolated local instance, starts the runtime, runs failing review commands that
must return to builder work, checks the recorded evidence, and removes the
temporary instance data after the runtime stops successfully.

Config shape with environment-specific agent settings omitted:

```yaml
version: tychonic.config.v1
states:
  architect:
    type: work
    agent: claude
    permission_mode: plan
  builder:
    type: work
    agent: kiro
    trust_all_tools: true
    sandbox: workspace-write
    approval: never
  verify:
    type: verify
    command: |
      npm run typecheck
      npm run build
      npm test
  qa:
    type: review
    on_fail_return_to: builder
    agent: codex
    approval: never
```

Every `review` state must declare `on_fail_return_to`, naming the non-review
state that receives failed review feedback when the workflow loops. In this
example, a failed `qa` verdict returns to `builder`. Declarative
`workflow.yaml` bundles generated by install append the failed review summary
and structured findings to that return state's next prompt when the return
state is prompt-bearing.

A workflow author may explicitly choose `model` and supported
`reasoning_effort` per state only after checking the target account, model
availability, plan/tier, quota, pricing, region/country access, and organization
policy. Omission delegates to the selected CLI's default or auto-selection
behavior.
For exact versioned Claude model names, Tychonic compares the CLI-reported
model with the configured string and fails the activity on mismatch; aliases
such as `opus` are passed through without exact-match assertion.
Kiro model ids are Kiro CLI ids; availability can be account-, tier-, or
region-scoped. `kiro-cli chat --list-models` proves what this account can run,
not whether every documented Kiro model id exists globally.
Include other knobs such as `resume`, permissions, sandbox, timeout, trust, and
policy settings only when the workflow behavior needs them.

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
- `yamlVerifyWorkflow`: no-agent declarative YAML runtime smoke.
- `simpleWorkflow`: one work state, one verify state, one review state.
- `pipelineWorkflow`: longer one-pass pipeline with repeated `review` states.
- `checkpointWorkflow`: fixed deterministic gates plus two structured reviews.
- `architectBuilderQaWorkflow`: Claude plans, Kiro builds, Codex performs final QA.
- `architectBuilderFinalQaWorkflow`: Kiro-assisted build with Codex final QA.
- `architectBuilderFirstReviewQaWorkflow`: Claude plans, Kiro builds and runs the
  first normalized review, then Codex performs final QA.
- `structuralIssueDiscoveryWorkflow`: deterministic contract checks plus scoped
  Claude structural reviews and a finding-audit gate.

Read each bundle's `README.md` before changing its config shape or
`promptAdditions` state keys.

## Agent Skill

The CLI and README are the primary interface. The included skill is an optional
helper for agents that operate Tychonic frequently:

```sh
npx skills add ./skills -a claude-code -a codex --yes --global
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

- [SPEC.md](SPEC.md): product contract index and module SPEC map
- [docs/plugin-workflows.md](docs/plugin-workflows.md): workflow authoring guide
- [skills/tychonic-cli/SKILL.md](skills/tychonic-cli/SKILL.md): agent-facing CLI operating guide
- [SECURITY.md](SECURITY.md): security boundary and reporting
- [AGENTS.md](AGENTS.md): repository rules for contributors and agents
- [GUARDRAILS.md](GUARDRAILS.md): repeated project-specific failure patterns
