import { describe, expect, it } from "vitest";

// Bundle integration tests for the simpleWorkflow cap loop. The helpers
// under test live in `examples/workflows/simpleWorkflow/workflow.mjs` and
// are exported as test-only named exports. Tests inject mock activity
// dispatchers so the loop can be driven end-to-end without a real Temporal
// worker. The assertions exercise the resume-cap state-machine transitions
// (counter, inbox writes) against the canonical contract documented in the
// bundle README.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bundle modules export plain JS, no TS types.
import {
  appendReviewFindingsAndInboxForTests,
  runAutoContinueLoop
} from "../examples/workflows/simpleWorkflow/workflow.mjs";

interface MockSession {
  id: string;
  agent: string;
  role: "worker" | "reviewer";
  cwd: string;
  status: "running" | "succeeded" | "failed" | "timed_out" | "unknown";
  resumable?: boolean;
  started_at: string;
  finished_at?: string;
}

interface MockActivities {
  runWorker: ReturnType<typeof makeStub>;
  runVerify: ReturnType<typeof makeStub>;
  runReview: ReturnType<typeof makeStub>;
}

interface CallLog {
  name: "resume" | "worker" | "verify" | "review";
  // Captured prompt or sessionId for assertions.
  prompt?: string;
  sessionId?: string;
}

function makeStub(_fn: (input: unknown) => unknown) {
  return _fn;
}

function nowIso(): string {
  return "2026-04-26T00:00:00.000Z";
}

function makeWorkerSession(id: string, resumable = true): MockSession {
  return {
    id,
    agent: "claude",
    role: "worker",
    cwd: "/tmp/tychonic-test",
    status: "succeeded",
    ...(resumable ? { resumable: true } : {}),
    started_at: nowIso()
  };
}

function makeReviewerSession(id: string): MockSession {
  return {
    id,
    agent: "claude",
    role: "reviewer",
    cwd: "/tmp/tychonic-test",
    status: "succeeded",
    started_at: nowIso()
  };
}

function makeBaseRun(workerSession: MockSession): any {
  // Build an initial run record matching the shape the workflow produces
  // after the first work -> verify -> review iteration when the review
  // returned `fail`. The cap loop expects an open `resume_work` inbox item
  // targeting `workerSession`.
  const stateWork = {
    id: "state_work_1",
    name: "work",
    status: "succeeded",
    reason: "run work",
    activity_attempt_ids: ["attempt_work_1"],
    artifact_ids: [],
    finding_ids: [],
    started_at: nowIso(),
    finished_at: nowIso()
  };
  const stateReview = {
    id: "state_review_1",
    name: "review",
    status: "failed",
    reason: "needs fix",
    activity_attempt_ids: ["attempt_review_1"],
    artifact_ids: [],
    finding_ids: ["finding_1"],
    started_at: nowIso(),
    finished_at: nowIso()
  };
  const finding = {
    id: "finding_1",
    status: "new",
    severity: "high",
    title: "broken thing",
    detail: "fix the broken thing",
    target: "src/a.ts",
    source_state_id: "state_review_1",
    target_work_session_id: workerSession.id,
    created_at: nowIso()
  };
  const inbox = {
    id: "inbox_1",
    status: "open",
    title: `Resume work: ${finding.title}`,
    detail: `resume prior worker session ${workerSession.id}`,
    finding_id: finding.id,
    target_session_id: workerSession.id,
    action: {
      kind: "resume_work",
      prompt_artifact_id: ""
    },
    created_at: nowIso()
  };
  return {
    schema_version: "tychonic.run.v1",
    id: "run_1",
    template: "simple_workflow",
    status: "running",
    cwd: "/tmp/tychonic-test",
    created_at: nowIso(),
    updated_at: nowIso(),
    states: [stateWork, stateReview],
    activity_attempts: [
      {
        id: "attempt_work_1",
        state_id: "state_work_1",
        kind: "work",
        status: "succeeded",
        reason: "run work",
        cwd: "/tmp/tychonic-test",
        agent_session_id: workerSession.id,
        started_at: nowIso(),
        finished_at: nowIso()
      },
      {
        id: "attempt_review_1",
        state_id: "state_review_1",
        kind: "semantic_review",
        status: "succeeded",
        reason: "run review",
        cwd: "/tmp/tychonic-test",
        started_at: nowIso(),
        finished_at: nowIso()
      }
    ],
    agent_sessions: [workerSession],
    artifacts: [],
    findings: [finding],
    inbox: [inbox]
  };
}

/**
 * Build a `runWorker` activity stub. With an explicit `sessionId`, this is
 * the resume path and returns the `resume_work` attempt shape the production
 * worker activity body emits. Without `sessionId`, it records a fresh-worker
 * call and fails because the cap loop must not start a new worker session.
 */
function makeWorkerStub(log: CallLog[]) {
  let attemptCounter = 0;
  return (callInput: any) => {
    if (!callInput.sessionId) {
      log.push({ name: "worker", prompt: callInput.prompt });
      throw new Error("runWorker fresh mode must not be called by the cap loop");
    }
    attemptCounter += 1;
    const stateId = `state_resume_${attemptCounter}`;
    const attemptId = `attempt_resume_${attemptCounter}`;
    log.push({ name: "resume", sessionId: callInput.sessionId, prompt: callInput.prompt });
    return {
      delta: {
        states: [
          {
            id: stateId,
            name: "work",
            status: "succeeded",
            reason: `resume session ${callInput.sessionId}`,
            activity_attempt_ids: [attemptId],
            artifact_ids: [],
            finding_ids: [],
            started_at: nowIso(),
            finished_at: nowIso()
          }
        ],
        activityAttempts: [
          {
            id: attemptId,
            state_id: stateId,
            kind: "resume_work",
            status: "succeeded",
            reason: "resume",
            cwd: "/tmp/tychonic-test",
            agent_session_id: callInput.sessionId,
            started_at: nowIso(),
            finished_at: nowIso()
          }
        ]
      },
      workerOutcome: { kind: "executed", artifacts: [], agentSessions: [] }
    };
  };
}

/** Build a `runVerify` stub that always succeeds. */
function makeVerifyStub(log: CallLog[]) {
  let attemptCounter = 0;
  return (_callInput: any) => {
    attemptCounter += 1;
    log.push({ name: "verify" });
    const stateId = `state_verify_${attemptCounter}`;
    const attemptId = `attempt_verify_${attemptCounter}`;
    const artifact = {
      id: `artifact_verify_${attemptCounter}`,
      kind: "verify_output",
      path: `.tychonic/verify_${attemptCounter}.log`,
      created_at: nowIso(),
      state_id: stateId,
      activity_attempt_id: attemptId
    };
    return {
      delta: {
        states: [
          {
            id: stateId,
            name: "verify",
            status: "succeeded",
            reason: "verify ok",
            activity_attempt_ids: [attemptId],
            artifact_ids: [artifact.id],
            finding_ids: [],
            started_at: nowIso(),
            finished_at: nowIso()
          }
        ],
        activityAttempts: [
          {
            id: attemptId,
            state_id: stateId,
            kind: "deterministic_command",
            status: "succeeded",
            reason: "verify",
            cwd: "/tmp/tychonic-test",
            started_at: nowIso(),
            finished_at: nowIso()
          }
        ]
      },
      commandOutcome: { artifact }
    };
  };
}

/**
 * Build a `runReview` stub that always returns a `parsed` outcome with
 * `status: "fail"` and a single finding whose `target_session_id` equals
 * the most recently created worker session in the run. This drives the
 * cap loop to keep generating `resume_work` inbox items until the
 * resume cap fires.
 */
function makeFailReviewStub(log: CallLog[], findReviewerSession: () => MockSession) {
  let attemptCounter = 0;
  return (callInput: any) => {
    attemptCounter += 1;
    const stateId = `state_review_iter_${attemptCounter}`;
    const attemptId = `attempt_review_iter_${attemptCounter}`;
    const reviewerSession = findReviewerSession();
    log.push({ name: "review" });

    // Latest worker session in the run is the cap loop's `currentSession`.
    const lastWorker = [...callInput.run.agent_sessions]
      .reverse()
      .find((s: any) => s.role === "worker");

    return {
      delta: {
        states: [
          {
            id: stateId,
            name: "review",
            status: "failed",
            reason: "still failing",
            activity_attempt_ids: [attemptId],
            artifact_ids: [],
            finding_ids: [],
            started_at: nowIso(),
            finished_at: nowIso()
          }
        ],
        activityAttempts: [
          {
            id: attemptId,
            state_id: stateId,
            kind: "semantic_review",
            status: "succeeded",
            reason: "review",
            cwd: "/tmp/tychonic-test",
            agent_session_id: reviewerSession.id,
            started_at: nowIso(),
            finished_at: nowIso()
          }
        ]
      },
      reviewOutcome: {
        kind: "parsed",
        result: {
          schema_version: "tychonic.review.v1",
          status: "fail",
          summary: "still failing",
          findings: [
            {
              severity: "high",
              title: "broken thing",
              detail: "fix the broken thing",
              target: "src/a.ts",
              ...(lastWorker ? { target_session_id: lastWorker.id } : {})
            }
          ]
        },
        reviewerSessionId: reviewerSession.id,
        artifacts: [],
        agentSessions: [reviewerSession]
      }
    };
  };
}

function makeActivities(opts: {
  log: CallLog[];
  reviewerSessionFactory: () => MockSession;
}): MockActivities {
  return {
    runWorker: makeWorkerStub(opts.log),
    runVerify: makeVerifyStub(opts.log),
    runReview: makeFailReviewStub(opts.log, opts.reviewerSessionFactory)
  };
}

describe("simpleWorkflow cap loop", () => {
  it("resume cap fires after exactly N resume_work attempts → triage inbox → no fresh worker", async () => {
    const initialWorker = makeWorkerSession("session_w0");
    const run = makeBaseRun(initialWorker);
    const log: CallLog[] = [];
    const activities = makeActivities({
      log,
      reviewerSessionFactory: () => makeReviewerSession(`session_rev_${log.length}`)
    });

    const profile = {
      version: "tychonic.config.v1",
      states: {
        work: { type: "work", agent: "claude", resume: 3 },
        verify: { type: "verify", command: "npm run verify:worker" },
        review: { type: "review", agent: "claude" }
      },
      policies: {
        loop: {
          auto_continue: true,
          max_review_iterations: 10
        }
      }
    };

    const final = await runAutoContinueLoop({
      input: { profile, cwd: "/tmp/tychonic-test" },
      run,
      worktreePath: "/tmp/tychonic-test/wt",
      workSession: initialWorker,
      maxIterations: 10,
      activities
    });

    // Exactly N resume_work attempts (resume cap = 3).
    const resumeCalls = log.filter((c) => c.name === "resume");
    expect(resumeCalls.length).toBe(3);

    // The cap loop never calls runWorker in fresh mode — it only resumes the current session.
    const workerCalls = log.filter((c) => c.name === "worker");
    expect(workerCalls.length).toBe(0);

    // After 3 resumes the cap fires and an open triage inbox item lands.
    const triageItems = final.inbox.filter(
      (i: any) =>
        i.action?.kind === "triage" &&
        i.title === "Resume cap exhausted with unresolved findings"
    );
    expect(triageItems).toHaveLength(1);
    expect(triageItems[0].status).toBe("open");
    // Detail references only the resume cap.
    expect(triageItems[0].detail).toContain("states.work.resume (3)");

    // The original resume_work inbox is resolved by the first resume.
    const originalItem = final.inbox.find((i: any) => i.id === "inbox_1");
    expect(originalItem.status).toBe("resolved");

    // The triage item action carries the canonical reason string.
    expect(triageItems[0].action.reason).toBe(
      "auto-continue loop stopped after resume cap fired"
    );
  });

  it("resume=1 → exactly one resume call, then cap fires", async () => {
    const initialWorker = makeWorkerSession("session_w0");
    const run = makeBaseRun(initialWorker);
    const log: CallLog[] = [];
    const activities = makeActivities({
      log,
      reviewerSessionFactory: () => makeReviewerSession(`session_rev_${log.length}`)
    });

    const profile = {
      version: "tychonic.config.v1",
      states: {
        work: { type: "work", agent: "claude", resume: 1 },
        verify: { type: "verify", command: "npm run verify:worker" },
        review: { type: "review", agent: "claude" }
      },
      policies: { loop: { auto_continue: true, max_review_iterations: 10 } }
    };

    const final = await runAutoContinueLoop({
      input: { profile, cwd: "/tmp/tychonic-test" },
      run,
      worktreePath: "/tmp/tychonic-test/wt",
      workSession: initialWorker,
      maxIterations: 8,
      activities
    });

    expect(log.filter((c) => c.name === "resume").length).toBe(1);
    expect(log.filter((c) => c.name === "worker").length).toBe(0);

    const triage = final.inbox.find(
      (i: any) =>
        i.action?.kind === "triage" &&
        i.title === "Resume cap exhausted with unresolved findings"
    );
    expect(triage).toBeDefined();
    expect(triage.detail).toContain("states.work.resume (1)");
  });

  it("omitted states.work.resume defaults to zero resumes", async () => {
    const initialWorker = makeWorkerSession("session_w0");
    const run = makeBaseRun(initialWorker);
    const log: CallLog[] = [];
    const activities = makeActivities({
      log,
      reviewerSessionFactory: () => makeReviewerSession(`session_rev_${log.length}`)
    });

    const profile = {
      version: "tychonic.config.v1",
      states: {
        work: { type: "work", agent: "claude" },
        verify: { type: "verify", command: "npm run verify:worker" },
        review: { type: "review", agent: "claude" }
      },
      policies: { loop: { auto_continue: true, max_review_iterations: 10 } }
    };

    const final = await runAutoContinueLoop({
      input: { profile, cwd: "/tmp/tychonic-test" },
      run,
      worktreePath: "/tmp/tychonic-test/wt",
      workSession: initialWorker,
      maxIterations: 8,
      activities
    });

    expect(log.filter((c) => c.name === "resume").length).toBe(0);
    const triage = final.inbox.find(
      (i: any) =>
        i.action?.kind === "triage" &&
        i.title === "Resume cap exhausted with unresolved findings"
    );
    expect(triage).toBeDefined();
    expect(triage.detail).toContain("states.work.resume (0)");
  });

  it("effective profile snapshot at workflow start is the source of truth (mid-run profile mutation does not change the running cap value)", async () => {
    // The cap loop reads `states.work.resume` from `input.profile` (the
    // start-time snapshot). Once the loop is running, no path inside this
    // helper re-reads policies from anywhere else — so even if a caller
    // mutates a separate profile object after invoking the loop, the
    // running cap stays locked to what was passed in at start.
    const initialWorker = makeWorkerSession("session_w0");
    const run = makeBaseRun(initialWorker);
    const log: CallLog[] = [];
    const activities = makeActivities({
      log,
      reviewerSessionFactory: () => makeReviewerSession(`session_rev_${log.length}`)
    });

    const snapshot = {
      version: "tychonic.config.v1",
      states: {
        work: { type: "work", agent: "claude", resume: 1 },
        verify: { type: "verify", command: "npm run verify:worker" },
        review: { type: "review", agent: "claude" }
      },
      policies: { loop: { auto_continue: true, max_review_iterations: 10 } }
    };
    // A "mid-run reinstall" — separate profile object that a hypothetical
    // outside actor would point the running workflow at. The cap loop
    // never sees this object.
    const mutatedAfter = {
      ...snapshot,
      states: {
        ...snapshot.states,
        work: { ...snapshot.states.work, resume: 50 }
      }
    };

    const final = await runAutoContinueLoop({
      input: { profile: snapshot, cwd: "/tmp/tychonic-test" },
      run,
      worktreePath: "/tmp/tychonic-test/wt",
      workSession: initialWorker,
      maxIterations: 8,
      activities
    });

    // With snapshot resume=1 the loop fires exactly once and produces a
    // triage cap-exhausted inbox item. Under `mutatedAfter` (resume=50)
    // it would not.
    expect(log.filter((c) => c.name === "resume").length).toBe(1);
    const triage = final.inbox.filter(
      (i: any) =>
        i.action?.kind === "triage" &&
        i.title === "Resume cap exhausted with unresolved findings"
    );
    expect(triage).toHaveLength(1);

    // Sanity: `mutatedAfter` exists but was never wired to the loop.
    expect(mutatedAfter.states.work.resume).toBe(50);

    // Verify the snapshot itself was not mutated by the loop.
    expect(snapshot.states.work.resume).toBe(1);
  });

  it("extend signal applies cap discipline with a renewed counter — same shape on re-entry", async () => {
    // Counters always start at zero on entry to runAutoContinueLoop, so a
    // user-renewed iteration budget gets a clean cap window. The resume
    // cap fires on each entry independently. After triage is dismissed
    // and a fresh resume_work inbox item is added by the next review
    // iteration, re-entering produces another cap fire.
    const initialWorker = makeWorkerSession("session_w0");
    const run = makeBaseRun(initialWorker);
    const log: CallLog[] = [];
    const activities = makeActivities({
      log,
      reviewerSessionFactory: () => makeReviewerSession(`session_rev_${log.length}`)
    });

    const profile = {
      version: "tychonic.config.v1",
      states: {
        work: { type: "work", agent: "claude", resume: 1 },
        verify: { type: "verify", command: "npm run verify:worker" },
        review: { type: "review", agent: "claude" }
      },
      policies: { loop: { auto_continue: true, max_review_iterations: 10 } }
    };

    // First call — drive to cap exhaustion. Counter is 0 on entry.
    const afterFirst = await runAutoContinueLoop({
      input: { profile, cwd: "/tmp/tychonic-test" },
      run,
      worktreePath: "/tmp/tychonic-test/wt",
      workSession: initialWorker,
      maxIterations: 8,
      activities
    });
    const triageBefore = afterFirst.inbox.filter(
      (i: any) =>
        i.action?.kind === "triage" &&
        i.title === "Resume cap exhausted with unresolved findings"
    );
    expect(triageBefore).toHaveLength(1);

    // Now simulate the user dismissing triage and a follow-up review
    // iteration adding a new resume_work inbox item targeting the same
    // worker session. This mirrors what an operator + a fresh review
    // iteration would produce in production.
    let extended: any = afterFirst;
    extended = {
      ...extended,
      inbox: extended.inbox.map((i: any) =>
        i.title === "Resume cap exhausted with unresolved findings"
          ? { ...i, status: "dismissed" }
          : i
      )
    };
    const lastWorker = [...extended.agent_sessions]
      .reverse()
      .find((s: any) => s.role === "worker");
    expect(lastWorker).toBeDefined();
    extended = appendReviewFindingsAndInboxForTests(
      extended,
      {
        delta: {
          states: [
            {
              id: "state_review_extend_seed",
              name: "review",
              status: "failed",
              reason: "fresh fail after extend",
              activity_attempt_ids: [],
              artifact_ids: [],
              finding_ids: [],
              started_at: nowIso()
            }
          ]
        },
        reviewOutcome: {
          kind: "parsed",
          result: {
            schema_version: "tychonic.review.v1",
            status: "fail",
            summary: "still failing",
            findings: [
              {
                severity: "high",
                title: "still broken",
                detail: "fix it",
                target: "src/a.ts",
                target_session_id: lastWorker.id
              }
            ]
          },
          reviewerSessionId: "session_rev_extend_seed",
          artifacts: [],
          agentSessions: []
        }
      }
    );

    // Re-enter the loop with the same caps and the latest worker session.
    const afterExtend = await runAutoContinueLoop({
      input: { profile, cwd: "/tmp/tychonic-test" },
      run: extended,
      worktreePath: "/tmp/tychonic-test/wt",
      workSession: lastWorker,
      maxIterations: 8,
      activities
    });

    // Cap fires again inside the extend → a new triage item is open.
    const openTriages = afterExtend.inbox.filter(
      (i: any) =>
        i.action?.kind === "triage" &&
        i.title === "Resume cap exhausted with unresolved findings" &&
        i.status === "open"
    );
    expect(openTriages.length).toBeGreaterThanOrEqual(1);

    // Still no fresh-worker invocation across the extend.
    expect(log.filter((c) => c.name === "worker").length).toBe(0);
  });

  it("routes review findings without target_session_id to triage", () => {
    const run = makeBaseRun(makeWorkerSession("session_w0"));
    const next = appendReviewFindingsAndInboxForTests(run, {
      delta: {
        states: [
          {
            id: "state_review_no_target",
            name: "review",
            status: "failed",
            reason: "review failed",
            activity_attempt_ids: [],
            artifact_ids: [],
            finding_ids: [],
            started_at: nowIso()
          }
        ]
      },
      reviewOutcome: {
        kind: "parsed",
        result: {
          schema_version: "tychonic.review.v1",
          status: "fail",
          summary: "needs triage",
          findings: [
            {
              severity: "high",
              title: "untargeted finding",
              detail: "no target session",
              target: "src/a.ts"
            }
          ]
        },
        reviewerSessionId: "session_rev_no_target",
        artifacts: [],
        agentSessions: []
      }
    });

    expect(next.inbox.at(-1)?.action.kind).toBe("triage");
    expect(next.inbox.at(-1)?.target_session_id).toBeUndefined();
    expect(next.inbox.at(-1)?.action.reason).toBe(
      "review finding does not identify a target worker session"
    );
  });
});
