import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// Bundle activity-contract gate. Each activity the simpleWorkflow bundle
// dispatches has a required-fields contract enforced at the host side. If a
// future bundle edit drops one of those fields, unit/integration tests with
// fake activity bodies will not catch it — but a live worker rejects the
// run immediately. These tests pin the call shape against the activity input
// types so any drift fails before the live smoke is needed.

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bundle modules export plain JS, no TS types.
import {
  buildReviewPrompt,
  runAutoContinueLoop
} from "../examples/workflows/simpleWorkflow/reviewLoop.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - bundle modules export plain JS, no TS types.
import {
  simpleWorkflow
} from "../examples/workflows/simpleWorkflow/workflow.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = join(__dirname, "..", "examples", "workflows", "simpleWorkflow", "workflow.mjs");
const REVIEW_LOOP_PATH = join(__dirname, "..", "examples", "workflows", "simpleWorkflow", "reviewLoop.mjs");

interface RecordedCall {
  name: "worker" | "verify" | "review";
  input: any;
}

function makeWorkerSession(id: string, resumable = true) {
  return {
    id,
    agent: "claude",
    role: "worker" as const,
    cwd: "/tmp/tychonic-test",
    status: "succeeded" as const,
    ...(resumable ? { resumable: true } : {}),
    started_at: "2026-04-26T00:00:00.000Z"
  };
}

function makeReviewerSession(id: string) {
  return {
    id,
    agent: "claude",
    role: "reviewer" as const,
    cwd: "/tmp/tychonic-test",
    status: "succeeded" as const,
    started_at: "2026-04-26T00:00:00.000Z"
  };
}

function makeBaseRun(workerSession: any) {
  const stateWork = {
    id: "state_work_1",
    name: "work",
    status: "succeeded",
    reason: "run work",
    activity_attempt_ids: ["attempt_work_1"],
    artifact_ids: [],
    finding_ids: [],
    started_at: "2026-04-26T00:00:00.000Z",
    finished_at: "2026-04-26T00:00:00.000Z"
  };
  const stateReview = {
    id: "state_review_1",
    name: "review",
    status: "failed",
    reason: "needs fix",
    activity_attempt_ids: ["attempt_review_1"],
    artifact_ids: [],
    finding_ids: ["finding_1"],
    started_at: "2026-04-26T00:00:00.000Z",
    finished_at: "2026-04-26T00:00:00.000Z"
  };
  const finding = {
    id: "finding_1",
    status: "new",
    severity: "high",
    title: "broken thing",
    detail: "fix it",
    target: "src/a.ts",
    source_state_id: "state_review_1",
    target_work_session_id: workerSession.id,
    created_at: "2026-04-26T00:00:00.000Z"
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
    created_at: "2026-04-26T00:00:00.000Z"
  };
  return {
    schema_version: "tychonic.run.v1",
    id: "run_contract_1",
    template: "simple_workflow",
    status: "running",
    cwd: "/tmp/tychonic-test",
    created_at: "2026-04-26T00:00:00.000Z",
    updated_at: "2026-04-26T00:00:00.000Z",
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
        started_at: "2026-04-26T00:00:00.000Z",
        finished_at: "2026-04-26T00:00:00.000Z"
      },
      {
        id: "attempt_review_1",
        state_id: "state_review_1",
        kind: "semantic_review",
        status: "succeeded",
        reason: "run review",
        cwd: "/tmp/tychonic-test",
        started_at: "2026-04-26T00:00:00.000Z",
        finished_at: "2026-04-26T00:00:00.000Z"
      }
    ],
    agent_sessions: [workerSession],
    artifacts: [],
    findings: [finding],
    inbox: [inbox]
  };
}

function makeStubActivities(calls: RecordedCall[], reviewerFactory: () => any) {
  let attemptCounter = 0;
  return {
    runWorker: (input: any) => {
      attemptCounter += 1;
      calls.push({ name: "worker", input });
      const stateId = `state_resume_${attemptCounter}`;
      const attemptId = `attempt_resume_${attemptCounter}`;
      return {
        delta: {
          states: [
            {
              id: stateId,
              name: "work",
              status: "succeeded",
              reason: `resume`,
              activity_attempt_ids: [attemptId],
              artifact_ids: [],
              finding_ids: [],
              started_at: "2026-04-26T00:00:00.000Z",
              finished_at: "2026-04-26T00:00:00.000Z"
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
              agent_session_id: input.sessionId,
              started_at: "2026-04-26T00:00:00.000Z",
              finished_at: "2026-04-26T00:00:00.000Z"
            }
          ]
        },
        workerOutcome: { kind: "executed", artifacts: [], agentSessions: [] }
      };
    },
    runVerify: (input: any) => {
      attemptCounter += 1;
      calls.push({ name: "verify", input });
      const stateId = `state_verify_${attemptCounter}`;
      const attemptId = `attempt_verify_${attemptCounter}`;
      const artifact = {
        id: `artifact_v_${attemptCounter}`,
        kind: "verify_output",
        path: `.tychonic/v_${attemptCounter}.log`,
        created_at: "2026-04-26T00:00:00.000Z",
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
              reason: "verify",
              activity_attempt_ids: [attemptId],
              artifact_ids: [artifact.id],
              finding_ids: [],
              started_at: "2026-04-26T00:00:00.000Z",
              finished_at: "2026-04-26T00:00:00.000Z"
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
              started_at: "2026-04-26T00:00:00.000Z",
              finished_at: "2026-04-26T00:00:00.000Z"
            }
          ]
        },
        commandOutcome: { artifact }
      };
    },
    runReview: (input: any) => {
      attemptCounter += 1;
      calls.push({ name: "review", input });
      const stateId = `state_review_iter_${attemptCounter}`;
      const attemptId = `attempt_review_iter_${attemptCounter}`;
      const reviewer = reviewerFactory();
      const lastWorker = [...input.run.agent_sessions]
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
              started_at: "2026-04-26T00:00:00.000Z",
              finished_at: "2026-04-26T00:00:00.000Z"
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
              agent_session_id: reviewer.id,
              started_at: "2026-04-26T00:00:00.000Z",
              finished_at: "2026-04-26T00:00:00.000Z"
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
                ...(lastWorker ? { target_session_id: lastWorker.id } : {})
              }
            ]
          },
          reviewerSessionId: reviewer.id,
          artifacts: [],
          agentSessions: [reviewer]
        }
      };
    }
  };
}

const PROFILE_FOR_CAP = {
  version: "tychonic.config.v1",
  states: {
    work: { type: "work", agent: "claude", resume: 2 },
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

describe("simpleWorkflow runAutoContinueLoop activity-call contracts", () => {
  it("every dispatched activity call carries the host-required input fields", async () => {
    const initialWorker = makeWorkerSession("session_w0");
    const run = makeBaseRun(initialWorker);
    const calls: RecordedCall[] = [];
    const activities = makeStubActivities(
      calls,
      () => makeReviewerSession(`session_rev_${calls.length}`)
    );

    await runAutoContinueLoop({
      input: { profile: PROFILE_FOR_CAP, cwd: "/tmp/tychonic-test" },
      run,
      worktreePath: "/tmp/tychonic-test/wt",
      workSession: initialWorker,
      maxIterations: 8,
      activities
    });

    // At least one of every required dispatch type must have happened.
    const byKind = (kind: RecordedCall["name"]) => calls.filter((c) => c.name === kind);
    expect(byKind("worker").length).toBeGreaterThanOrEqual(1);
    expect(byKind("verify").length).toBeGreaterThanOrEqual(1);
    expect(byKind("review").length).toBeGreaterThanOrEqual(1);

    // ===== runWorkerActivity resume-mode contract =====
    // Bundle's resume call must carry worktreePath + sessionId + prompt —
    // the host activity rejects missing fields.
    for (const call of byKind("worker")) {
      expect(call.input.stateName).toBe("work");
      expect(typeof call.input.worktreePath).toBe("string");
      expect(typeof call.input.sessionId).toBe("string");
      expect(call.input.sessionId.length).toBeGreaterThan(0);
      expect(typeof call.input.prompt).toBe("string");
      expect(call.input.prompt.length).toBeGreaterThan(0);
    }

    // ===== runVerifyActivity contract =====
    for (const call of byKind("verify")) {
      expect(call.input.stateName).toBe("verify");
      expect(typeof call.input.worktreePath).toBe("string");
      expect("command" in call.input).toBe(false);
    }

    // ===== runReviewActivity contract =====
    // The bug this guard exists for: the host activity rejects empty/missing
    // prompt. Bundles must construct one from the run record.
    for (const call of byKind("review")) {
      expect(call.input.stateName).toBe("review");
      expect(typeof call.input.worktreePath).toBe("string");
      expect(typeof call.input.prompt, "review prompt").toBe("string");
      expect(call.input.prompt.length).toBeGreaterThan(0);
      // verificationCommands is expected by the contract documented in
      // ActivityCallFieldsByType.review (non-empty when known).
      expect(Array.isArray(call.input.verificationCommands)).toBe(true);
    }
  });
});

describe("simpleWorkflow buildReviewPrompt", () => {
  it("returns a non-empty prompt that asks for semantic review payload only", () => {
    const run = makeBaseRun(makeWorkerSession("session_w0"));
    const prompt = buildReviewPrompt(run, "scope-label");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).not.toContain("tychonic.review.v1");
    expect(prompt).not.toContain("schema_version");
    expect(prompt).not.toContain("Return only one JSON object");
    expect(prompt).toContain("scope-label");
    expect(prompt).toContain("session_w0");
    expect(prompt).toContain('set target_session_id to "session_w0"');
  });
});

describe("simpleWorkflow workflow source — every runReviewActivity call passes prompt", () => {
  // Static guard: regardless of code paths exercised by integration tests,
  // every call to runReviewActivity / activities.runReview must pass an
  // explicit prompt. A regex over the bundle source catches drift the
  // injection-driven test cannot reach (call sites in runMainPipeline,
  // runContinuation, etc. that use proxied activities directly).
  const source = [
    readFileSync(BUNDLE_PATH, "utf8"),
    readFileSync(REVIEW_LOOP_PATH, "utf8")
  ].join("\n");

  function findCallSites(source: string, callee: string): string[] {
    const matches: string[] = [];
    const callRegex = new RegExp(`${callee}\\s*\\(`, "g");
    let match: RegExpExecArray | null;
    while ((match = callRegex.exec(source)) !== null) {
      // Walk forward through the source to find the matching `)` of this
      // call. Track brace and paren depth so nested object literals inside
      // the argument do not trip the scan.
      let depth = 1;
      const start = match.index + match[0].length;
      let i = start;
      while (i < source.length && depth > 0) {
        const ch = source[i];
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        i += 1;
      }
      matches.push(source.slice(start, i - 1));
    }
    return matches;
  }

  it("runReviewActivity is called at least once in the bundle (initial review)", () => {
    const sites = findCallSites(source, "runReviewActivity");
    expect(sites.length).toBeGreaterThanOrEqual(1);
  });

  it("every runReviewActivity({...}) call passes prompt", () => {
    const sites = findCallSites(source, "runReviewActivity");
    for (const arg of sites) {
      expect(arg, `runReviewActivity call without prompt: ${arg.slice(0, 200)}`).toMatch(/\bprompt\s*:/);
    }
  });

  it("activities.runReview({...}) calls inside the cap loop also pass prompt", () => {
    const sites = findCallSites(source, "activities\\.runReview");
    expect(sites.length).toBeGreaterThanOrEqual(1);
    for (const arg of sites) {
      expect(arg, `activities.runReview call without prompt: ${arg.slice(0, 200)}`).toMatch(/\bprompt\s*:/);
    }
  });

  it("runWorkerActivity / activities.runWorker calls pass worktreePath", () => {
    const sites = [
      ...findCallSites(source, "runWorkerActivity"),
      ...findCallSites(source, "activities\\.runWorker")
    ];
    expect(sites.length).toBeGreaterThanOrEqual(1);
    for (const arg of sites) {
      expect(arg, `runWorker call without worktreePath: ${arg.slice(0, 200)}`).toMatch(/\bworktreePath\b/);
    }
  });

  it("runVerifyActivity / activities.runVerify calls pass worktreePath and no command override", () => {
    const sites = [
      ...findCallSites(source, "runVerifyActivity"),
      ...findCallSites(source, "activities\\.runVerify")
    ];
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const arg of sites) {
      expect(arg, `runVerify call without worktreePath: ${arg.slice(0, 200)}`).toMatch(/\bworktreePath\b/);
      expect(arg).not.toMatch(/\bcommand\b/);
    }
  });

  it("activities.runWorker resume-mode calls pass sessionId and prompt", () => {
    const sites = findCallSites(source, "activities\\.runWorker");
    expect(sites.length).toBeGreaterThanOrEqual(1);
    for (const arg of sites) {
      expect(arg, `resume-mode runWorker call without sessionId: ${arg.slice(0, 200)}`).toMatch(/\bsessionId\b/);
      expect(arg, `resume-mode runWorker call without prompt: ${arg.slice(0, 200)}`).toMatch(/\bprompt\b/);
    }
  });

});

// Rejection contract: input outside this workflow's declared surface fails
// before any Temporal primitive is invoked.
describe("simpleWorkflow rejects unknown input fields at start", () => {
  const baseInput = {
    cwd: "/tmp/tychonic-test"
  };

  it("rejects any field outside the workflow input contract", async () => {
    await expect(simpleWorkflow({ ...baseInput, unexpectedField: true })).rejects.toThrow(
      "unsupported input field: unexpectedField"
    );
  });

  it.each(["command", "agent", "verifyCommand", "reviewAgent", "autoContinue", "maxIterations"])(
    "rejects execution selector input field %s",
    async (field) => {
      await expect(simpleWorkflow({ ...baseInput, [field]: "value" })).rejects.toThrow(
        `unsupported input field: ${field}`
      );
    }
  );
});
