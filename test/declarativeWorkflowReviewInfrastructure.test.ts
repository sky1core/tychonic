import { describe, expect, it, vi } from "vitest";
import {
  generateDeclarativeWorkflowModule,
  parseDeclarativeWorkflowSpecYaml
} from "../src/declarative/workflowSpec.js";

describe("generated declarative workflow review infrastructure failures", () => {
  it("waits for operator triage instead of routing reviewer command failures back to the builder", async () => {
    const generated = loadGeneratedWorkflow(reviewLoopSource());
    const waitingResult = { status: "waiting_user", runId: "run_review_command_failed" };
    const ctx = reviewLoopContext({
      reviewResult: {
        halted: false,
        passed: false,
        reason: "structured output for turn abc was not valid JSON",
        activityResult: {
          reviewOutcome: {
            kind: "command_failed",
            status: "failed",
            exitCode: 40,
            reason: "structured output for turn abc was not valid JSON"
          }
        }
      },
      finishWaitingUserResult: waitingResult
    });

    const result = await generated({
      input: runtimeInput(),
      ctx,
      assertReviewFailReturnTo: vi.fn(() => {
        throw new Error("semantic review fail routing should not run");
      })
    });

    expect(result).toBe(waitingResult);
    expect(ctx.work).toHaveBeenCalledTimes(1);
    expect(ctx.review).toHaveBeenCalledTimes(1);
    expect(ctx.finishWaitingUser).toHaveBeenCalledTimes(1);
    expect(ctx.finish).not.toHaveBeenCalled();
    expect(ctx.finishWaitingUser.mock.calls[0]?.[0]).toContain("first_review review infrastructure failed");
    expect(ctx.finishWaitingUser.mock.calls[0]?.[1]).toMatchObject({
      status: "open",
      title: "first_review review infrastructure failure",
      action: { kind: "triage", reason: "review outcome command_failed" }
    });
  });

  it("waits for operator triage before the generic halted path handles unparseable reviewer output", async () => {
    const generated = loadGeneratedWorkflow(reviewLoopSource());
    const waitingResult = { status: "waiting_user", runId: "run_review_unparseable" };
    const ctx = reviewLoopContext({
      reviewResult: {
        halted: true,
        passed: false,
        summary: "reviewer output did not match tychonic.review.v1",
        activityResult: {
          reviewOutcome: {
            kind: "unparseable",
            detail: "reviewer output did not match tychonic.review.v1"
          }
        }
      },
      finishWaitingUserResult: waitingResult
    });

    const result = await generated({
      input: runtimeInput(),
      ctx,
      assertReviewFailReturnTo: vi.fn(() => {
        throw new Error("semantic review fail routing should not run");
      })
    });

    expect(result).toBe(waitingResult);
    expect(ctx.work).toHaveBeenCalledTimes(1);
    expect(ctx.review).toHaveBeenCalledTimes(1);
    expect(ctx.finishWaitingUser).toHaveBeenCalledTimes(1);
    expect(ctx.finish).not.toHaveBeenCalled();
    expect(ctx.finishWaitingUser.mock.calls[0]?.[0]).toContain("reviewer output did not match");
    expect(ctx.finishWaitingUser.mock.calls[0]?.[1]).toMatchObject({
      status: "open",
      title: "first_review review infrastructure failure",
      action: { kind: "triage", reason: "review outcome unparseable" }
    });
  });

  it("waits for operator triage instead of routing skipped review states back to the builder", async () => {
    const generated = loadGeneratedWorkflow(reviewLoopSource());
    const waitingResult = { status: "waiting_user", runId: "run_review_skipped" };
    const ctx = reviewLoopContext({
      reviewResult: {
        halted: false,
        passed: false,
        reason: "review state config is missing",
        activityResult: {
          reviewOutcome: {
            kind: "skipped",
            reason: "state first_review has no runnable review configuration"
          }
        }
      },
      finishWaitingUserResult: waitingResult
    });

    const result = await generated({
      input: runtimeInput(),
      ctx,
      assertReviewFailReturnTo: vi.fn(() => {
        throw new Error("semantic review fail routing should not run");
      })
    });

    expect(result).toBe(waitingResult);
    expect(ctx.work).toHaveBeenCalledTimes(1);
    expect(ctx.review).toHaveBeenCalledTimes(1);
    expect(ctx.finishWaitingUser).toHaveBeenCalledTimes(1);
    expect(ctx.finish).not.toHaveBeenCalled();
    expect(ctx.finishWaitingUser.mock.calls[0]?.[1]).toMatchObject({
      status: "open",
      title: "first_review review infrastructure failure",
      action: { kind: "triage", reason: "review outcome skipped" }
    });
  });
});

function reviewLoopSource(): string {
  return generateDeclarativeWorkflowModule({
    bundleName: "reviewInfraWorkflow",
    spec: parseDeclarativeWorkflowSpecYaml({
      bundleName: "reviewInfraWorkflow",
      source: [
        "version: tychonic.workflow.v1",
        "name: reviewInfraWorkflow",
        "worktree: true",
        "max_steps: 4",
        "start: builder",
        "states:",
        "  builder:",
        "    type: work",
        "    command: cat >/dev/null",
        "    prompt: build",
        "    on_pass:",
        "      goto: first_review",
        "    on_fail:",
        "      finish: build failed",
        "  first_review:",
        "    type: review",
        "    command: node review.js",
        "    on_fail_return_to: builder",
        "    prompt: review",
        "    on_pass:",
        "      finish: true",
        "    on_fail:",
        "      goto: builder",
        ""
      ].join("\n")
    })
  });
}

function runtimeInput(): unknown {
  return {
    cwd: "/repo",
    profile: {
      version: "tychonic.config.v1",
      states: {
        builder: { type: "work", agent: "claude" },
        first_review: { type: "review", on_fail_return_to: "builder", agent: "claude" }
      },
      policies: {}
    }
  };
}

function reviewLoopContext(input: {
  reviewResult: unknown;
  finishWaitingUserResult: unknown;
}): {
  start: ReturnType<typeof vi.fn>;
  createWorktree: ReturnType<typeof vi.fn>;
  work: ReturnType<typeof vi.fn>;
  review: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
  finishWaitingUser: ReturnType<typeof vi.fn>;
  hasRun: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(async () => undefined),
    createWorktree: vi.fn(async () => undefined),
    work: vi.fn(async () => ({ halted: false, passed: true })),
    review: vi.fn(async () => input.reviewResult),
    finish: vi.fn(async () => ({ status: "succeeded" })),
    finishWaitingUser: vi.fn(async () => input.finishWaitingUserResult),
    hasRun: vi.fn(() => true),
    cancel: vi.fn()
  };
}

function loadGeneratedWorkflow(source: string): (args: {
  input: unknown;
  ctx: unknown;
  assertReviewFailReturnTo: (profile: unknown, reviewStateName: string, goto: string) => string;
}) => Promise<unknown> {
  const body = source
    .replace(/^import .+;\n/gm, "")
    .replace(/^export const defaultProfile =/m, "const defaultProfile =")
    .replace(/^export const workflowDefinition =/m, "const workflowDefinition =")
    .replace(/^export \{ generatedWorkflow as .+ \};$/m, "return generatedWorkflow;");

  const factory = new Function(
    "CancellationScope",
    "isCancellation",
    "proxyActivities",
    "assertReviewFailReturnTo",
    "createTychonicWorkflowContext",
    "renderDeclarativePrompt",
    body
  ) as (
    CancellationScope: unknown,
    isCancellation: (error: unknown) => boolean,
    proxyActivities: () => Record<string, unknown>,
    assertReviewFailReturnTo: (profile: unknown, reviewStateName: string, goto: string) => string,
    createTychonicWorkflowContext: () => unknown,
    renderDeclarativePrompt: (template: string) => string
  ) => (input: unknown) => Promise<unknown>;

  return async (args) => {
    const workflow = factory(
      { nonCancellable: async (fn: () => Promise<unknown>) => fn() },
      () => false,
      () => ({}),
      args.assertReviewFailReturnTo,
      () => args.ctx,
      (template) => template
    );
    return workflow(args.input);
  };
}
