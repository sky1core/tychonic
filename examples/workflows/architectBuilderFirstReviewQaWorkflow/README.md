# architectBuilderFirstReviewQaWorkflow

`architectBuilderFirstReviewQaWorkflow` runs architect → builder →
first_review → final QA. Claude plans, Kiro implements and performs the first
structured review, and Codex runs only after that first review passes.
Its YAML state machine has a bounded builder/review loop.

## Purpose

Use this when the workflow should maximize Kiro work before spending Codex final
QA time. Kiro handles the implementation middle and the first pass/fail review;
Codex is reserved for the final structured QA gate.
When either `first_review` or `final_qa` does not pass, the workflow sends the
review finding back to `builder` until both review gates pass or `max_steps` is
reached.

This example profile sets `architect` to Claude `claude-opus-4-7` with
`reasoning_effort: max`, `builder` and `first_review` to Kiro
`claude-opus-4.6`, and `final_qa` to Codex `gpt-5.5` with
`reasoning_effort: xhigh`.
These values are examples; adapt them after checking the target account,
model availability, plan/tier, quota, pricing, region/country access, and
organization policy.
Kiro model availability is account-, tier-, and region-scoped; absence from
`kiro-cli chat --list-models` means unavailable for that account, not that the
documented Kiro model id is globally invalid.

## States

| State | TYPE | Failed review returns to | Role |
|---|---|---|---|
| `architect` | `work` | - | Produce the implementation plan. |
| `builder` | `work` | - | Kiro implements the plan in the isolated worktree. |
| `first_review` | `review` | `builder` | Kiro produces the first review verdict; `normalizer: claude` structures the result. |
| `final_qa` | `review` | `builder` | Codex returns the final structured pass/fail review verdict. |

`first_review` is a real `review` state, not prose pre-review work. It uses
`normalizer: claude` because Kiro review output must be normalized into the
Tychonic review contract. The normalizer structures the Kiro review output; it
does not perform a second independent review.

If `first_review` does not pass on an iteration, `final_qa` is not run for that
iteration. The next builder attempt receives the first-review feedback. That
keeps Codex reserved for iterations that already cleared the first review gate.

## Run Mode

Use `tychonic run architectBuilderFirstReviewQaWorkflow --input-file <file> --wait`
when the caller should wait for the pipeline result before doing anything else.

Failed `first_review` or `final_qa` verdicts loop back into `builder` with
prior review feedback until both review gates pass or the YAML `max_steps` cap
is reached.

After the run reaches a terminal `waiting_user` status, interaction signals no
longer resume it. Recovery is a fresh run with adjusted input or config.

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used to create the isolated worker worktree. |
| `goal` | no | Goal threaded into architect and builder prompts. |
| `promptAdditions` | no | Object keyed by state NAME. Appends extra instructions to prompts defined by this workflow for `architect`, `builder`, `first_review`, or `final_qa`. |

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
usage for runs with clear defects because Codex only runs on iterations that
pass `first_review`.

## Config Override

`--config <file>` replaces the bundle YAML-derived profile as one whole object. It
does not merge with the bundle default.
