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
`config.yaml` (see SPEC §Configuration Model).

A `--config <file>` override or a Temporal signal payload replaces the
bundle's `config.yaml` as a single whole object for that one invocation. No
deep merge, no array merge, no implicit inheritance, no presets that silently
fill fields.

Workflow behavior is TypeScript code. Configuration never defines workflow
graphs, branching, candidate retry, or type-based orchestration.
Workflows reference activities by name and call each activity explicitly.

## Agent Principle

Built-in worker agents must preserve resumability when the underlying CLI
exposes a usable session key.

Agent-specific command details belong behind adapter boundaries and typed
settings. Shared workflow code should depend on common activity contracts, not
on provider-specific command strings.

Permissions must match the role and execution boundary: coding work needs enough
permission to edit and test inside an isolated worktree, while review work
should stay constrained.

Structured reviewers must emit the documented review contract.

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
AGENTS, README, guardrails) before changing code, and commit the contract
change separately when practical.

### 9. Replace, do not merge, across sources.

When a CLI `--config <file>` override or Temporal signal payload replaces
a bundle's `config.yaml` for a single invocation, the override replaces
each top-level block as a whole. Field-level merge, array concatenation,
form transitions, and special-case "mutual exclusion" handling are all
banned. A reader must be able to open one file and know what that file
does without running a merge tool.

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
- `.gitignore` / `.jjignore` standard globs
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
