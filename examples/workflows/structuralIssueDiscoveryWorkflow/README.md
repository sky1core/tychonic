# structuralIssueDiscoveryWorkflow

`structuralIssueDiscoveryWorkflow` runs deterministic checks, then several
Claude structured review states, then a final finding audit. It is an opt-in
example workflow bundle, not a built-in workflow and not a universal default.

## Purpose

Use this when the operator wants a repeatable structural issue discovery pass:

1. run deterministic product checks
2. review workflow/runtime behavior
3. review adapter/parser/config behavior
4. review docs/skills/example consistency
5. audit the collected findings for duplicates and weak evidence

The workflow cannot prove that all bugs are absent. Its completion claim is
limited to the deterministic checks and reviewer scopes that actually ran.

## States

| State | TYPE | Failed review returns to | Role |
|---|---|---|---|
| `contract_checks` | `verify` | - | Runs the configured deterministic checks. |
| `workflow_review` | `review` | `contract_checks` | Reviews Temporal workflow control flow, recovery, interaction gates, state lifecycle, and run-record updates. |
| `adapter_review` | `review` | `contract_checks` | Reviews adapters, review parsing, structured output handling, model selection, session ids, and activity execution boundaries. |
| `docs_review` | `review` | `contract_checks` | Reviews public docs, skills, examples, input shape, and naming consistency. |
| `finding_audit` | `review` | `contract_checks` | Audits recorded findings for duplicates, missing evidence, and contract drift. |

All review states use the Tychonic `review` TYPE. The Claude adapter runs in
review mode with structured output schema enforcement; prompt-only JSON output
is not the contract boundary.

This workflow is one-pass, so it does not auto-retry failed reviews. The review
states still declare `on_fail_return_to` because the review-state contract
requires an explicit failure destination in the effective profile.

Do not replace this workflow with a direct `claude -p` or other raw agent CLI
review when the result will be used as an actionable issue list. Direct CLI
calls bypass the Tychonic review contract, finding ledger, artifacts, session
records, and final `finding_audit` state. Use raw calls only for exploratory
diagnosis; use this workflow or another explicit `review`-state workflow for
structured issue discovery.

## Finding Ledger

This workflow prevents repeated rediscovery inside a run by passing earlier
review findings into later review prompts. Later states must not report the
same issue as new. The final `finding_audit` state reviews the collected
findings and fails if they are duplicates, speculative, or missing concrete
file/line evidence.

The ledger is the current Temporal run record. The workflow does not create a
repo-local issue database.

Across runs, pass accepted known issues through `goal` or through
`promptAdditions.<stateName>` for the relevant promptable state. Those entries
are operator-supplied review context, not hidden product state.

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Repository to inspect. |
| `goal` | no | Additional operator goal or known issue context shared by all states. |
| `promptAdditions` | no | Object keyed by promptable state NAME. Appends state-specific review instructions. |

Promptable states are `workflow_review`, `adapter_review`, `docs_review`, and
`finding_audit`. Unknown input fields and unknown `promptAdditions` keys are
rejected before the Temporal workflow starts.

## Default Profile

The default profile is Claude-focused:

- `workflow_review`, `adapter_review`, `docs_review`, and `finding_audit` use
  `agent: claude`, `model: claude-opus-4-7`, and `reasoning_effort: max`
- `contract_checks` runs:

```sh
npm run check:contracts
npm run typecheck
npm run build
npm run validate:examples
```

These are example values. Operators must adapt model names, quota, pricing,
timeouts, and check commands to their own environment before installing and
running the bundle.

## Minimal Run

```sh
tychonic workflows validate ./examples/workflows/structuralIssueDiscoveryWorkflow
tychonic workflows install ./examples/workflows/structuralIssueDiscoveryWorkflow
tychonic runtime up
```

Then start a run:

```sh
cat > ./structural-issue-discovery-input.json <<'JSON'
{
  "cwd": "/abs/path/to/project",
  "goal": "Find structural bugs and spec violations. Do not repeat already accepted known issues."
}
JSON

tychonic run structuralIssueDiscoveryWorkflow --input-file ./structural-issue-discovery-input.json --wait
```

Run `npm run check:contracts` before starting a changed checkout. That command
uses the same production validators and parsers that `tychonic run` depends on
for preflight contract checks.

## Result Semantics

- Findings from `workflow_review`, `adapter_review`, and `docs_review` are the
  candidate product issues.
- Findings from `finding_audit` are defects in the finding set itself.
- If `finding_audit` fails, inspect and repair the finding set before acting on
  it as a clean issue list.
- If no candidate findings exist and `finding_audit` passes, the workflow found
  no actionable issue within the checks and reviewer scopes that ran.

## Config Override

`--config <file>` replaces the bundle YAML-derived profile as one whole object.
It does not merge with the default profile. Keep state NAMEs stable unless the
workflow.yaml and README are updated together.
