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

Choose the light normalizer model in the normalizer CLI's own configuration.
The Tychonic profile selects only `normalizer: codex` or `normalizer: claude`.

## States

| State | TYPE | Role |
|---|---|---|
| `architect` | `work` | Produce the implementation plan. |
| `builder` | `work` | Implement the plan in the isolated worktree. |
| `qa` | `review` | Kiro performs QA; `normalizer: codex` structures Kiro's review into the semantic verdict. |

`qa` uses `trust_all_tools: true` because the plain Kiro CLI needs tool trust
for non-interactive file inspection.

## Input

| Field | Required | Purpose |
|---|---|---|
| `cwd` | yes | Git repository used to create the isolated worker worktree. |
| `goal` | no | Goal threaded into architect and builder prompts. |
| `architectPrompt` | no | Prompt override for `architect`. |
| `builderPrompt` | no | Prompt override for `builder`. |
| `qaPrompt` | no | Prompt override for Kiro QA. |

Unknown fields are rejected. `cwd` must be a git repository.

## Trade-Off

Kiro owns the review judgment, so review quality depends on Kiro. The
normalizer must not invent findings; it only structures what Kiro reported.
If Kiro output is vague, the structured result will also be weak.

## Config Override

`--config <file>` replaces the bundle `defaultProfile` as one whole object. It
does not merge with the bundle default.
