# architectBuilderFinalQaWorkflow

`architectBuilderFinalQaWorkflow` runs architect → builder → QA with Claude
planning, Kiro building, and Codex as the final structured reviewer.

## Purpose

Use this when Kiro should handle the implementation middle of a staged workflow,
while the final pass/fail gate stays on Codex for structured QA output.

This example profile sets `architect` to Claude `claude-opus-4-7` with
`reasoning_effort: max`, `builder` to Kiro `claude-opus-4.6`, and `qa` to
Codex `gpt-5.5` with
`reasoning_effort: xhigh`.
These values are examples; adapt them after checking the target account,
model availability, plan/tier, quota, pricing, region/country access, and
organization policy.
Kiro model availability is account-, tier-, and region-scoped; absence from
`kiro-cli chat --list-models` means unavailable for that account, not that the
documented Kiro model id is globally invalid.

## States

| State | TYPE | Role |
|---|---|---|
| `architect` | `work` | Produce the implementation plan. |
| `builder` | `work` | Kiro implements the plan in the isolated worktree. |
| `qa` | `review` | Codex returns the structured pass/fail review verdict. |

`builder` uses `trust_all_tools: true` because Kiro ACP needs tool trust for
non-interactive implementation work. QA is a structured Codex review state; it
may run checks but must not silently repair code.

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used to create the isolated worker worktree. |
| `goal` | no | Goal threaded into architect and builder prompts. |
| `promptAdditions` | no | Object keyed by state NAME. Appends extra instructions to prompts defined by this workflow for `architect`, `builder`, or `qa`. |

Unknown fields are rejected. `promptAdditions` keys must match one of the
promptable state NAMEs listed above; agent names are not valid prompt keys.
`cwd` must be a git repository.

## Minimal Run

```sh
tychonic workflows install ./examples/workflows/architectBuilderFinalQaWorkflow
tychonic runtime up
```

In another terminal:

```sh
cat > ./architect-builder-final-qa-input.json <<'JSON'
{
  "cwd": "/abs/path/to/project",
  "goal": "Implement the requested change with Kiro as builder and Codex as final QA."
}
JSON

tychonic run architectBuilderFinalQaWorkflow --input-file ./architect-builder-final-qa-input.json --wait
```

## Trade-Off

Kiro owns the implementation middle, so builder quality depends on Kiro. Codex
owns the final structured QA judgment; choose its model and reasoning effort
explicitly after checking the repository risk and the target operator
environment.

## Config Override

`--config <file>` replaces the bundle `defaultProfile` as one whole object. It
does not merge with the bundle default.
