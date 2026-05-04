# architectBuilderKiroQaWorkflow

`architectBuilderKiroQaWorkflow` runs architect → builder → QA with Kiro as the
primary reviewer. The review state uses `normalizer: codex`, so Kiro performs
the review and the normalizer only turns the review result into the structured
Tychonic review payload.

## Purpose

Use this when Kiro should do the substantive QA review, but the workflow still
needs a structured review result for gating, findings, and artifacts. This is
useful when Kiro has useful review behavior or quota, while Codex/Claude quota
should be spent only on normalization.

The default profile pins Kiro QA to `model: claude-sonnet-4.5`. Adjust that
value to a model available in your installed Kiro CLI.

## States

| State | TYPE | Role |
|---|---|---|
| `architect` | `work` | Produce the implementation plan. |
| `builder` | `work` | Implement the plan in the isolated worktree. |
| `qa` | `review` | Kiro performs QA; `normalizer: codex` structures Kiro's review into the semantic verdict. |

`qa` uses `trust_all_tools: true` because Kiro ACP needs tool trust for
non-interactive inspection and check execution. QA is allowed to run checks, but
not to repair code: the Kiro review adapter rejects direct file writes and fails
the review if tracked files change during the turn.

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used to create the isolated worker worktree. |
| `goal` | no | Goal threaded into architect and builder prompts. |
| `architectPrompt` | no | Prompt override for `architect`. |
| `builderPrompt` | no | Prompt override for `builder`. |
| `qaPrompt` | no | Prompt override for Kiro QA. |

Unknown fields are rejected. `cwd` must be a git repository.

## Minimal Run

```sh
tychonic workflows install ./examples/workflows/architectBuilderKiroQaWorkflow
tychonic runtime up
```

In another terminal:

```sh
cat > ./architect-builder-kiro-qa-input.json <<'JSON'
{
  "cwd": "/abs/path/to/project",
  "goal": "Implement the requested change and let Kiro perform QA review."
}
JSON

tychonic run architectBuilderKiroQaWorkflow --input-file ./architect-builder-kiro-qa-input.json --wait
```

## Trade-Off

Kiro owns the review judgment, so review quality depends on Kiro. The
normalizer must not invent findings; it only structures what Kiro reported.
If Kiro output is vague, the structured result will also be weak.

## Config Override

`--config <file>` replaces the bundle `defaultProfile` as one whole object. It
does not merge with the bundle default.
