# architectBuilderReviewRepairQaWorkflow

`architectBuilderReviewRepairQaWorkflow` runs architect → builder → pre-review →
repair → final QA. Claude plans, Kiro handles the implementation and repair
middle, and Codex makes the final structured pass/fail decision.

## Purpose

Use this when Kiro should absorb implementation and obvious review/fix work
before the final structured reviewer runs. The goal is to reduce final review
loop pressure by letting Kiro catch and fix clear issues first, while preserving
a final structured QA gate with Codex.

The default profile demonstrates per-state model selection: architect uses
Claude `claude-opus-4-7` with `reasoning_effort: max`, builder/pre-review/repair
use Kiro `claude-opus-4.6`, and final QA uses Codex `gpt-5.5` with
`reasoning_effort: xhigh`. Adjust those values to models available in your
installed CLIs.

## States

| State | TYPE | Role |
|---|---|---|
| `architect` | `work` | Produce the implementation plan. |
| `builder` | `work` | Kiro implements the plan in the isolated worktree. |
| `pre_review` | `work` | Kiro inspects the result and writes prose guidance; this is not the structured QA gate. |
| `repair` | `work` | Kiro applies targeted repairs from the pre-review. |
| `final_qa` | `review` | Codex returns the structured pass/fail review verdict. |

`pre_review` and `repair` use `trust_all_tools: true` because Kiro ACP
needs tool trust for non-interactive file inspection and edits. These are
`work` states, not the final structured QA gate; the actual repair step is
explicitly named as `repair`.

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used to create the isolated worker worktree. |
| `goal` | no | Goal threaded into architect and builder prompts. |
| `promptAdditions` | no | Object keyed by state NAME. Appends extra instructions to built-in prompts for `architect`, `builder`, `pre_review`, `repair`, or `final_qa`. |

Unknown fields are rejected. `promptAdditions` keys must match one of the
promptable state NAMEs listed above; agent names are not valid prompt keys.
`cwd` must be a git repository.

## Minimal Run

```sh
tychonic workflows install ./examples/workflows/architectBuilderReviewRepairQaWorkflow
tychonic runtime up
```

In another terminal:

```sh
cat > ./architect-builder-review-repair-qa-input.json <<'JSON'
{
  "cwd": "/abs/path/to/project",
  "goal": "Implement the requested change, let Kiro pre-review/repair, then run final QA."
}
JSON

tychonic run architectBuilderReviewRepairQaWorkflow --input-file ./architect-builder-review-repair-qa-input.json --wait
```

## Trade-Off

This uses more Kiro work and adds latency before final QA. It can reduce final
review iterations when Kiro catches clear defects, but it is not a replacement
for final structured review because Kiro's prose stage is advisory and may miss
or overstate issues.

## Config Override

`--config <file>` replaces the bundle `defaultProfile` as one whole object. It
does not merge with the bundle default.
