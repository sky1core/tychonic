# Adapters Module SPEC

This file applies to built-in agent adapters under `src/adapters/`.

## Adapter Model

Tychonic ships three built-in adapter labels: `claude`, `codex`, and `kiro`.
Workflow authors select one of those labels with `agent: "<name>"` in a state
config block. The label is a Tychonic contract, not a direct promise to invoke a
vendor CLI with the same binary name.

All built-in adapter labels dispatch through OpenP:

```text
openp <backend>
```

The single `src/adapters/openp.ts` module is the built-in adapter
implementation. It creates one adapter instance per backend and owns the shared
command-building, resume flag, execution-policy mapping, JSON-schema review flag, and
stream-json result parsing. Do not reintroduce `claude.ts`, `codex.ts`, or
`kiro.ts` as separate adapter implementations unless the product contract is
changed first.

The default code path for every executable agent activity is agent-driven:

- `agent` selects one built-in OpenP backend.
- `command` is the escape hatch for custom CLIs, unusual flags, or test stubs.
- `agent` and `command` are mutually exclusive execution selectors.
- Workflow call inputs carry runtime data such as `prompt`, `worktreePath`,
  `sessionId`, and `verificationCommands`; they do not carry execution
  selection.
- Activity call sites execute the selector declared by
  `profile.states.<name>`.

The host validates selector shape before execution. A TYPE that requires an
agent path must set exactly one selector. A `command` state bypasses the adapter
layer entirely; Tychonic does not synthesize OpenP flags, session continuation,
or structured-review normalization for that escape-hatch path.

## OpenP Command Contract

All built-in adapters require the `openp` executable. The command shape is:

```text
openp <backend> --timeout 0 [--model <model>] [--effort <level>] \
  --output-format stream-json [--dangerously-skip-permissions] \
  [--json-schema <json>] [--resume <session-id>]
```

Rules:

- Prompt text is delivered on stdin.
- `--timeout 0` disables OpenP's turn timeout so the Tychonic activity timeout
  remains the authoritative wall-clock budget.
- `--model` is emitted only when the state config declares `model`.
- `--effort` is emitted only when the state config declares
  `reasoning_effort`.
- `--output-format stream-json` is always emitted. The adapter reads JSONL
  output and ignores non-JSON or malformed lines.
- `--resume <session-id>` is emitted only when workflow code explicitly calls a
  resume adapter path with a prior session id. The host does not infer resume by
  role, TYPE, NAME, agent label, or profile shape.
- `--dangerously-skip-permissions` is emitted according to the backend-specific
  Tychonic execution contract listed below.
- `--json-schema <json>` is emitted for review runs only where the selected
  built-in backend and turn type provide direct structured review output.
  Claude supports it on fresh and resume turns. Codex supports it on fresh
  turns only; Codex resume turns must not receive `--json-schema`. Kiro does
  not support it.

OpenP stdout is parsed for two adapter facts:

- `sessionId` comes from the first non-empty `openp.sessionId` field found in
  the stream-json output.
- `reportedModel` comes from the terminal active
  `openp.form: "result"` record's non-empty `openp.metadata.model` field.

These parsed values are evidence from OpenP. Temporal workflow history remains
the source of truth for Tychonic workflow state.

## Backend Coverage

The built-in labels share the OpenP command path but do not have identical
capabilities.

| Agent label | Backend command | Review output | Resume | Model | Reasoning effort |
| --- | --- | --- | --- | --- | --- |
| `claude` | `openp claude` | `--json-schema` | `--resume` | `--model` | `--effort` |
| `codex` | `openp codex` | `--json-schema` on fresh turns only | `--resume` | `--model` | `--effort` |
| `kiro` | `openp kiro` | prose primary review plus normalizer | `--resume` | `--model` | `--effort` |

Execution-policy mapping is backend-specific and constrained to OpenP public
options:

- `claude` emits no execution trust flag by default. The only accepted
  `permission_mode` value is `bypassPermissions`, which maps to
  `--dangerously-skip-permissions`. Claude-specific modes such as `plan`,
  `acceptEdits`, and `default` are not part of the Tychonic OpenP adapter
  contract. `sandbox`, `approval`, and `trust_all_tools` are unsupported for
  Claude and produce config warnings when declared.
- `codex` always emits `--dangerously-skip-permissions`. This is Tychonic's
  built-in Codex execution contract. `sandbox: danger-full-access` is accepted
  as an explicit declaration of the effective behavior. Other `sandbox` values
  produce config warnings and are ignored. `approval`, `permission_mode`, and
  `trust_all_tools` are unsupported for the Codex OpenP path and produce config
  warnings when declared.
- `kiro` emits `--dangerously-skip-permissions` when `trust_all_tools` is true.
  If `trust_all_tools` is omitted, work states default to trusted tool
  execution and review states default to no skip-permissions flag. `sandbox`,
  `approval`, and `permission_mode` are unsupported for Kiro and produce config
  warnings when declared.

Structured review availability is backend capability, not a global OpenP
guarantee.

Kiro backend review does not provide schema-constrained structured output.
Therefore a `type: review` state with `agent: kiro` must declare
`normalizer: claude` or `normalizer: codex`. The primary Kiro run produces
review prose. The normalizer turns that prose into the shared
`tychonic.review.v1` semantic payload. The normalizer must not invent findings
that are not grounded in the primary review output.

## Pass-Through Values vs Orchestration Values

Tychonic is an orchestrator for OpenP-backed external agents. It must not bake
in defaults for settings whose authoritative source is OpenP, the selected
backend, or the model provider.

Adapter pass-through values:

- `model` maps to OpenP `--model` for all three built-in backends.
- `reasoning_effort` maps to OpenP `--effort` for all three built-in backends.
- If either field is absent, the corresponding OpenP flag is omitted.
- Tychonic does not maintain a model catalog or effort-level catalog. The
  selected OpenP backend validates its own values.

Orchestration values:

- `sandbox`, `approval`, `permission_mode`, and `trust_all_tools` encode
  Tychonic execution policy, not provider model selection.
- A value may be syntactically accepted by the shared config schema and still be
  unsupported by a specific built-in backend. Unsupported backend options must
  produce operator-visible config warnings and be ignored for that adapter.
- Role-aware defaults are allowed only where this SPEC explicitly assigns them
  to a backend command contract.

Unsupported vendor knobs such as `thinking_budget`, `approval_mode`, provider
endpoints, or raw OpenP-specific options are not schema fields. Use an
escape-hatch `command` if a workflow must own such a command line before
Tychonic has an explicit adapter contract for it.

Reviewer-capable adapters and reviewer-capable escape-hatch commands must
produce the shared `tychonic.review.v1` object documented under
`src/review/SPEC.md`.
