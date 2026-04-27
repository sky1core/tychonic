# Authoring a plugin workflow

A plugin workflow is a compiled ESM file that composes Tychonic's
registered activities into a custom pipeline. Workflow modules
compose Tychonic's activity primitives; a plugin workflow does
whatever your pipeline needs with the same set.

You do **not** modify Tychonic source to add a new workflow shape.

This guide covers:

1. [Quick start](#quick-start)
2. [Available activities](#available-activities)
3. [ActivityInput and ActivityResult shape](#activityinput-and-activityresult-shape)
4. [Merging activity results into the run](#merging-activity-results-into-the-run)
5. [Sandbox constraints](#sandbox-constraints)
6. [Starting a plugin workflow](#starting-a-plugin-workflow)
7. [Complete example — 7-stage pipeline](#complete-example--7-stage-pipeline)

---

## Quick start

Write a file like `my-pipeline.mjs`:

```js
import { proxyActivities } from "@temporalio/workflow";

const { runWorkerActivity, runLintActivity, runReviewActivity,
        startRunActivity, finalizeRunActivity } = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
});

export async function myPipelineWorkflow(input) {
  let run = await startRunActivity({
    template: "my_pipeline",
    cwd: input.cwd
  });

  const workRes = await runWorkerActivity({
    stateName: "work",
    run,
    cwd: input.cwd,
    profile: input.profile,
    worktreePath: input.worktreePath,
    prompt: input.prompt ?? input.goal ?? ""
  });
  run = mergeRun(run, workRes);

  // ... more activities ...

  const fin = await finalizeRunActivity({ run });
  run = mergeRun(run, fin);
  return { runId: run.id, status: run.status, run };
}

function mergeRun(run, result) { /* see §Merging activity results */ }
```

Install and load:

```sh
(cd ./my-pipeline && npm install)
tychonic workflows install ./my-pipeline
```

A bundle is a directory containing `workflow.mjs`. It may also be a
standard package directory with `package.json`, lockfiles, local helper
modules, and `node_modules`. Tychonic copies the directory tree into
`~/Library/Application Support/Tychonic/workflows/modules/<name>/`,
validates the bundle, and refreshes the operational LaunchAgent worker
when that worker is installed. Under an isolated `--instance`, install
updates only that instance's module registry; restart the isolated runtime
to load newly installed bundles. Dependency resolution is standard package
resolution from the installed bundle location: if `workflow.mjs` imports a
package, that package must be installed in the bundle package or pre-bundled
into the workflow file. Tychonic does not add its own `node_modules`, create
symlinks, or run a package manager during install.

Because Temporal's workflow bundler also resolves `@temporalio/workflow`
from the workflow entrypoint package, ordinary bundles should declare
`@temporalio/workflow` in their own `package.json` and run `npm install`
before `tychonic workflows install`.

See [Starting a plugin workflow](#starting-a-plugin-workflow) for
how to kick a run.

---

## Available activities

All activities live in `src/activities/` and are registered on the
Temporal worker. `proxyActivities` returns proxies; call them as
regular async functions in workflow code.

### Run lifecycle

| Activity | Purpose |
| --- | --- |
| `startRunActivity({ template, cwd, profile?, goal?, runId? })` | Create the initial `WorkflowRunRecord`. Returns the full record. Call once at the start. |
| `collectGitFactsActivity({ run, cwd })` | Run `git diff` and attach a `RunFacts` patch via the returned delta. No state is created. |
| `createWorktreeActivity({ run, cwd })` | Create an isolated worktree for the workflow's worker steps. Returns `{ worktreePath, mode, reason }`. |
| `finalizeRunActivity({ run, summary? })` | Compute terminal `run.status` from state/inbox state. Returns a delta with `status` (and optional `summary`). |

### Deterministic commands

Each takes `ActivityInput<T>` and returns `ActivityResult` with
`commandOutcome: { artifact: ArtifactRecord }`.

| Activity | TYPE |
| --- | --- |
| `runLintActivity` | `lint` |
| `runUnitTestActivity` | `unit_test` |
| `runIntegrationActivity` | `integration` |
| `runVerifyActivity` | `verify` (accepts `worktreePath`) |

### Structured review

| Activity | TYPE | Notes |
| --- | --- | --- |
| `runReviewActivity` | `review` | Call any number of times with distinct NAMEs for multiple review instances. Returns `ActivityResult` with `reviewOutcome` (`skipped \| command_failed \| unparseable \| parsed`). |

### Worker execution

| Activity | TYPE | Notes |
| --- | --- | --- |
| `runWorkerActivity` | `work` | Runs one worker invocation. `worktreePath` is required. When the workflow passes `sessionId`, the worker resumes that prior session instead of starting fresh. Returns `workerOutcome` with `agentSessions` and `artifacts`. |
| `runAutoContinueActivity` | `auto_continue` | Dispatcher: resume mode when `sessionId` is present, fresh mode otherwise. |

---

## ActivityInput and ActivityResult shape

All NAME-keyed activities (lint, unit_test, integration, verify,
review, work, auto_continue) share
`ActivityInput<TYPE>`:

```ts
type ActivityInput<T> = {
  stateName: string;       // state NAME (user-chosen; appears in run.states and artifact kinds)
  run: WorkflowRunRecord;  // the current run — never mutated
  profile: TychonicConfig;  // effective profile snapshot
  cwd: string;             // project root
} & ActivityCallFieldsByType[T]; // runtime fields: prompt, worktreePath, sessionId, ...
```

Every activity call returns:

```ts
interface ActivityResult {
  delta: WorkflowRunDelta;                       // new states, attempts, facts patch, etc.
  commandOutcome?: { artifact: ArtifactRecord }; // deterministic commands
  reviewOutcome?: ReviewActivityOutcome;         // review TYPE
  workerOutcome?: WorkerActivityOutcome;         // work / auto_continue
}
```

The activity body **never mutates `input.run`**
(SPEC §Activity Result And Evidence Invariants). It writes files directly and
returns records through the outcome payloads. The workflow is
responsible for applying delta + outcome to its local run copy.

State NAME appears in three places, all equal:
- `ActivityInput.stateName` the workflow passes in
- `state.name` on the produced `WorkflowStateRecord`
- `<NAME>_<role>` prefix on the produced `ArtifactRecord.kind`

Two review states with NAMEs `review_1` and `review_2` are TWO
instances of the same TYPE calling the same activity function with
different NAMEs. SPEC §State Identity And Activity TYPE.

---

## Merging activity results into the run

The workflow owns a local `WorkflowRunRecord`. After each activity
call, merge the result into it. Keep merge helper logic inside the
bundle, pre-bundle it into `workflow.mjs`, or publish it as a real
dependency of that bundle package. Do not rely on Tychonic source-tree
imports being available at runtime:

```js
run = applyActivityResult(run, result);
```

`applyActivityResult`:

- merges `result.delta` via `applyRunDelta`
- appends `commandOutcome.artifact` to `run.artifacts`
- appends `reviewOutcome.artifacts` and `reviewOutcome.agentSessions`
  for `parsed` / `unparseable` kinds
- appends `workerOutcome.artifacts` and `workerOutcome.agentSessions`
  for `executed` kind

It never mutates the input `run`. Use the returned record for the
next step.

Skip conditions the workflow decides itself (autonomy, facts,
missing config block): build a skipped state inline.

```js
function skippedState(id, name, reason, now) {
  return {
    id, name,
    status: "skipped",
    reason,
    activity_attempt_ids: [],
    artifact_ids: [],
    finding_ids: [],
    started_at: now,
    finished_at: now
  };
}

run = { ...run, states: [...run.states, skippedState("state_1", "lint", "autonomy observe", new Date().toISOString())] };
```

---

## Sandbox constraints

Temporal workflow code runs in a deterministic V8 sandbox. Your
plugin file is bundled into the workflow bundle; webpack pulls in
transitive imports that resolve through the bundle's own standard
package layout.

- No `node:fs`, `node:child_process`, `node:net`, ... — plugin
  code runs in the workflow sandbox. File and network I/O belongs
  to activities.
- No top-level `Math.random()`, `Date.now()` outside Temporal's
  replay-safe wrappers. Within a workflow, `new Date()` is OK
  because Temporal replaces it at replay.
- Only import pure modules. Anything that pulls in `runCommand` →
  `child_process` (or any other Node I/O API) belongs in an
  activity module, not in the workflow file.

Safe imports include:

- `@temporalio/workflow`
- package dependencies installed in this bundle directory
- relative helper modules that are copied with this bundle
- Your own pure helpers in the plugin file

If in doubt, the worker will refuse to start the bundle and print
the failing import in
`~/Library/Logs/Tychonic/worker.err.log`.

---

## Starting a plugin workflow

`tychonic run <workflow-name>` starts workflow exports by their exact
exported function name. The name is the bundle directory name, which
is also the exported function name in `workflow.mjs`. Example bundles
under `examples/workflows/` (such as `simpleWorkflow`,
`selfRepairWorkflow`, `checkpointWorkflow`) are user-installable
references — they are not built-in workflows. Pass the workflow input
explicitly with `--input` or `--input-file`.

```sh
tychonic run myPipelineWorkflow --input-file ./input.json
# After installing the example bundle examples/workflows/selfRepairWorkflow/:
tychonic run selfRepairWorkflow --input-file ./self-repair-input.json
```

For full control over plugin-specific input, you can also start the workflow
through the Temporal CLI or a small client script.

### Via `temporal workflow start`

```sh
temporal workflow start \
  --task-queue tychonic \
  --workflow-id my_pipeline_$(date +%s) \
  --type myPipelineWorkflow \
  --input "$(cat input.json)"
```

The workflow type string must match the exported function name.

### Via `@temporalio/client` in Node

```js
// kick.mjs, run from the tychonic project root so @temporalio/client resolves
import { Client, Connection } from "@temporalio/client";

const conn = await Connection.connect({ address: "127.0.0.1:7233" });
const client = new Client({ connection: conn, namespace: "default" });
const handle = await client.workflow.start("myPipelineWorkflow", {
  taskQueue: "tychonic",
  workflowId: `my_pipeline_${Date.now()}`,
  args: [{ cwd: "/tmp/target-project", profile, /* ... */ }]
});
console.log(await handle.result());
await conn.close();
```

---

## Policies are bundle-defined

The host config schema treats `policies` as an opaque object keyed by
string. The host accepts any `policies.<key>` block without inspecting
its inner shape; the workflow bundle that consumes a policy is
responsible for validating its own keys at workflow start. Use a small
inline validator in your `workflow.mjs` (a hand-rolled object check or
an inline zod schema) so a typo or wrong type surfaces as a clear
error before the workflow does any real work. The example bundles
under `examples/workflows/` demonstrate the pattern.

Signal payload shape is also a public contract. Once a bundle author
publishes a signal name, the string and the documented payload become
part of the user-facing surface and operators (and other agents) drive
the workflow through them via `tychonic signal`.

## Interactive gating in plugin workflows

This section describes the interaction convention used by the reference
bundles. The host config schema treats `policies.*` as bundle-defined data:
`policies.interaction.mode: interactive` has meaning only for a workflow that
chooses to validate that policy and register matching signal handlers.

Tychonic's CLI can send the following public signal/query names. Plugins that
want to be driven by `tychonic approve`, `tychonic reject`, and
`tychonic modify` register those names directly with `@temporalio/workflow`
rather than importing an internal Tychonic helper. This keeps the plugin
self-contained and independent of Tychonic's internal module layout:

- `tychonic.interaction.approve_state`
- `tychonic.interaction.reject_state`
- `tychonic.interaction.modify_state`
- `tychonic.interaction.pending_state` (query, returns the state name
  the workflow is currently gated on — the CLI queries this so the
  operator doesn't have to pass `--state` explicitly)

```js
import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler
} from "@temporalio/workflow";

const APPROVE = "tychonic.interaction.approve_state";
const REJECT = "tychonic.interaction.reject_state";
const MODIFY = "tychonic.interaction.modify_state";
const PENDING = "tychonic.interaction.pending_state";

export async function myPlugin(input) {
  const queue = [];
  let pending;
  const interactive = input.profile?.policies?.interaction?.mode === "interactive";

  if (interactive) {
    const approve = defineSignal(APPROVE);
    const reject = defineSignal(REJECT);
    const modify = defineSignal(MODIFY);
    setHandler(approve, (p) => queue.push({ kind: "approve", payload: p }));
    setHandler(reject,  (p) => queue.push({ kind: "reject",  payload: p }));
    setHandler(modify,  (p) => queue.push({ kind: "modify",  payload: p }));
    setHandler(defineQuery(PENDING), () => pending);
  }

  async function gate(stateName) {
    if (!interactive) return { kind: "approve" };
    pending = stateName;
    try {
      const find = () => queue.findIndex((e) => e.payload?.state === stateName);
      if (find() < 0) await condition(() => find() >= 0);
      const [entry] = queue.splice(find(), 1);
      return entry.kind === "approve"
        ? { kind: "approve" }
        : entry.kind === "reject"
        ? { kind: "reject", feedback: entry.payload.feedback }
        : { kind: "modify", patch: entry.payload.patch };
    } finally { pending = undefined; }
  }

  let run = await startRunActivity({ template: "my_plugin", cwd: input.cwd, profile: input.profile });
  const wt = await createWorktreeActivity({ run, cwd: input.cwd });
  const res = await runWorkerActivity({
    stateName: "work", run, profile: input.profile, cwd: input.cwd,
    worktreePath: wt.worktreePath,
    prompt: input.goal ?? ""
  });
  run = applyActivityResult(run, res);

  const decision = await gate("work");
  // approve: advance. reject: rerun this state; reject feedback
  // ACCUMULATES across iterations — keep all prior feedback entries and
  // thread them into the next prompt (the reference plugin formats them
  // as a numbered list). Bump a per-state counter; at the configured
  // `max_reject_iterations` cap, promote to waiting_user.
  // modify: overlay decision.patch on the latest run.states entry for
  // "work" and advance. The patch is optional-fields-only
  // (status, reason, note, artifacts[], findings[]); the state record's
  // id and activity_attempt_ids are preserved.
}
```

See `examples/workflows/architectBuilderQaWorkflow/workflow.mjs` for a
full three-stage worked example that wires reject counters, stray
signal drain, and review-stage gating.

Operator recovery: the three CLI commands surface each decision class.

- `tychonic approve <workflow-id> [--state <name>]`
- `tychonic reject <workflow-id> [--state <name>] --feedback <text>`
- `tychonic modify <workflow-id> [--state <name>]
  [--status succeeded|failed|skipped|blocked|timed_out]
  [--reason <text>] [--note <text>] [--patch-file <path.json>]`

  `--note` appends to the existing `reason` as `"<reason> — note:
  <note>"` and is the simplest override from an external agent.
  `--patch-file` lets the caller supply `artifacts` / `findings`; the
  scalar flags (`--status`, `--reason`, `--note`) override matching
  fields in the file when both are present.

When `--state` is omitted, the CLI queries
`tychonic.interaction.pending_state`. A plugin that does not register that
query cannot be auto-targeted; the CLI fails with a clear error directing the
operator to pass `--state` explicitly. A `policies.interaction` block alone
does not affect a workflow unless that workflow reads and implements it.

---

## Complete example — 7-stage pipeline

A pipeline that runs:

```
work(claude) → static(lint) → unit(unit_test) → review_1(review) →
integration → review_2(review) → security(verify)
```

Two states (`review_1`, `review_2`) are instances of the same TYPE
`review` calling the same `runReviewActivity` function with
different NAMEs. Worker runs once (stage 1). If any stage fails
the workflow short-circuits to finalize.

### Plugin file

```js
// pipeline-7stage.mjs
import { proxyActivities } from "@temporalio/workflow";

const act = proxyActivities({
  startToCloseTimeout: "24 hours",
  heartbeatTimeout: "5 minutes",
  retry: { maximumAttempts: 1 }
});

const {
  startRunActivity, createWorktreeActivity, collectGitFactsActivity,
  runWorkerActivity, runLintActivity, runUnitTestActivity,
  runReviewActivity, runIntegrationActivity, runVerifyActivity,
  finalizeRunActivity
} = act;

export async function pipelineWorkflow(input) {
  let run = await startRunActivity({
    template: "pipeline_7stage",
    cwd: input.cwd,
    profile: input.profile,
    goal: input.goal
  });

  const wt = await createWorktreeActivity({ run, cwd: input.cwd });
  const worktreePath = wt.worktreePath;

  run = apply(run, await collectGitFactsActivity({ run, cwd: input.cwd }));

  // stage 1: work
  const work = await runWorkerActivity({
    stateName: "work", run, cwd: input.cwd, profile: input.profile,
    worktreePath,
    prompt: input.prompt ?? input.goal ?? ""
  });
  run = apply(run, work);
  if (work.workerOutcome?.status !== "succeeded") return done(run, input.cwd, "stage 1 work failed");

  // stages 2-3: deterministic
  for (const [stateName, activity] of [["static", runLintActivity], ["unit", runUnitTestActivity]]) {
    const res = await activity({ stateName, run, cwd: input.cwd, profile: input.profile, worktreePath });
    run = apply(run, res);
    if (res.delta.states?.[0]?.status !== "succeeded") return done(run, input.cwd, `stage ${stateName} failed`);
  }

  // stage 4: review_1
  const review1 = await runReviewActivity({
    stateName: "review_1", run, cwd: input.cwd, profile: input.profile,
    worktreePath,
    prompt: input.reviewPrompt ?? structuredReviewPrompt("work stages 1-3")
  });
  run = apply(run, review1);
  const review1Decision = gateReviewStage(run, review1, "review_1");
  run = review1Decision.run;
  if (review1Decision.done) return done(run, input.cwd, review1Decision.summary);

  // stage 5: integration
  run = apply(run, await runIntegrationActivity({
    stateName: "integration", run, cwd: input.cwd, profile: input.profile, worktreePath
  }));

  // stage 6: review_2 (same TYPE, different NAME)
  const review2 = await runReviewActivity({
    stateName: "review_2", run, cwd: input.cwd, profile: input.profile,
    worktreePath,
    prompt: input.reviewPrompt2 ?? structuredReviewPrompt("integration and prior review follow-up")
  });
  run = apply(run, review2);
  const review2Decision = gateReviewStage(run, review2, "review_2");
  run = review2Decision.run;
  if (review2Decision.done) return done(run, input.cwd, review2Decision.summary);

  // stage 7: security (TYPE verify)
  run = apply(run, await runVerifyActivity({
    stateName: "security", run, cwd: input.cwd, profile: input.profile,
    worktreePath
  }));

  return done(run, input.cwd, `pipeline finished: ${run.states.map((s) => `${s.name}=${s.status}`).join(", ")}`);
}

function apply(run, result) {
  let next = applyDelta(run, result.delta || {});
  if (result.commandOutcome) next = { ...next, artifacts: [...next.artifacts, result.commandOutcome.artifact] };
  if (result.reviewOutcome && (result.reviewOutcome.kind === "parsed" || result.reviewOutcome.kind === "unparseable")) {
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

function applyDelta(run, delta) {
  const next = {
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
  return next;
}

async function done(run, cwd, summary) {
  const fin = await finalizeRunActivity({ run, summary });
  run = apply(run, fin);
  return { runId: run.id, status: run.status, run, artifactRoot: `${cwd}/.tychonic/runs/${run.id}`, summary: run.summary };
}

function gateReviewStage(run, result, stateName) {
  const state = result.delta?.states?.[0];
  if (!state) return { run, done: true, summary: `${stateName} produced no state` };
  if (state.status === "succeeded") return { run, done: false, summary: "" };
  if (result.reviewOutcome?.kind === "unparseable") {
    return {
      run: addReviewTriageInbox(run, state, result.reviewOutcome.detail),
      done: true,
      summary: `${stateName} requires triage`
    };
  }
  return { run, done: true, summary: `${stateName} ${state.status}` };
}

function addReviewTriageInbox(run, state, detail) {
  const inboxId = `inbox_review_${state.id}`;
  if (run.inbox.some((item) => item.id === inboxId)) return run;
  return {
    ...run,
    inbox: [
      ...run.inbox,
      {
        id: inboxId,
        status: "open",
        title: `${state.name} requires triage`,
        detail,
        action: { kind: "triage", reason: detail },
        created_at: state.finished_at ?? state.started_at ?? new Date().toISOString()
      }
    ]
  };
}

function structuredReviewPrompt(scope) {
  return [
    `Review ${scope} for correctness, regressions, missing tests, and risky assumptions.`,
    "",
    "Return only one JSON object matching this contract. Do not wrap it in markdown.",
    "{",
    '  "schema_version": "tychonic.review.v1",',
    '  "status": "pass|fail",',
    '  "summary": "short result summary",',
    '  "findings": [',
    '    {"severity": "critical|high|medium|low", "title": "finding title", "detail": "actionable explanation", "target": "file, state, or session", "target_session_id": ""}',
    "  ]",
    "}",
    "Use status pass only when findings is empty. Use status fail when any actionable finding exists."
  ].join("\\n");
}
```

### Config file the pipeline expects

Every stage NAME must have a matching `states.<name>` block with the
right TYPE. The working example ships as a bundle at
[`examples/workflows/pipelineWorkflow/`](../examples/workflows/pipelineWorkflow),
with two review NAMEs of the same TYPE. See
[`examples/workflows/pipelineWorkflow/workflow.mjs`](../examples/workflows/pipelineWorkflow/workflow.mjs)
(the `defaultProfile` export) for the current reference content.

### Install and run

```sh
(cd examples/workflows/pipelineWorkflow && npm install)
tychonic workflows install ./examples/workflows/pipelineWorkflow

# kick it via the client script above, passing { cwd, profile, ... }
node kick.mjs
```

The resulting run record has seven state entries under their
declared NAMEs, artifact kinds prefixed with the NAME
(`review_1_prompt`, `review_1_output`, `review_1_parsed`, ...),
and the final `run.status` depends on how the stages resolved.

If a review activity ends `blocked` / `unparseable`, the workflow must open an
explicit inbox/triage path before calling `finalizeRunActivity`. Otherwise the
run can look `succeeded` merely because no state failed.

---

## Where to look next

- `SPEC.md` §Plugin Composition Path — contract
- `SPEC.md` §Activity Invariants — what each activity guarantees
- `src/activities/` — the registered activity implementations
- `examples/workflows/checkpointWorkflow/workflow.mjs` — example
  bundle that composes the activity primitives end-to-end
- `src/workflows/runMerge.ts` — reusable pure helper
