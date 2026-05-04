# architectBuilderKiroRepairQaWorkflow

`architectBuilderKiroRepairQaWorkflow` runs architect → builder → Kiro
pre-review → Kiro repair → final QA. Kiro gets a cheap prose-review and repair
slot before a structured final reviewer makes the pass/fail decision.

## Purpose

Use this when Kiro should absorb obvious review/fix work before the final
structured reviewer runs. The goal is to reduce final review loop pressure by
letting Kiro catch and fix clear issues first, while preserving a final
structured QA gate with Claude or Codex.

The default profile demonstrates per-state model selection: Kiro pre-review
uses `claude-sonnet-4.5`, Kiro repair uses `claude-sonnet-4.5`, and final Claude
QA uses `opus` with `reasoning_effort: max`. Adjust those values
to models available in your installed CLIs.

## States

| State | TYPE | Role |
|---|---|---|
| `architect` | `work` | Produce the implementation plan. |
| `builder` | `work` | Implement the plan in the isolated worktree. |
| `kiro_pre_review` | `work` | Kiro inspects the result and writes prose guidance; this is not the structured QA gate. |
| `kiro_fix` | `work` | Kiro applies targeted repairs from the pre-review. |
| `final_qa` | `review` | Return the structured pass/fail review verdict. |

`kiro_pre_review` and `kiro_fix` use `trust_all_tools: true` because Kiro ACP
needs tool trust for non-interactive file inspection and edits. These are
`work` states, not the final structured QA gate; the actual repair step is
explicitly named as `kiro_fix`.

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used to create the isolated worker worktree. |
| `goal` | no | Goal threaded into architect and builder prompts. |
| `architectPrompt` | no | Prompt override for `architect`. |
| `builderPrompt` | no | Prompt override for `builder`. |
| `kiroPreReviewPrompt` | no | Prompt override for Kiro pre-review. |
| `kiroFixPrompt` | no | Prompt override for Kiro repair. |
| `finalQaPrompt` | no | Prompt override for final QA. |

Unknown fields are rejected. `cwd` must be a git repository.

## Minimal Run

```sh
tychonic workflows install ./examples/workflows/architectBuilderKiroRepairQaWorkflow
tychonic runtime up
```

In another terminal:

```sh
cat > ./architect-builder-kiro-repair-qa-input.json <<'JSON'
{
  "cwd": "/abs/path/to/project",
  "goal": "Implement the requested change, let Kiro pre-review/repair, then run final QA."
}
JSON

tychonic run architectBuilderKiroRepairQaWorkflow --input-file ./architect-builder-kiro-repair-qa-input.json --wait
```

## Trade-Off

This uses more Kiro work and adds latency before final QA. It can reduce final
review iterations when Kiro catches clear defects, but it is not a replacement
for final structured review because Kiro's prose stage is advisory and may miss
or overstate issues.

## Config Override

`--config <file>` replaces the bundle `defaultProfile` as one whole object. It
does not merge with the bundle default.
