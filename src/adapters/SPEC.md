# Adapters Module SPEC

This file applies to built-in agent adapters under `src/adapters/`.

## Adapter Model

Tychonic ships **built-in adapters for the supported agent CLI paths**:
`claude`, `codex`, `gemini`, `kiro`. The host owns command synthesis,
session-id handling, agent-specific flags (permission, sandbox, approval,
trust), and resume semantics where the selected adapter supports same-session
resume. Workflow authors and operators select an adapter by setting
`agent: "<name>"` on a state block.

The default code path for every executable activity is **agent-driven**:

- `agent` selects a built-in adapter
- `resume` is a numeric option (default `0`) that a workflow may use as a
  same-session continuation budget. The host only writes a resume invocation
  when workflow code explicitly calls a resume-capable adapter path with a prior
  session id; it does not auto-resume by role, TYPE, NAME, or profile shape. The
  workflow owns the recovery path after that budget is exhausted and must expose
  it as part of that workflow's own contract.
- the host writes the actual `argv`, the resume flag where supported, the
  session-id round trip, and the role-aware permission flags

`command` is an **escape hatch** for non-default scenarios — a custom CLI not in
the built-in adapter set, an unusual flag combination, or a test stub. When
`command` is set, the host runs that command verbatim and skips the adapter
layer entirely; the workflow's resume bookkeeping does not apply because the
host has no way to know how the user's CLI handles session continuation. That
part is the user's responsibility.

`agent` and `command` are mutually exclusive execution selectors. The state
either runs through a built-in adapter (`agent`) or through an explicit escape
hatch (`command`). A block that sets both is invalid.

Built-in adapters that support same-session resume know their own resume
invocation. An escape-hatch `command` user who wants resume-aware behavior has
to build that into their own CLI wrapper. Tychonic core carries only one
execution selector for a state, plus the numeric `resume` budget used by
workflow code.

Activity call sites execute the one selector declared by the validated state
block: `command` runs the state-block escape hatch, and `agent` runs a built-in
adapter. Schema validation rejects a block that sets both selectors or neither
selector when its TYPE requires an executable agent path.

Workflow call inputs carry runtime data such as `prompt`, `worktreePath`,
`sessionId`, and `verificationCommands`. They do not carry `command` or `agent`;
execution selection belongs to `profile.states.<name>`.

## Built-in Adapter Coverage

The built-in adapters do not have identical capabilities:

- **claude**, **codex** — full coverage: new run, resume by session id,
  role-aware permission flags, and worker / reviewer roles.
- **kiro** — Kiro path through `kiro-cli acp`. Fresh runs call ACP
  `session/new`, store the returned `sessionId` as `AgentSessionRecord.id`,
  send the prompt through `session/prompt`, and resume through `session/load`.
  The adapter acts as the ACP client for the one workflow turn. Work states may
  use file and terminal client capabilities inside the workflow worktree. Review
  states may inspect files and run checks, but must not edit code: the review
  client does not advertise file-write capability, rejects direct
  `fs/write_text_file` requests, and fails the review if tracked files change
  during the turn. Tychonic must not infer identity from
  `kiro-cli chat --list-sessions` before/after diffs. Review states may use it
  only with `normalizer: claude` or `normalizer: codex`.
- **gemini** — worker and prose-review fresh-run coverage only. Review states
  may use it only with `normalizer: claude` or `normalizer: codex`.
  `runResume` throws `AdapterUnsupported` because `gemini --resume` takes a
  project-relative index rather than a stable session id.

The host schema rejects `agent: "gemini"` or `agent: "kiro"` on a
`type: "review"` state unless `normalizer` is `claude` or `codex`. A custom
`command` wrapper may still implement its own review or continuation contract,
but Tychonic does not synthesize adapter normalization or resume behavior for
the escape-hatch command path.

## Pass-Through Values vs Orchestration Values

Tychonic is an orchestrator for external agent CLIs. It must not bake in
defaults for settings whose authoritative source is the external CLI or its
provider.

**Rule:** if a supported built-in agent CLI exposes a model or reasoning effort
setting, Tychonic may expose the corresponding state config field as an optional
pass-through. Tychonic must not carry a system default for that setting, must
not maintain the vendor's valid-value catalog, and must omit the downstream
flag/config override when the field is absent. Escape-hatch `command` states
own their complete command string and do not use these adapter fields.

- **Orchestration values** — settings Tychonic owns because they encode
  Tychonic's own isolation and safety contract. Role-aware defaults are allowed
  only when they are attached to an explicit adapter contract. Current
  config-field list: `sandbox`, `approval`, `permission_mode`, and
  `trust_all_tools`. The command shape itself (argv, stdin contract, resume flag
  where supported) is owned by the built-in adapter and by the operator for the
  escape-hatch `command` path.
- **Adapter pass-through values** — optional settings the built-in adapter maps
  directly to a verified CLI surface. Current fields are `model` and
  `reasoning_effort`. Unsupported vendor knobs such as `thinking_budget`,
  `approval_mode`, `effort`, and provider endpoints are not schema fields; use
  an escape-hatch `command` if a workflow must own such a command line before
  Tychonic has an explicit adapter contract.

Consequence: a new model name or renamed effort level on the external side does
not require a Tychonic schema change. The field remains a string and the
selected external CLI is the validator for its own value set.

Reviewer-capable adapters and reviewer-capable escape-hatch commands must
produce the shared `tychonic.review.v1` object documented under
`src/review/SPEC.md`.
