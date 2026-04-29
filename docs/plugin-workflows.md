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
    if (result.reviewOutcome.kind === "parsed" && result.reviewOutcome.result.status === "fail") {
      // Workflow code owns how review findings become run-level records and
      // state finding_ids; the review activity only returns the parsed verdict.
      next = appendReviewFindings(next, result);
    }
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

function appendReviewFindings(run, result) {
  const outcome = result.reviewOutcome;
  const sourceState = result.delta?.states?.[0];
  if (!sourceState || outcome?.kind !== "parsed" || outcome.result.status !== "fail") return run;

  let next = run;
  const findingIds = [];
  for (const finding of outcome.result.findings) {
    const id = nextLocalId(next, "finding");
    findingIds.push(id);
    next = {
      ...next,
      findings: [
        ...next.findings,
        {
          id,
          status: "new",
          severity: finding.severity,
          title: finding.title,
          detail: finding.detail,
          ...(finding.target ? { target: finding.target } : {}),
          source_state_id: sourceState.id,
          ...(outcome.reviewerSessionId ? { source_review_session_id: outcome.reviewerSessionId } : {}),
          ...(finding.target_session_id ? { target_work_session_id: finding.target_session_id } : {}),
          created_at: new Date().toISOString()
        }
      ]
    };
  }

  return {
    ...next,
    states: next.states.map((state) =>
      state.id === sourceState.id
        ? { ...state, finding_ids: [...state.finding_ids, ...findingIds] }
        : state
    )
  };
}

function nextLocalId(run, prefix) {
  const counter =
    run.states.length +
    run.activity_attempts.length +
    run.artifacts.length +
    run.findings.length +
    run.inbox.length +
    run.agent_sessions.length;
  return `${prefix}_${counter + 1}`;
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
code or silently repair findings. Kiro review states that need non-interactive
tool use may set `trust_all_tools: true`; the adapter still rejects direct file
writes and fails the review if tracked files change during the turn. If a
workflow wants automated repair after QA, call an explicit work state with its
own NAME and config.

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
- Use only `@temporalio/workflow`, copied relative support modules, or real
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
- [examples/workflows/verifyOnlyWorkflow](../examples/workflows/verifyOnlyWorkflow): minimal no-agent verify example
- [examples/workflows/pipelineWorkflow](../examples/workflows/pipelineWorkflow): multi-stage example
- [examples/workflows/architectBuilderQaWorkflow](../examples/workflows/architectBuilderQaWorkflow): default architect/builder/QA example
- [examples/workflows/architectBuilderKiroQaWorkflow](../examples/workflows/architectBuilderKiroQaWorkflow): Kiro review with normalizer
- [examples/workflows/architectBuilderKiroRepairQaWorkflow](../examples/workflows/architectBuilderKiroRepairQaWorkflow): Kiro pre-review and repair before final QA
