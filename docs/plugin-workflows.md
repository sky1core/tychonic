# Plugin Workflow Authoring

A Tychonic workflow bundle is a directory that contains `workflow.mjs`.
`workflow.mjs` exports:

- one named workflow function
- `defaultProfile`, a `tychonic.config.v1` object for that workflow

The bundle directory name must match the exported workflow function name. The
host package ships no first-party workflows; operators install bundles with
`tychonic workflows install`.

At workflow start, Tychonic injects the effective config into the workflow
input's reserved `profile` field. Workflow authors pass `input.profile` to
activities; operators pass workflow input as a JSON object and do not put
`profile` in `--input` or `--input-file`. Per-run config replacement uses
`tychonic run --config <file>`.

## Minimal Bundle

```sh
mkdir myWorkflow
```

```js
// myWorkflow/workflow.mjs
import { proxyActivities } from "@temporalio/workflow";
import { createTychonicWorkflowContext } from "tychonic/workflow";

const act = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
});

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    work: { type: "work", agent: "codex" },
    verify: {
      type: "verify",
      command: `npm run typecheck
npm run build
npm test`
    },
    review: { type: "review", agent: "claude" }
  }
};

export async function myWorkflow(input) {
  const ctx = createTychonicWorkflowContext({
    input,
    template: "my_workflow",
    activities: act
  });

  await ctx.start();
  await ctx.createWorktree();
  await ctx.work("work", input.goal ?? "");
  await ctx.verify("verify");
  await ctx.review(
    "review",
    "Review the worker result and return the structured review payload."
  );
  return ctx.finish();
}
```

Validate and install:

```sh
tychonic workflows validate ./myWorkflow
tychonic workflows install ./myWorkflow
```

## Activity Rules

Workflow code owns ordering, branching, retry, loops, and aggregation.
Configuration only declares named state blocks and workflow-owned policy data.

Call activities by state NAME. TYPE selects the activity contract; NAME is the
workflow-defined instance:

| Activity | TYPE | Required runtime fields |
|---|---|---|
| `startRunActivity` | n/a | `template`, `cwd` |
| `collectGitFactsActivity` | n/a | `run`, `cwd` |
| `createWorktreeActivity` | n/a | `run`, `cwd` |
| `runVerifyActivity` | `verify` | `stateName`, `run`, `profile`, `cwd`, `worktreePath` |
| `runWorkerActivity` | `work` | `stateName`, `run`, `profile`, `cwd`, `worktreePath`, `prompt?`, `sessionId?` |
| `runReviewActivity` | `review` | `stateName`, `run`, `profile`, `cwd`, `worktreePath`, `prompt` |
| `finalizeRunActivity` | n/a | `run`, `summary?` |

Activity call inputs carry runtime data only: prompt text, worktree path,
session id, run record, and similar values. They must not choose which command
or agent runs. Execution selection belongs to `profile.states.<name>.agent` or
`profile.states.<name>.command`. Review states that use `gemini` or `kiro` as
the primary reviewer must also declare
`profile.states.<name>.normalizer` as `claude` or `codex`.

Agent settings belong in the state config block next to `agent`. Pin `model`
for the primary `agent` when a state's quality, latency, or cost profile
matters; omission intentionally delegates to the selected CLI's default or
auto-selection behavior. Use `reasoning_effort` only for agents that support
it, and set it on Claude/Codex states whose quality depends on reasoning
depth. Do not pass those values through activity runtime inputs. Do not add
separate normalizer model fields; Tychonic owns the lightweight model flag for
the normalizer. Kiro states may set `model`, but not
`reasoning_effort`; the installed Kiro CLI ACP surface exposes no stable
reasoning/effort/thinking option.

QA/review states may inspect files and run checks. They must not modify source
code or silently repair findings. Review activities compare the git worktree
before and after the reviewer command when a git worktree is available; a net
source mutation fails the review. Kiro review states that need non-interactive
tool use may set `trust_all_tools: true`; the adapter still rejects direct file
writes. If a workflow wants automated repair after QA, call an explicit work
state with its own NAME and config.

Every activity returns records through `ActivityResult.delta` and optional
TYPE-specific outcome payloads. The activity does not mutate `input.run`; the
workflow must merge the returned records into its local run copy before the
next step. Prefer `createTychonicWorkflowContext` or `applyActivityResult` from
`tychonic/workflow` for that bookkeeping so workflow modules stay focused on
state order, branches, loops, prompts, and stop conditions.

## Workflow Sandbox

Temporal workflow code runs in a deterministic sandbox.

- Do not use Node I/O APIs such as `node:fs`, `node:child_process`, or
  `node:net` inside `workflow.mjs`.
- Do not make workflow decisions from non-deterministic top-level values.
- Put file, shell, and network work inside activities.
- Use `@temporalio/workflow`, `tychonic/workflow`, copied relative support
  modules, or real package dependencies shipped with the bundle. Tychonic
  provides `@temporalio/workflow` and `tychonic/workflow`; other package
  dependencies are bundle-owned.

Tychonic installs the bundle directory as-is. It does not run `npm install`,
copy arbitrary host `node_modules`, create symlinks, or rewrite resolver paths.

## Policies And Signals

`policies.*` is workflow-owned data. The host schema validates only the outer
profile shape; each workflow validates the policy keys it consumes.

Custom signal names, query names, payloads, and recovery behavior are also part
of the workflow bundle contract. Document them in that bundle's README.

For ordinary workflow modules, use `createTychonicWorkflowContext`. It wraps
start/worktree/work/verify/review/finalize bookkeeping and standard status
snapshots while the workflow still calls each state by NAME:

```js
const ctx = createTychonicWorkflowContext({ input, template: "my_workflow", activities: act });

await ctx.start();
await ctx.createWorktree();
await ctx.work("work", input.goal ?? "");
await ctx.verify("verify");
await ctx.review("review", "Review the worker result.");
return ctx.finish();
```

Use `createTychonicRunState` directly only when a workflow needs custom
snapshot handling outside the context helper. It supports `tychonic run --wait`,
`tychonic wait <workflow-id>`, or status checks before final completion:

```js
import { createTychonicRunState } from "tychonic/workflow";

const runState = createTychonicRunState();
run = runState.update({ ...run, status: "running" });
return runState.result(run);
```

The helper registers the standard `tychonic.workflow_state` query and returns
the same run-result shape the workflow returns at completion.

If a workflow uses the standard interactive CLI commands, create an interaction
helper:

```js
import { createTychonicInteraction } from "tychonic/workflow";

const interaction = createTychonicInteraction(input.profile?.policies?.interaction);
const decision = await interaction.waitForStateApproval("qa");
```

The helper registers the standard signal/query names as one unit and exposes
the workflow-side gate, modify patch application, stray-signal drain, and
standard inbox item helpers. It also validates the standard raw signal payloads
inside the workflow. Do not hand-register the standard interaction names one by
one.

## References

- [SPEC.md](../SPEC.md): authoritative product contract
- [skills/tychonic-cli/workflow-module-contract.md](../skills/tychonic-cli/workflow-module-contract.md): compact authoring contract
- [examples/workflows/verifyOnlyWorkflow](../examples/workflows/verifyOnlyWorkflow): minimal no-agent verify example
- [examples/workflows/pipelineWorkflow](../examples/workflows/pipelineWorkflow): multi-stage example
- [examples/workflows/architectBuilderQaWorkflow](../examples/workflows/architectBuilderQaWorkflow): default architect/builder/QA example
- [examples/workflows/architectBuilderKiroQaWorkflow](../examples/workflows/architectBuilderKiroQaWorkflow): Kiro review with normalizer
- [examples/workflows/architectBuilderKiroRepairQaWorkflow](../examples/workflows/architectBuilderKiroRepairQaWorkflow): Kiro pre-review and repair before final QA
