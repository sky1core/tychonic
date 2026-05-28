# Plugin Workflow Authoring

A Tychonic workflow bundle is a directory that contains exactly one authoring
entrypoint: declarative `workflow.yaml`.

`workflow.yaml` declares state config, prompts, and pass/fail transitions in
one validated state-machine document. During `tychonic workflows install`,
Tychonic generates `workflow.mjs` for the Temporal worker and
`workflow.generated.mmd` for static graph preview. Do not edit generated files;
edit `workflow.yaml` and reinstall.

The bundle directory name must match `workflow.yaml`'s `name`. The host runtime
owns no workflow modules; packaged reference examples, when
present, are inert files until operators install a bundle with
`tychonic workflows install`.

At workflow start, Tychonic injects the effective config into the workflow
input's reserved `profile` field and the generated wrapper passes that profile
to activities. Operators pass workflow input as a JSON object and do not put
`profile` in `--input` or `--input-file`. Per-run config replacement uses
`tychonic run --config <file>`.

The host validates the standard input contract (`cwd`, `goal`, `profile`,
`promptAdditions`) at CLI preflight, before Temporal starts. `promptAdditions`
keys are auto-derived from the effective profile: every state with type `work`
or `review` is a valid key. `createTychonicWorkflowContext` repeats the same
standard validation inside the Temporal sandbox as a defense-in-depth guard.
The generated wrapper uses that helper at workflow start. Workflow-specific
policy validation runs inside generated workflow code when the declarative
contract exposes the policy. The standard interaction helper validates the
`policies.interaction` shape that it consumes.

## Minimal Bundle

Minimal declarative bundle:

```yaml
version: tychonic.workflow.v1
name: myWorkflow
worktree: true
max_steps: 20
start: work
states:
  work:
    type: work
    agent: claude
    prompt: |
      Complete the requested work.

      Goal:
      {{goal}}
    on_pass:
      goto: review
    on_fail:
      finish: work failed
  review:
    type: review
    agent: codex
    on_fail_return_to: work
    prompt: |
      Review the work for correctness.
    on_pass:
      finish: true
    on_fail:
      goto: work
```

For review states, `on_fail.goto` must equal `on_fail_return_to`, and that
target must be a non-review state. When a declarative review state fails, the
generated wrapper appends the failed review summary and structured findings to
the next prompt for that declared return state when the return state is
prompt-bearing.

Declarative `workflow.yaml` requires `name`, and the value must match the
bundle directory name. `prompt` is valid only for `work` and `review` states;
`verify` states carry their deterministic `command` and must not declare a
prompt.

Validate and install:

```sh
tychonic workflows validate ./myWorkflow
tychonic workflows install ./myWorkflow
```

## Activity Rules

Workflow source owns ordering, branching, retry, loops, and aggregation.
That source is `workflow.yaml`; runtime configuration only declares named state
blocks and workflow-owned policy data.
Every `review` state declares `on_fail_return_to`; the target must be a
non-review state, and workflow code must route failed review feedback to that
declared state when it implements a review loop. Generated wrappers append
prompt feedback for prompt-bearing return states.
Only a parsed review verdict with `status: "fail"` is failed review feedback.
If a reviewer command fails, produces unparseable output, or is skipped, the
generated wrapper surfaces the run as `waiting_user` instead of treating that
condition as builder-remediation feedback.

The generated wrapper calls activities by state NAME. TYPE selects the activity
contract; NAME is the workflow-defined instance:

| Activity | TYPE | Required runtime fields |
|---|---|---|
| `startRunActivity` | n/a | `template`, `cwd` |
| `collectGitFactsActivity` | n/a | `run`, `cwd` |
| `createWorktreeActivity` | n/a | `run`, `cwd` |
| `extractWorktreePatchActivity` | n/a | `run`, `cwd`, `worktreePath`, `worktreeParentDir`, `baseHead` |
| `runVerifyActivity` | `verify` | `stateName`, `run`, `profile`, `cwd`, `worktreePath` |
| `runWorkerActivity` | `work` | `stateName`, `run`, `profile`, `cwd`, `worktreePath`, `prompt?`, `sessionId?` |
| `runReviewActivity` | `review` | `stateName`, `run`, `profile`, `cwd`, `worktreePath`, `prompt` |
| `finalizeRunActivity` | n/a | `run`, `summary?` |

Activity call inputs carry runtime data only: prompt text, worktree path,
session id, run record, and similar values. They must not choose which command
or agent runs. Execution selection belongs to `profile.states.<name>.agent` or
`profile.states.<name>.command`. Review states that use `kiro` as the primary reviewer must also declare
`profile.states.<name>.normalizer` as `claude` or `codex`.

Workflow run input must stay task-shaped. Public top-level input fields are
required `cwd`, optional `goal`, and optional `promptAdditions`. Workflow source
defines its own prompts. In `workflow.yaml`, prompt text may reference the
explicit variable `{{goal}}`; install rejects unknown `{{...}}` variables.
At runtime, the generated wrapper renders `{{goal}}` from the optional public
input `goal`, or from the literal fallback `(no explicit goal supplied)` when
the caller omits it. The host auto-rejects `promptAdditions` keys that do not
name a `work` or `review` state in the effective profile. Do not expose
top-level prompt fields or agent-named input keys.

Agent settings belong in the state config block next to `agent`. A workflow
author may explicitly choose `model` and supported `reasoning_effort` per state
only after checking the target account, model availability, plan/tier, quota,
pricing, region/country access, and organization policy. Omission intentionally
delegates to the selected CLI's default or auto-selection behavior. Do not pass
those values through activity runtime inputs. When a CLI reports the concrete
selected model, Tychonic fails the activity if that report differs from an exact
versioned model string in state config. Do not add separate normalizer model
fields; Tychonic owns the lightweight model flag for the normalizer. Kiro model
ids are OpenP Kiro backend ids and their availability can be account-, tier-,
or region-scoped; a successful `openp kiro --model <id>` smoke reports what
that account can run, not the global validity of every documented Kiro model
id. Target account, model availability, plan/tier, quota, pricing,
region/country access, and organization policy differ by operator, so
reference examples are starting points to adapt, not default profiles to reuse
unchanged.
Kiro states may set `model` and `reasoning_effort`; Tychonic passes them to
OpenP as `--model` and `--effort`.

QA/review states may inspect files and run checks. They must not modify source
code or silently repair findings. Review activities compare the git worktree
before and after the reviewer command when a git worktree is available; a net
source mutation fails the review. Kiro review states that need non-interactive
tool use may set `trust_all_tools: true`; the adapter still rejects direct file
writes. If a workflow wants automated repair after QA, call an explicit work
state with its own NAME and config.

Every activity returns records through `ActivityResult.delta` and optional
TYPE-specific outcome payloads. The activity does not mutate `input.run`; the
generated wrapper merges the returned records into its local run copy before the
next step through the `tychonic/workflow` helper surface so `workflow.yaml`
stays focused on state order, branches, loops, prompts, and stop conditions.

## Workflow Sandbox

Temporal workflow code runs in a deterministic sandbox.

- Generated `workflow.mjs` must stay deterministic; author workflow behavior in
  `workflow.yaml`, not by editing generated code.
- Put file, shell, and network work inside activities.

Tychonic copies the source bundle and writes generated `workflow.mjs` plus
`workflow.generated.mmd` into the installed copy. It does not run
`npm install`, copy arbitrary host `node_modules`, create symlinks, or rewrite
resolver paths.

## Policies And Signals

`policies.*` is workflow-owned data. The top-level `policies` value must be an
object, but each `policies.<name>` value is opaque to the host. Each workflow
validates the policy keys and value shapes it consumes.

Signal names, query names, payloads, and recovery behavior are workflow bundle
contract only when Tychonic exposes them through declarative YAML fields. Do not
add hand-written `workflow.mjs` to obtain custom signals; source bundles
containing `workflow.mjs` are rejected. If the current YAML contract cannot
express a needed signal or recovery shape, update the product contract and
generator first, then author it in `workflow.yaml`.

## References

- [SPEC.md](../SPEC.md): authoritative product contract index and module SPEC map
- [skills/tychonic-cli/workflow-module-contract.md](../skills/tychonic-cli/workflow-module-contract.md): compact authoring contract
- [examples/workflows/verifyOnlyWorkflow](../examples/workflows/verifyOnlyWorkflow): minimal no-agent verify example
- [examples/workflows/simpleWorkflow](../examples/workflows/simpleWorkflow): work, verify, and review reference example
- [examples/workflows/pipelineWorkflow](../examples/workflows/pipelineWorkflow): multi-stage example
- [examples/workflows/checkpointWorkflow](../examples/workflows/checkpointWorkflow): deterministic gate and structured review example
- [examples/workflows/architectBuilderQaWorkflow](../examples/workflows/architectBuilderQaWorkflow): reference architect/builder/QA example
- [examples/workflows/architectBuilderFinalQaWorkflow](../examples/workflows/architectBuilderFinalQaWorkflow): Kiro-assisted build with Codex final QA
- [examples/workflows/architectBuilderFirstReviewQaWorkflow](../examples/workflows/architectBuilderFirstReviewQaWorkflow): Kiro build and first normalized review before Codex final QA
- [examples/workflows/structuralIssueDiscoveryWorkflow](../examples/workflows/structuralIssueDiscoveryWorkflow): contract checks, scoped structural reviews, and finding audit
