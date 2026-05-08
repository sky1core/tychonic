# architectBuilderFirstReviewQaWorkflow

`architectBuilderFirstReviewQaWorkflow` runs architect → builder →
first_review → final QA. Claude plans, Kiro implements and performs the first
structured review, and Codex runs only after that first review passes.

## Purpose

Use this when the workflow should maximize Kiro work before spending Codex final
QA time. Kiro handles the implementation middle and the first pass/fail review;
Codex is reserved for the final structured QA gate.

The default profile pins architect to Claude `claude-opus-4-7` with
`reasoning_effort: max`, builder and first review to Kiro `claude-opus-4.6`,
and final QA to Codex `gpt-5.5` with `reasoning_effort: xhigh`. Adjust those
values to models available in your installed CLIs.

## States

| State | TYPE | Role |
|---|---|---|
| `architect` | `work` | Produce the implementation plan. |
| `builder` | `work` | Kiro implements the plan in the isolated worktree. |
| `first_review` | `review` | Kiro produces the first review verdict; `normalizer: claude` structures the result. |
| `final_qa` | `review` | Codex returns the final structured pass/fail review verdict. |

`first_review` is a real `review` state, not prose pre-review work. It uses
`normalizer: claude` because Kiro review output must be normalized into the
Tychonic review contract. The normalizer structures the Kiro review output; it
does not perform a second independent review.

If `first_review` does not pass, `final_qa` is not run. That keeps Codex reserved
for runs that already cleared the first review gate.

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used to create the isolated worker worktree. |
| `goal` | no | Goal threaded into architect and builder prompts. |
| `promptAdditions` | no | Object keyed by state NAME. Appends extra instructions to built-in prompts for `architect`, `builder`, `first_review`, or `final_qa`. |

Unknown fields are rejected. `promptAdditions` keys must match one of the
promptable state NAMEs listed above; agent names are not valid prompt keys.
`cwd` must be a git repository.

## Minimal Run

```sh
tychonic workflows install ./examples/workflows/architectBuilderFirstReviewQaWorkflow
tychonic runtime up
```

In another terminal:

```sh
cat > ./architect-builder-first-review-qa-input.json <<'JSON'
{
  "cwd": "/abs/path/to/project",
  "goal": "Implement the requested change with Kiro build and first review, then run Codex final QA."
}
JSON

tychonic run architectBuilderFirstReviewQaWorkflow --input-file ./architect-builder-first-review-qa-input.json --wait
```

## Trade-Off

This adds one structured first review before Codex final QA. It can reduce Codex
usage for runs with clear defects, but a failed first review stops the workflow
and requires operator action or a separate repair workflow.

## Config Override

`--config <file>` replaces the bundle `defaultProfile` as one whole object. It
does not merge with the bundle default.
