# Plugin Workflow Authoring

A Tychonic workflow bundle is a directory that contains `workflow.mjs`.
`workflow.mjs` exports:

- one named workflow function
- `defaultProfile`, a `tychonic.config.v1` object for that workflow

The bundle directory name must match the exported workflow function name. The
host package ships no first-party workflows; operators install bundles with
`tychonic workflows install`.

## Minimal Bundle

```sh
mkdir myWorkflow
(cd myWorkflow && npm init -y && npm install @temporalio/workflow)
```

```js
// myWorkflow/workflow.mjs
import { proxyActivities } from "@temporalio/workflow";

const {
  startRunActivity,
  createWorktreeActivity,
  runWorkerActivity,
  runVerifyActivity,
  runReviewActivity,
  finalizeRunActivity
} = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
});

export const defaultProfile = {
  version: "tychonic.config.v1",
  states: {
    work: { type: "work", agent: "codex" },
    verify: { type: "verify", command: "npm test" },
    review: { type: "review", agent: "claude" }
  }
};

export async function myWorkflow(input) {
  let run = await startRunActivity({
    template: "my_workflow",
    cwd: input.cwd,
    profile: input.profile,
    goal: input.goal
  });

  const wt = await createWorktreeActivity({ run, cwd: input.cwd });
  const work = await runWorkerActivity({
    stateName: "work",
    run,
    cwd: input.cwd,
    profile: input.profile,
    worktreePath: wt.worktreePath,
    prompt: input.goal ?? ""
  });
  run = apply(run, work);

  const verify = await runVerifyActivity({
    stateName: "verify",
    run,
    cwd: input.cwd,
    profile: input.profile,
    worktreePath: wt.worktreePath
  });
  run = apply(run, verify);

  const review = await runReviewActivity({
    stateName: "review",
    run,
    cwd: input.cwd,
    profile: input.profile,
    worktreePath: wt.worktreePath,
    prompt: "Review the worker result and return the structured review payload."
  });
  run = apply(run, review);

  const final = await finalizeRunActivity({ run });
  run = apply(run, final);
  return { runId: run.id, status: run.status, run };
}

function apply(run, result) {
  const delta = result.delta ?? {};
  let next = {
    ...run,
    states: delta.states ? [...run.states, ...delta.states] : [...run.states],
    activity_attempts: delta.activityAttempts
      ? [...run.activity_attempts, ...delta.activityAttempts]
      : [...run.activity_attempts],
    facts: delta.facts ? { ...(run.facts ?? {}), ...delta.facts } : run.facts,
    status: delta.status ?? run.status,
    agent_sessions: [...run.agent_sessions],
    artifacts: [...run.artifacts],
    findings: [...run.findings],
    inbox: [...run.inbox]
  };
  if (delta.summary !== undefined) next.summary = delta.summary;
  else if (run.summary !== undefined) next.summary = run.summary;
  if (result.commandOutcome) {
    next = { ...next, artifacts: [...next.artifacts, result.commandOutcome.artifact] };
  }
  if (result.reviewOutcome?.artifacts) {
    next = {
      ...next,
      artifacts: [...next.artifacts, ...result.reviewOutcome.artifacts],
      agent_sessions: [...next.agent_sessions, ...result.reviewOutcome.agentSessions]
    };
  }
  if (result.workerOutcome?.kind === "executed") {
    next = {
      ...next,
      artifacts: [...next.artifacts, ...result.workerOutcome.artifacts],
      agent_sessions: [...next.agent_sessions, ...result.workerOutcome.agentSessions]
    };
  }
  return next;
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
| `runLintActivity` | `lint` | `stateName`, `run`, `profile`, `cwd` |
| `runUnitTestActivity` | `unit_test` | `stateName`, `run`, `profile`, `cwd` |
| `runIntegrationActivity` | `integration` | `stateName`, `run`, `profile`, `cwd` |
| `runVerifyActivity` | `verify` | `stateName`, `run`, `profile`, `cwd`, `worktreePath` |
| `runWorkerActivity` | `work` | `stateName`, `run`, `profile`, `cwd`, `worktreePath`, `prompt?`, `sessionId?` |
| `runReviewActivity` | `review` | `stateName`, `run`, `profile`, `cwd`, `worktreePath`, `prompt` |
| `finalizeRunActivity` | n/a | `run`, `summary?` |

Activity call inputs carry runtime data only: prompt text, worktree path,
session id, run record, and similar values. They must not choose which command
or agent runs. Execution selection belongs to `profile.states.<name>.agent` or
`profile.states.<name>.command`.

Every activity returns records through `ActivityResult.delta` and optional
TYPE-specific outcome payloads. The activity does not mutate `input.run`; the
workflow must merge the returned records into its local run copy before the
next step.

## Workflow Sandbox

Temporal workflow code runs in a deterministic sandbox.

- Do not use Node I/O APIs such as `node:fs`, `node:child_process`, or
  `node:net` inside `workflow.mjs`.
- Do not make workflow decisions from non-deterministic top-level values.
- Put file, shell, and network work inside activities.
- Use only `@temporalio/workflow`, copied relative helper modules, or real
  package dependencies installed in the bundle.

Tychonic installs the bundle directory as-is. It does not run `npm install`,
copy host `node_modules`, create symlinks, or rewrite resolver paths.

## Policies And Signals

`policies.*` is workflow-owned data. The host schema validates only the outer
profile shape; each workflow validates the policy keys it consumes.

Signal names, query names, payloads, and recovery behavior are also part of the
workflow bundle contract. Document them in that bundle's README.

If a workflow uses the standard interactive CLI commands, register these names
directly in the workflow:

- `tychonic.interaction.approve_state`
- `tychonic.interaction.reject_state`
- `tychonic.interaction.modify_state`
- `tychonic.interaction.pending_state` query

## References

- [SPEC.md](../SPEC.md): authoritative product contract
- [skills/tychonic-cli/workflow-module-contract.md](../skills/tychonic-cli/workflow-module-contract.md): compact authoring contract
- [examples/workflows/pipelineWorkflow](../examples/workflows/pipelineWorkflow): multi-stage example
- [examples/workflows/architectBuilderQaWorkflow](../examples/workflows/architectBuilderQaWorkflow): interactive example
