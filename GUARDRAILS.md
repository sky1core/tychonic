# GUARDRAILS.md

- Do not move execution-path selection out of state config into activity call inputs, per-run task input, wrapper objects, or generated runtime data.
- Do not configure one state to select both the built-in adapter path and the custom command escape hatch.
- Do not put execution-policy, continuity, timeout, trust, or permission controls in a basic example unless that workflow's documented behavior depends on them.
- Do not let a review state modify, stage, commit, or otherwise repair source changes before reporting its verdict.
- Do not treat tool-trust or permission settings as the enforcement boundary that proves review source edits cannot happen.
- Do not add checker code whose result can change only because a field was renamed, text moved, or a script fragment reworded.
- Do not derive a resumable external-agent session id from latest/list/diff observations that are not produced by the launched process.
- Do not require built-in structured reviewers to emit Tychonic wire-result bookkeeping when the adapter can normalize semantic review payload into the wire result.
- Do not make workflow bundle authors hand-register Tychonic standard Temporal signal/query handlers instead of using the host-owned workflow helper.
- Do not add hand-written executable workflow source files to source bundles that are supposed to be declarative workflow.yaml bundles.
- Do not implement production built-in adapters by calling Claude, Codex, Kiro, or their CLI wrappers directly instead of dispatching through OpenP.
- Do not map Tychonic state type, state NAME, or review/work role into downstream permission flags unless the adapter SPEC explicitly assigns that backend command contract.
- Do not invent downstream-owned model, effort, permission, or provider settings when state config omits them, and do not emit downstream flags for omitted settings.
- Do not attach a structured-output request to an OpenP backend turn when that backend or turn mode does not support it.
- Do not accept a prose-only reviewer backend as a structured review verdict path without running the configured normalizer and host schema validation.
