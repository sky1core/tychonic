# GUARDRAILS.md

This document records recurring mistake patterns in this project.

It is not an executable checker, a keyword blacklist, or a substitute for
SPEC. Use it to capture design boundaries that contributors have repeatedly
crossed so future work can avoid the same failure mode.

## Runtime Data Is Not Execution Selection

Activity call inputs carry runtime data produced by workflow code at that
moment: prompt text, worktree paths, session ids, verification evidence, and
similarly concrete values.

Activity call inputs must not select which command or agent runs. Execution
selection belongs to the state config block:

- `states.<name>.agent` selects a built-in adapter.
- `states.<name>.command` selects the explicit command escape hatch.

These are mutually exclusive. A state block must not declare both.

Do not reintroduce a second execution channel through call-site fields,
wrapper objects, "override" fields, or generic buckets such as `extras`,
`options`, `params`, or `data`.

If a field is just a command, call it `command` and put it in the state config
block. If a field is runtime data, give it its concrete name at the activity
input boundary.

## Options Are Not Progress

Do not present option-heavy config as the default path. Optional fields are for
specific needs, not for making examples look complete.

The failure pattern is showing `resume`, timeout, sandbox, approval,
permission, trust, and policy knobs together in a basic example. That teaches
operators and agents to cargo-cult every available field, which makes workflow
inputs harder to read and hides the real contract.

Start docs and examples from the smallest working profile: `type` plus exactly
one execution selector for executable states, or the deterministic `command`
for command states. Add optional fields only next to the concrete behavior they
control and explain why that workflow needs them.

## No Performative Guardrails

Do not add low-signal checker code to look strict. A guardrail that can be
bypassed by renaming a field, moving text, or changing a script fragment creates
false confidence and is worse than no guardrail.

If a rule must be enforced, enforce it through the real contract boundary:
schema validation, TypeScript types, public API shape, production runtime
validation, or tests that exercise the production path.

If the project cannot enforce the rule structurally, document the risk here or
in SPEC. Do not ship a fake checker to make the risk look handled.

## Do Not Infer Session Identity From List Diffs

Do not claim that an external agent session has been identified by comparing
"before" and "after" session lists. A list diff only proves that a session
appeared between two observations; it does not prove that the activity process
created that session.

This is especially banned for resume keys. A resumable session id must come
from the fresh-run process output, an official machine-readable creation
result, or another direct API that binds the created session to that process.

If the CLI only exposes `latest`, an index, a history list, or a session list
without a process-bound creation result, the adapter must report the session as
non-resumable instead of guessing.

## Do Not Push Host Bookkeeping Into Model JSON

Structured model output should carry the semantic payload the model is actually
qualified to decide. For review output, that means the verdict, summary, and
actionable findings.

Do not make the model responsible for Tychonic bookkeeping fields or workflow
control facts such as schema versions, internal run ids, artifact ids, resume
decisions, retry counts, or state transitions. Built-in adapters and workflow
code own those boundaries.

The failure pattern is asking Claude/Codex structured output to emit
`schema_version: "tychonic.review.v1"` or to satisfy complex conditional JSON
Schema branches so the host can avoid normalizing and validating its own wire
contract. That is backwards: the adapter normalizes model payload into the
host wire format, and the host schema remains the final authority.

Escape-hatch commands are different because they bypass the built-in adapter
normalization layer. A custom reviewer command must emit the documented wire
format itself, but that is the wrapper command's responsibility, not the
model's semantic reasoning task.
