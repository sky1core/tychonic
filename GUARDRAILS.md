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

## Orchestration Knobs Are Not Progress

Do not present option-heavy orchestration config as the default path. Optional
fields are not all the same category: `model` and supported
`reasoning_effort` are recommended agent settings for repeatability and quality
control, while `resume`, timeout, sandbox, approval, permission, trust, and
policy knobs change orchestration or execution boundaries.

The failure pattern is showing `resume`, timeout, sandbox, approval,
permission, trust, and policy knobs together in a basic example. That teaches
operators and agents to cargo-cult every available field, which makes workflow
inputs harder to read and hides the real contract.

For agent states, pin `model` when repeatability matters and set
`reasoning_effort` for Claude/Codex states whose quality depends on reasoning
depth. That is a recommended agent setting, not option cargo-culting. Keep
orchestration knobs next to the concrete behavior they control and explain why
that workflow needs them.

## QA Is Not A Hidden Repair Step

Do not weaken QA/review into a read-only eyeballing step. QA may inspect files,
read diffs, run tests, and reproduce failures. A review that cannot execute
checks is not useful enough for this product.

The boundary is modification, not observation. QA/review states must not edit
source code or silently repair findings before reporting them. If a workflow
wants automated repair after QA, it must call an explicit work state with its
own NAME and config.

Do not use a single broad tool-trust switch as proof that the boundary is safe.
If a reviewer needs command execution, the implementation must still prevent or
detect code edits through the production path instead of relying on prompt
wording.

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

## Do Not Make Bundle Authors Hand-Wire Standard Temporal Handlers

The standard Tychonic workflow control surface is host-owned. A bundle author
should not copy/paste `defineSignal`, `defineQuery`, and `setHandler` calls for
Tychonic's standard run-state or interaction names.

The failure pattern is pushing low-level Temporal handler wiring into every
example workflow and then expecting future workflow-writing agents to remember
which names, payloads, validation rules, and queues must match the CLI. That is
not a workflow contract; it is duplicated host plumbing.

The correct boundary is a public helper from `tychonic/workflow`: the helper
registers the standard names as one unit, owns standard raw payload validation,
and exposes workflow-level operations such as publishing the run snapshot or
waiting for an interaction decision. Workflow code may still define custom
signals for custom recovery behavior, but those names and payloads are that
bundle's own contract and must be documented by that bundle.
