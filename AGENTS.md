# AGENTS.md

## Core Product Principle

Tychonic is a local work-operations state machine for delegated AI work.

It is not a dashboard, a chat wrapper, or a repo-local task database. The
product exists to run agent work, deterministic checks, structured review, and
review/delegate continuation through one reliable workflow model.

## Source Of Truth

Use [SPEC.md](SPEC.md) as the current product contract.

Tychonic uses **Temporal only** for state management.

The only source of truth for product state is Temporal workflow history and the Temporal API.

Workflow progress, retries, review decisions, delegate continuation, cancellation,
session references, and resume state must be represented through Temporal
workflow history and Temporal APIs.

Do not add repo-local state stores for product state.

## Active Product Path

The active product path is TypeScript: CLI, local Web API, Temporal workflows,
configuration schema, agent adapters, and tests should stay in one TypeScript
package and type system.

## Workflow Principle

Workflow behavior belongs in TypeScript Temporal workflow code.

Tychonic core ships **zero first-party workflows**. The host package contains
no built-in workflow modules. Workflows are user-supplied bundles installed via
`tychonic workflows install`. Reference example bundles live under
`examples/workflows/` and are explicitly opt-in installs, not host defaults.

Configuration provides named activity instances and named policies for existing
workflows. It does not define workflow graphs, ordering, branching, fan-out,
joins, or loops.

Review failure is part of the workflow state machine: when review does not pass,
the workflow should continue back into fix work until it passes, reaches a
configured attempt limit, or requires explicit user intervention.

## Configuration Principle

Configuration has exactly two top-level groups: named `states.<name>`
blocks and named `policies.<name>` blocks. Each block is self-contained and
carries every setting it needs.

Do not force one global model or one model per agent. Each state config block
declares its own agent selection and its own settings. Settings that the
external agent CLI owns (model, reasoning effort, thinking budget, and
similar) must stay optional; omission propagates to flag omission in the
generated command.

Configuration has one source per workflow: the installed bundle's
`defaultProfile` export from `workflow.mjs` (see SPEC §Configuration Model).

A `--config <file>` override or a Temporal signal payload replaces the
bundle's `defaultProfile` as a single whole object for that one invocation.
No deep merge, no array merge, no implicit inheritance, no presets that
silently fill fields.

Workflow behavior is TypeScript code. Configuration never defines workflow
graphs, branching, retry, or type-based orchestration.
Workflows reference activities by name and call each activity explicitly.

## Agent Principle

Tychonic ships **built-in adapters for the supported agent CLI paths**:
`claude`, `codex`, `gemini`, `kiro`. The host owns command
synthesis, session resume where the adapter supports same-session resume,
agent-specific flags, and session-id handling for these paths. Users select an
adapter by setting `agent: "<name>"` in workflow input — no need to hand-write
the underlying CLI command, no need to know the agent's resume flag or
session-id encoding.

The `command` field is an **escape hatch for non-default scenarios** — a
custom CLI not in the built-in adapter set, an unusual flag combination, or a
test stub. The default code path for ordinary users is the agent label,
not a hand-written command.

Reviewer command selection is part of the review state contract. Per-run task
input must not create a second command-selection channel; task input describes
the work, and state config describes the execution environment. If a run needs
a different reviewer command, express it through the review state's config block
or through a whole-profile `--config` replacement for that run.

Built-in adapters preserve resumability — the host carries the worker
session key forward across resumes. Adapter-specific command details stay
behind adapter boundaries; shared workflow code depends on common activity
contracts, not on provider-specific command strings.

`gemini` is the exception for built-in automatic resume: its resume surface is
not a stable session id. The `kiro` adapter uses Kiro's ACP `sessionId` from
`session/new` and resumes through `session/load`. Tychonic must not infer Kiro
identity from `kiro-cli chat --list-sessions` before/after diffs.

For review states, `gemini` and `kiro` are prose-review primary agents only.
They require `normalizer: claude` or `normalizer: codex`; the
normalizer structures the primary review output and must not invent findings.

Retry and multi-attempt behavior belong in workflow code with explicit state
NAMEs. The host must not model attempts as an ordered data list of agents or
commands that it advances through implicitly, because that hides orchestration
inside configuration and violates the workflow/configuration boundary.
If a workflow needs multiple attempts, the workflow code must call explicit
states by NAME and expose the behavior as that workflow's own contract.

Permissions must match the role and execution boundary: coding work needs enough
permission to edit and test inside an isolated worktree. QA/review work may
inspect files and run verification commands, but it must not modify source code
or act as a hidden repair step.

Structured reviewers must emit the documented review contract.

## Spec Authority Principle

`SPEC.md` is the user-controlled product contract. Every line of SPEC reflects
a decision the user has explicitly made. Builder agents may sync SPEC prose to
match user-approved contract changes, but **agents must not introduce new
contracts, design rules, or policy statements into SPEC without an explicit
user decision for that specific contract**. "The user authorized this larger
refactor" is not authorization for individual SPEC clauses. When in doubt,
draft the change, surface it for user approval, and only then commit.

The same rule binds the rest of the source-of-truth surface: AGENTS.md,
SKILL.md, workflow-module-contract.md, and any bundle README that documents
authoritative contract.

## Usability Principle

A capability that the user cannot easily reach is a liability, not a feature.
Each user-facing input field, CLI flag, signal name, or recovery command must
fall into exactly one of:

- **Required** — workflow / command cannot run without it.
- **Optional with sensible default** — user may omit; the system supplies a
  reasonable value.
- **Advanced** — power-user knob; documented separately from the main surface.

Fields that are pure logging tags, runtime-ignored placeholders, or duplicates
of existing knobs are dead surface and must be removed, not tiered.

The author / user split is part of usability: workflow authors own
`defaultProfile` and the workflow contract; users own per-run input that is
specific to their task. Users must not be required to re-state values the
author already pinned.

## Public Surface Principle

Public docs and package files should contain only product behavior, installation
and runtime guidance, configuration examples, security boundaries, and
reproducible examples.

Do not expose non-public identifiers, account details, credentials, or temporary
operating records in public docs or package files.

## Design And Implementation Principles

These rules encode mistakes that already happened in this codebase. Every
contributor (human or agent) must check proposed changes against this list
before writing code or docs.

### 1. Implement exactly what the requirement states.

Deliver the asked-for behavior and nothing more. Do not add "convenience"
features, graceful shortcuts, helper commands, forgiving parsers, or
quality-of-life extensions that were not part of the stated requirement. If a
feature seems useful but was not requested, surface it as a separate proposal
and wait for explicit approval. Quiet additions hide design decisions from the
operator and from future readers.

### 2. No implicit or magical behavior.

Every runtime behavior must trace back to an explicit declaration in workflow
code, activity configuration, policy value, or schema. This prohibits:

- implicit retry or candidate rotation based on type, shape, or heuristics
- silently accepting malformed input by extracting "best-effort" meaning from
  it (for example, parsing plain text when a structured contract failed)
- defaults that fill in missing fields to make something "just work" when the
  user did not ask for that behavior
- inferring orchestration decisions from data that was meant for something else

Refuse, produce a clear error, or leave the value absent. Do not guess.

### 3. Match the requirement precisely; do not introduce shortcut paths.

If the requirement says "the reviewer must emit the structured contract",
implement exactly that. Do not also accept unstructured output "because the
user probably meant pass". If the requirement says "omit the flag when the
user omits the setting", do not add a system default "for convenience". The
cost of a shortcut path is years of debugging invisible behavior.

### 4. Pass through what downstream owns.

Tychonic is an orchestrator for external agent CLIs. Values whose
authoritative source lives outside Tychonic (model names, reasoning levels,
thinking budgets, provider endpoints, vendor-specific flags) must not carry
Tychonic-side defaults. Omission at the Tychonic layer must propagate to flag
omission in the generated command so the external CLI uses its own
configuration.

### 5. Configuration is data; orchestration is code.

Configuration declares named instances and values. Workflow code decides
order, retry, aggregation, branching, and every other control-flow concern.
The line is sharp. Do not encode control flow in YAML, schema, or layered
defaults. Do not let configuration silently influence which activity runs
next.

### 6. Do not invent concepts.

Before adding a new abstraction (manifest files, provider layers, adapter
registries, policy groups beyond `policies.*`, etc.), show that the existing
concepts cannot express the requirement. If a proposed concept has only one
concrete use, it is probably a name wrapper and should be dropped. Concrete
names tied to existing concepts are preferred over generic infrastructure
names.

### 7. Two things that differ in a single field are one thing.

If two schemas, two file types, or two layers share almost all their
structure and differ in one or two optional fields, collapse them. A second
concept earns its existence by having a clearly different contract, not by
having a slightly different presentation.

### 8. Contract before implementation.

State the user-facing contract first: inputs, outputs, invariants, error
modes, and layer semantics. The implementation exists to satisfy that
contract. When the contract changes, update the documented contract (SPEC,
AGENTS, GUARDRAILS, README, bundle docs) before changing code, and commit the
contract change separately when practical.

### 9. Replace, do not merge, across sources.

When a CLI `--config <file>` override or Temporal signal payload replaces
a bundle's `defaultProfile` for a single invocation, the override replaces
each top-level block as a whole. Field-level merge, array concatenation,
form transitions, and special-case "mutual exclusion" handling are all
banned. A reader must be able to open one source and know what that
source does without running a merge tool.

### 10. Leave obvious escape hatches for mistakes.

When a design decision introduces a new failure mode (a review contract that
can now reject valid-looking output, a strict config that now rejects a
profile people used yesterday), include the operator recovery path in the
same change: a clear error message, a CLI recovery signal, a documented
manual override. Do not ship stricter behavior without the recovery story.

### 11. Split, do not weaken, when the environment cannot satisfy a check.

A required check that fails because the current environment (worker
sandbox, CI without network, offline shell) cannot satisfy its
dependencies is a mismatch between the check and where it runs, not a
reason to make the check conditional. The correct response is to split
the check into environment-specific variants with distinct names — for
example, a worker-side gate that excludes network-dependent steps, and
a release gate that still includes them — and to document which gate
runs where. Never add conditional skips, "warning instead of failure"
paths, or silent shim branches inside a required gate to make it pass
in a constrained environment.

### 12. Briefs reference the spec; they do not serialize it.

A delegation brief states what to do and which spec section to follow.
It does not restate permanent contracts — type semantics, state
lifecycle, naming conventions, identifier relationships, invariants
that span multiple stages. Those belong in SPEC, type JSDoc, or code
comments next to the relevant definition, not inside a brief. When
writing a brief starts to require re-describing an invariant, stop and
treat that as a signal of a missing spec/comment: promote the invariant
to the permanent documentation first, then let the brief point at it
with a single reference. Copying contract fragments into briefs
invites a fresh interpretation drift on every delegation and a new
class of reviewer findings that are really just rediscoveries of the
same missing document.

### 13. Ambiguous names are design failures. Fix the name.

When two fields, variables, or types share a name, they must mean the
same thing. When they use different names, they must play clearly
different roles. If a reader has to consult documentation to tell them
apart, the code is lying. Do not paper over the confusion with
comments, glossaries, or "see also" cross-references — rename. If one
name would actually suffice, collapse to that one name (principle 7).
If two genuinely distinct concepts share a name or collide through
shape, give each a name that forces the distinction at every call
site. This is a direct application of principles 6 and 7 to identifier
hygiene: the fix is always at the name level, never at the narrative
level around it.

### 14. Iteration budget is not a substitute for spec quality.

`delegate`'s `max_review_iterations` exists to absorb ordinary
worker mistakes, not to rescue an ambiguous specification. If review
findings across successive iterations keep taking a different shape
while describing the same underlying concern, or keep exposing a new
corner of the same ill-defined contract, the problem is not the
worker — it is the spec. In that state, increasing the iteration
budget, restarting the loop, or rewording the prompt will not
converge; each extra iteration produces the next rediscovery of the
same gap. The required response is to stop the loop, identify the
ambiguous invariant, promote it into the permanent documentation
(principle 12), and only then resume. Meta-level detection of this
state belongs to the planned `stuck_problem_review` workflow and is
tracked as a product gap, not worked around with more iterations.

### 15. Model time and orchestration time are different budgets.

When a workflow uses an external agent CLI, distinguish between:

- time the external model is actually spending producing its answer
- time added by wrappers, shell glue, parsers, artifact capture, retries,
  heartbeats, resumability plumbing, or any other orchestration layer

The first can be an expected tradeoff of the chosen model/settings. The
second is product overhead and must be treated as a bug until disproven.

If logs show that the external agent already emitted a terminal contract
(`tychonic.review.v1`, final patch-producing worker output, or an equivalent
documented completion signal), but the surrounding command still hangs, fails
later, or keeps the workflow open longer than that agent work required, do not
explain it away as "the model is slow". Investigate the wrapper/process layer:
shell scripts, stdin handling, post-processing, heartbeat coverage, exit-code
propagation, and artifact/session bookkeeping.

Bootstrap validation must measure both budgets separately. Any unexplained tail
latency after the external agent has already finished counts as a regression,
even if the overall workflow eventually succeeds.

### 16. Resolve and discovery paths use standard mechanisms only. No staging tricks.

Every public resolve / import / discovery path Tychonic offers to external code
(plugin bundles, user projects, installers, CI) must work through the standard
mechanisms that already exist in the ecosystem:

- `package.json` `exports`, `main`, `bin`, `type`
- `npm install` and the resulting `node_modules` layout
- OS `PATH`, documented environment variables, launchd plists
- `.gitignore` standard globs
- Temporal SDK APIs, webpack resolver extension points documented by the SDK

It is a design error to make a validator, inspector, or build step "imitate" a
deployed environment by constructing a staging directory with ad-hoc
symlink arrays, self-reference aliases, synthesized `node_modules` trees,
temporary shim files, or environment-variable rewriting. Such staging pretends
to verify production behavior while silently depending on a private setup the
real user will never have. The moment that staging exists, resolve behavior
across the product quietly becomes "works only when Tychonic has pre-laid this
hack" — and subsequent code paths (worker bundler, install command, release
gate) inherit the same unstated precondition.

Concrete rules:

- If a plugin or external caller cannot reach a Tychonic module through the
  public `package.json` `exports` contract, the fix is to declare the export
  (or reject the dependency), not to arrange the filesystem so the import
  happens to resolve.
- If a dev-environment inconvenience exists only because the Tychonic repo is
  not installed as a package in itself, solve it with a standard tool
  (`npm link`, `npm pack && npm install -g`, a workspace manifest) and document
  the step. Do not encode the workaround into product code.
- Validators and inspectors that need a staging copy of an external file must
  reproduce only structure the real user already has. They must not add
  packages, links, or environment rewrites the real user is not required to
  supply.
- "It only needs to work during my own dev loop" is not a justification.
  Private shortcuts that touch the resolve path are the mechanism by which
  the product contract decays; once the shortcut is in the product tree it
  gets exercised on every run, even in environments where it should never
  have mattered.

If the standard mechanism cannot express the requirement, that is feedback
against the design, not a license for a staging workaround. Update the
contract (principles 6, 8, 13) or record the limitation (principle 10).

### 17. OS permission systems are not the product's business.

OS-level permission systems — macOS notification/camera/microphone/
accessibility/full-disk authorization, Linux `polkit`, Windows UAC — belong
to the OS, not to Tychonic. The product's job ends at three things:

- read the current permission state through the OS's documented API
- show that state to the user
- reflect whatever decision the user makes inside the OS's own settings UI

Everything beyond that is out of scope and is banned. Do not attempt:

- direct manipulation of permission stores: `tccutil reset`/`insert`/`delete`,
  reading or writing `~/Library/Preferences/com.apple.ncprefs.plist`, the TCC
  database under `/Library/Application Support/com.apple.TCC/`, or any
  equivalent on other OSes
- forcing permission/notification/Focus state via `defaults write` or similar
- separate diagnostic tasks that "manually verify" how a system permission
  dialog behaves, or scripts that try to reproduce/instrument that dialog
- AppleScript / `osascript` / accessibility automation used to dismiss,
  approve, or impersonate a permission prompt
- code that re-requests a permission the user has already denied, by
  rotating bundle identifiers, swizzling main bundle metadata, or any
  similar trick

When the product detects that a permission is denied or not yet granted,
the only correct next action is to **point the user at the OS's standard
settings page** (for macOS notifications: `open
"x-apple.systempreferences:com.apple.preference.notifications"`) and let
them decide. Anything else is wasted work — every OS update breaks it,
and it fights the user-consent model the OS is built around.

The same boundary applies during diagnosis. When notifications, camera
access, or any other permission-gated path doesn't work, do not start
grepping permission plists, parsing TCC tables, or streaming OS logs to
infer hidden state. The standard OS API call (e.g.
`UNUserNotificationCenter.getNotificationSettings`) is the only supported
read path, and its answer is the only evidence the product is allowed to
act on.

### 18. State NAME is workflow-only. Activities, helpers, and schemas stay NAME-agnostic and TYPE-blind.

State NAME is a workflow-defined contract. The workflow function that
owns a fix loop knows its own state NAMEs because it wrote them, and may
pass those NAME literals to its activity call sites. Every other layer
is NAME-agnostic and TYPE-blind.

- **Activity source code never hardcodes a state NAME.** Activities
  accept NAME as a parameter and run for any state of the matching
  TYPE — `runReviewActivity` runs for any `type: review` state
  regardless of NAME.
- **Shared helpers and utilities that read a `WorkflowRunRecord`** take
  NAMEs as parameters from the calling workflow, never as literals in
  source. A helper that summarises attempts or filters findings
  receives the relevant state NAMEs from its caller.
- **Schema layers** (`tychonic.review.v1`, `tychonic.run.v1`, config
  validators) carry no NAME-specific fields and impose no NAME-specific
  shape.
- **Workflow code never branches, retries, or aggregates by TYPE.**
  SPEC: *"A workflow never branches, retries, or aggregates based on
  TYPE."* TYPE exists only for schema validation and activity binding.
  Runtime decisions go through NAME literals the workflow itself
  defined, not through `state.type === "review"` style comparisons.

The exception is the workflow function that owns the loop. A workflow
defining a fix loop with NAMEs `work` / `verify` / `review` /
`continue_work` may use those literals because they are its own
contract with its own config. The literal must not leak past the
workflow function — into an activity, a shared helper, or a schema —
without being passed as a parameter.

This is the rule that lets a workflow rename its `review` state to
`ai_judgement`, or run three review states with three different NAMEs,
without changing any activity or shared helper.

### 19. Runtime data and execution selection are different contracts.

Do not hide different categories of input inside a generic bucket such as
`extras`, `options`, `params`, `data`, or another name that says nothing
about the contract. A name that can hold anything communicates nothing; it
lets unrelated concepts accumulate until the call site becomes a second
configuration channel.

Activity call inputs carry runtime data produced by the workflow at that
moment: prompt text, worktree path, session id, verification command evidence,
or similarly concrete values. They do not select which agent or command runs.

Execution selection belongs to the state config block. If a state runs a
built-in agent, the state block declares `agent`. If it runs a literal command,
the state block declares `command`. Workflow call sites must not reopen that
choice through alternate fields, wrapper objects, fallbacks, or override
channels.

When two values differ by category, split them at the type and name level.
Do not rely on prose comments to explain that one property inside a bucket is
"runtime data" while another property in the same bucket is "configuration."
That confusion is the design failure. Fix the shape so the distinction is
forced at every call site.
