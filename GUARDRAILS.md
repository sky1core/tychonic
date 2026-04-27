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
