# AGENTS.md

This file is the short project rule sheet for Tychonic. Use it together with
the user/global agent rules. Product contracts live in `SPEC.md` and the module
`SPEC.md` files linked from that root index.

## Product Boundary

Tychonic is a local work-operations state machine for delegated AI work.
It is not a dashboard product, chat wrapper, public API, webhook service,
team service, or repo-local task database.

The active product path is TypeScript: CLI, Temporal workflows, configuration
schema, agent adapters, web status UI, and tests stay in one TypeScript package
and type system.

## Source Of Truth

- Temporal workflow history and Temporal APIs are the only source of truth for
  workflow state.
- Do not add repo-local state stores for product state.
- Tychonic-owned artifacts, live output, patches, and isolated worktrees are
  evidence/runtime support files, not state authority.
- The local status UI reads Temporal-backed status and evidence summaries only.

## Workflow Contract

- Workflow behavior is authored as declarative `workflow.yaml` bundle source.
- Install validates that source and generates explicit Temporal `workflow.mjs`
  plus `workflow.generated.mmd`.
- Operators author `workflow.yaml`; hand-written `workflow.mjs` is not a source
  bundle entrypoint.
- Tychonic core contains zero workflow modules. User workflows are installed
  bundles; examples under `examples/workflows/` are opt-in installs.
- Workflow code owns ordering, branching, retry, loops, aggregation, and stop
  conditions. Runtime config never defines orchestration.
- Every `type: review` state declares `on_fail_return_to`.
- Review failure returns to the declared fix state until pass, attempt limit,
  or explicit user intervention.

## Configuration Contract

- Runtime configuration has exactly two top-level groups:
  `states.<name>` blocks and workflow-owned `policies.<name>` values.
- Each state block is self-contained. Do not force one global model or one
  model per agent.
- OpenP/backend-owned settings such as model, reasoning effort, and thinking
  budget stay optional; omission means omit the downstream CLI flag.
- A `--config <file>` override or signal payload replaces the bundle
  `defaultProfile` as one whole object for that invocation. No deep merge,
  array merge, implicit inheritance, or preset fill-in.

## Agent Contract

- Built-in adapters are `claude`, `codex`, and `kiro`.
- Normal user selection is `agent: "<name>"`; `command` is an escape hatch.
- Reviewer command selection belongs to review state config, not per-run task
  input.
- Built-in adapters dispatch through `openp <backend>` and preserve
  resumability through `openp <backend> --resume`.
- For review states, `kiro` is a prose-review primary agent only
  and requires `normalizer: claude` or `normalizer: codex`.
- Structured reviewers must emit the documented review contract.
- Do not use raw agent CLI calls as the product path for structured review
  verdicts, structural issue discovery, or commit-readiness review. Use a
  Tychonic `review` state or documented workflow bundle.

## Public Input Contract

- Public run input is required `cwd`, optional `goal`, and optional
  `promptAdditions` only when the workflow supports additive per-state prompt
  instructions.
- Prompt text is owned by workflow source.
- `promptAdditions` keys must match promptable state NAMEs in the effective
  profile.
- Top-level prompt fields and agent-named input keys are forbidden.

## Implementation Rules

- Implement exactly the requested behavior. Do not add convenience features,
  fallback paths, forgiving parsers, or shortcut behavior without approval.
- No implicit or magical behavior: every runtime behavior must trace to
  workflow code, activity configuration, policy value, or schema.
- Configuration is data; orchestration is code.
- Replace across config sources; never merge across sources.
- Pass through downstream-owned values. Tychonic must not invent defaults for
  external OpenP/backend settings.
- Do not invent abstractions unless existing concepts cannot express the
  requirement.
- If two concepts differ by only one field, collapse them unless they have
  clearly different contracts.
- Ambiguous names are design failures. Rename or split at the type/name level.
- Runtime data and execution selection are different contracts; do not hide
  them in generic buckets such as `extras`, `options`, `params`, or `data`.

## State NAME Boundary

- State NAME is workflow-owned.
- Activities, shared helpers, schemas, and validators stay NAME-agnostic and
  TYPE-blind.
- Activity source code never hardcodes a state NAME.
- Helpers that read a run record take relevant NAMEs from the calling workflow.
- Workflow code never branches, retries, or aggregates by TYPE.

## Worktree And Evidence

- Isolated worktrees live under `~/.tychonic/worktrees/...`, not the target repo
  and not `/tmp`.
- Finish paths capture a `worktree_patch` artifact and leave the worktree for
  operator inspection/removal.
- Repositories with git submodules are initialized automatically when the
  worktree is created.
- Tychonic does not provide a normal cleanup activity, signal, or CLI command
  that removes finished workflow worktrees.

## Web Status UI

- `tychonic runtime up` starts the local status UI with the runtime by default.
- Hidden standalone `tychonic web` remains available for status-UI-only
  operation and binds to loopback by default.
- Operational service install manages `com.tychonic.web` together with
  `com.tychonic.temporal` and `com.tychonic.worker`.
- The UI may show workflow/state summaries and focused selected-state evidence
  such as prompt, terminal agent response, structured review result, and small
  artifact excerpts.
- Large raw artifacts, full logs, and complete run-record dumps stay behind
  focused CLI commands.
- Event refresh is only a convenience trigger to re-read Temporal state; it is
  not a second state channel.

## Documentation Authority

- `SPEC.md`, module `SPEC.md` files, `AGENTS.md`, `SKILL.md`,
  `workflow-module-contract.md`, and bundle READMEs are authoritative surfaces.
- Do not introduce new contracts, policy statements, or source-of-truth changes
  in those files without an explicit user decision.
- Public docs and package files must not expose non-public identifiers,
  account details, credentials, or temporary operating records.

## Validation

- Code changes require relevant tests/builds.
- UI changes require browser verification.
- Before commit, follow the global independent-review rule.
- If checks pass but the actual workflow or UI behavior is bad, the work is not
  done.
