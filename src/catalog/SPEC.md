# Catalog Module SPEC

This file applies to config schema, profile loading, bundle default profile
parsing, and workflow input handoff code under `src/catalog/`.

## Configuration Model

A workflow bundle's default profile is the **default** source of configuration
for that workflow. Bundles derive it from the YAML state-machine source in
`workflow.yaml`. A single `--config <file>` may replace it for one run. There
is no global configuration file, no repository configuration file, no
product-default configuration file, and no layered merge pipeline.

Configuration has exactly two top-level groups. No others.

- `states.<name>` — state config blocks keyed by state NAME. Each block is
  fully self-contained and includes a mandatory `type` field that binds the
  state to an activity TYPE, the settings that TYPE requires, and any agent
  fields it needs (`agent`, `resume`, `command`, `sandbox`, `approval`,
  `permission_mode`, `trust_all_tools`, `timeout`).
- `policies.<name>` — workflow-level orchestration policy values that are not
  per-state. The top-level `policies` value must be an object. The host config
  schema treats its entries as opaque workflow-owned values keyed by string; it
  does not require policy values to be objects or to follow the state NAME
  grammar. Each workflow bundle defines, validates, and consumes the policy keys
  and value shapes it cares about. The standard workflow interaction helper
  validates the `policies.interaction` value shape that it consumes.

There is no `agents.<name>` top-level, no `commands.<name>` top-level, no
`activity_timeouts.<name>` top-level, no `work` / `review` slot blocks, no
`profile` file concept, no `name` or `template` field in a config file.
Workflow selection is a CLI invocation argument, not a file field.

State NAMEs are arbitrary identifiers unique within the file. State config block
types are the fixed product-controlled set `work`, `verify`, and `review`. Each
TYPE has a documented contract for its activity's inputs and outputs. The TYPE
field exists for schema validation and for binding the state to its activity
function, not for orchestration. A workflow never branches, retries, or selects
states based on TYPE. See `src/workflows/SPEC.md` for the full NAME/TYPE
contract.

Workflows reference states by NAME only. In declarative `workflow.yaml`
bundles, retry, aggregation, and multi-state orchestration live in the YAML
state machine and generated Temporal workflow wrapper.

## Bundle Config Is The Default Source

The default config for a workflow run is the installed workflow's
`defaultProfile`, validated once at install time and again at workflow start by
`TychonicConfigSchema`. Bundles derive this profile from `workflow.yaml`. A
caller may replace it for one invocation through `--config <file>`. No other
file — not a
user home-directory config, not a repository config, not a product-default
config — is read, merged, or consulted.

`tychonic run <name>` resolves the run's profile from exactly one config source:
the installed bundle's `defaultProfile`, or the whole-object replacement file
passed with `--config <file>`. Raw workflow input from `--input` or
`--input-file` must not include a top-level `profile` field; that field is
reserved for Tychonic's internal handoff of the effective profile to workflow
code. When raw workflow input is supplied, it must be a JSON object so the
reserved handoff can be attached without changing the payload's category.
Pulling the state and policy contract into one workflow-owned source keeps the
contract single-sourced: a workflow author declares state names, types, and
policy values once, in `workflow.yaml`, and the runtime reads exactly that.

Workflow run input is a stable task-shaped public contract for every installed
workflow. The only public top-level input fields are required `cwd`, optional
`goal`, and optional `promptAdditions`. `profile` is reserved for Tychonic's
internal config handoff and is not public workflow input. Workflow prompts are
owned by workflow source. Declarative prompt templates may explicitly reference
`{{goal}}`; unknown variables are rejected during install. Prompt additions must
be additive and use one uniform shape: `promptAdditions.<stateName>`. The
`<stateName>` key must name a state with type `work` or `review` in the
effective `profile.states`. The host auto-derives the set of valid
`promptAdditions` keys from the profile; bundle authors do not declare them
separately. The host rejects unknown `promptAdditions` keys and non-string
addition values. Workflows must not expose top-level prompt fields such as
`architectPrompt`, `builderPrompt`, or agent-named fields such as
`kiroFixPrompt`; those names leak internal workflow implementation into the
public invocation contract.

Two consequences follow and must both hold:

- Absent fields stay absent. Agent settings whose valid values are owned by the
  OpenP/backend CLI, such as `model` and `reasoning_effort`, appear only as state
  config fields documented below. Workflow authors may explicitly choose them
  per state only after checking the target account, model availability,
  plan/tier, quota, pricing, region/country access, and organization policy.
  Tychonic never fills them with defaults and never validates the vendor's model
  catalog. If omitted, the generated command omits the corresponding CLI flag or
  config override.
- Product defaults are expressed in workflow code, not configuration.
  Invariants that must hold regardless of any bundle's `defaultProfile` (for
  example, per-TYPE command timeout defaults when a block omits `timeout`) are
  applied by the activity implementation or by the workflow module itself. They
  are not injected into the user-visible config.

## CLI Overrides

Callers that need to override settings for a single workflow start may supply a
config file through `--config <file>` on `tychonic run`.

An override replaces the bundle's `defaultProfile` as a single whole object for
that one invocation. The override file is YAML or JSON text matching the same
`tychonic.config.v1` shape. There is no field-level merge, no array merge, no
per-block merge. If the override declares `states.<name>`, the bundle's
`states.<name>` is discarded entirely for that invocation — the override must
include every block the workflow needs.

An override never survives past the workflow start it was passed to. Running
workflows never re-read any config file.

## Immutability

Before workflow start Tychonic loads the bundle's `defaultProfile`, optionally
replaces it whole with a CLI-override file, validates the resulting
`TychonicConfig`, injects the parsed object into the run input under the
reserved `profile` field, and validates the standard workflow input contract.
Running workflows must not re-read any config source for state decisions after
start.

Each run records one `profile_snapshot.yaml` artifact so the effective settings
are reproducible evidence. No `profile_sources.json` artifact is written —
there is only one source, the bundle, and the snapshot itself is sufficient.

## State Config Block Contract

Every state config block (`states.<name>`) is a self-contained unit:

```yaml
states:
  work:
    type: work
    agent: codex
    model: gpt-5.5
    reasoning_effort: xhigh
    resume: 3
    timeout: 30m
  primary_review:
    type: review
    on_fail_return_to: work
    agent: claude
    model: opus
    reasoning_effort: max
  first_review:
    type: review
    on_fail_return_to: work
    agent: kiro
    model: claude-opus-4.6
    normalizer: codex
  verify:
    type: verify
    command: |
      npm run typecheck
      npm run build
      npm test
      npm run validate:examples
    timeout: 15m
```

Rules:

- `type` is mandatory and must be one of the product-defined set. The current
  types are `work`, `verify`, and `review`. New types are added by releasing new
  product code, not by user declaration.
- The settings allowed in a block are the union of settings the type contract
  requires, explicit agent settings (`model`, `reasoning_effort` where
  supported), and orchestration values Tychonic owns (`resume`, `sandbox`,
  `approval`, `permission_mode`, `trust_all_tools`, `timeout`). Unknown fields
  are a validation error.
  Known settings that the selected built-in adapter does not support remain
  syntactically valid, but Tychonic records operator-visible config warnings
  and ignores those unsupported settings for that adapter.
- `model` is valid only with `agent`. It selects the model for the primary
  built-in adapter when that CLI supports a model flag. Current built-in
  adapters `claude`, `codex`, and `kiro` all support it. A workflow
  author may explicitly choose `model` per state only after checking the target
  account, model availability, plan/tier, quota, pricing, region/country access,
  and organization policy. Omitting `model` explicitly delegates model choice to
  the selected OpenP backend's default or auto-selection behavior. Tychonic
  passes the string through and does not maintain the vendor model list. Because
  target account, model availability, plan/tier, quota, pricing, region/country
  access, and organization policy vary by operator, Tychonic does not define a
  universal default model profile. Reference examples are inputs for authors to
  adapt, not defaults to reuse unchanged. When a built-in CLI reports the
  concrete model that handled the request, Tychonic compares that report with
  exact versioned model strings it sent from state config and fails the activity
  on mismatch. Claude versionless aliases such as `opus` are pass-through
  aliases, so they are not exact-match asserted against the concrete model the
  CLI resolves internally. Some CLI catalogs are account-, tier-, or
  region-scoped; provider model listing output is evidence of availability for
  that account, not a global validity list for every documented model id.
- `reasoning_effort` is valid only with `agent`. All three built-in adapters
  (`claude`, `codex`, `kiro`) support it through OpenP `--effort`. A workflow
  author may explicitly choose it per state only after the same
  target-environment checks required for `model`. Omitting it delegates to the
  selected OpenP backend's configured/default effort. Tychonic passes the string
  through and does not invent a default.
- Allowed fields inside a state block are exactly `type`, `agent`,
  `on_fail_return_to`, `normalizer`, `resume`, `command`, `model`,
  `reasoning_effort`, `timeout`, `sandbox`, `approval`, `permission_mode`, and
  `trust_all_tools`. Unknown fields are a validation error.
- `on_fail_return_to` is required on every `type: review` block and rejected on
  non-review blocks. It must name an existing non-review state in the effective
  profile.
  The field declares where failed review feedback returns when the workflow
  has a review loop; it does not define a full graph, ordering, or branching
  model.
- `agent` is the primary input: it selects one of the built-in adapters
  (`claude`, `codex`, `kiro`). The host writes the CLI's `argv`, the supported
  OpenP public flags, and resume invocation where the selected adapter supports
  same-session resume.
- `normalizer` is review-only. It is required when `type: review` selects
  `agent: kiro`, because that agent produces prose review
  output rather than the structured semantic payload the host can validate. The
  normalizer must be `claude` or `codex`, is prompted with only the primary
  review output, and emits the semantic review payload that the host normalizes
  into `tychonic.review.v1`. Normalizer model flag selection is host-owned:
  `normalizer: claude` passes `model: haiku`, and `normalizer: codex` passes
  `model: gpt-5.3-codex-spark`. Workflow config does not expose separate
  normalizer model or reasoning fields. Direct structured reviewers (`claude`,
  `codex`) and escape-hatch `command` reviewers must not set `normalizer`.
- `resume` is a non-negative integer (default `0`). It is a simple continuity
  budget a workflow may read when it explicitly chooses to continue an existing
  external agent session. `resume: 0` disables same-session continuation by
  convention. The host does not infer resume behavior from state TYPE, state
  NAME, `agent`, `command`, or the mere presence of this field; workflow code
  decides whether to call a resume-capable activity. When workflow code calls a
  built-in adapter resume path with a prior session id, Tychonic writes that
  adapter's resume invocation. On the escape-hatch `command` path, Tychonic does
  not synthesize resume behavior; the workflow or wrapper owns whatever custom
  session-continuation behavior it wants.
- `command` is the escape hatch: it runs the literal shell command verbatim and
  bypasses the adapter layer. Use it for non-default CLIs or unusual flag
  combinations. `agent` and `command` are mutually exclusive execution
  selectors; a state block must set exactly one of them when its TYPE requires
  an executable agent path.
- State NAMEs are unique identifiers within the effective configuration.
  Workflow code calls activities by these state NAMEs. Two state config blocks
  with the same NAME is a validation error even if their TYPEs differ.
