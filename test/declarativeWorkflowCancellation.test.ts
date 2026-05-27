import { describe, expect, it, vi } from "vitest";
import {
  generateDeclarativeWorkflowModule,
  parseDeclarativeWorkflowSpecYaml
} from "../src/declarative/workflowSpec.js";

describe("generated declarative workflow cancellation", () => {
  it("returns a cancelled Tychonic result instead of rethrowing after run start", async () => {
    const source = generateDeclarativeWorkflowModule({
      bundleName: "cancelWorkflow",
      spec: parseDeclarativeWorkflowSpecYaml({
        bundleName: "cancelWorkflow",
        source: [
          "version: tychonic.workflow.v1",
          "name: cancelWorkflow",
          "worktree: false",
          "max_steps: 1",
          "start: verify",
          "states:",
          "  verify:",
          "    type: verify",
          "    command: echo ok",
          "    on_pass:",
          "      finish: true",
          "    on_fail:",
          "      finish: verify failed",
          ""
        ].join("\n")
      })
    });
    const generated = loadGeneratedWorkflow(source);
    const cancellation = new Error("workflow cancelled");
    const cancelledResult = {
      runId: "run_cancelled",
      status: "cancelled",
      run: {
        id: "run_cancelled",
        status: "cancelled",
        states: [{ id: "state_verify_done", name: "verify", status: "succeeded" }]
      }
    };
    let nonCancellableCalled = false;
    const ctx = {
      start: vi.fn(async () => undefined),
      createWorktree: vi.fn(async () => undefined),
      verify: vi.fn(async () => {
        throw cancellation;
      }),
      work: vi.fn(),
      review: vi.fn(),
      finish: vi.fn(),
      finishWaitingUser: vi.fn(),
      hasRun: vi.fn(() => true),
      cancel: vi.fn(async () => cancelledResult)
    };

    const result = await generated({
      input: { cwd: "/repo", profile: { version: "tychonic.config.v1", states: {}, policies: {} } },
      ctx,
      isCancellation: (error: unknown) => error === cancellation,
      nonCancellable: async (fn: () => Promise<unknown>) => {
        nonCancellableCalled = true;
        return fn();
      }
    });

    expect(result).toBe(cancelledResult);
    expect(nonCancellableCalled).toBe(true);
    expect(ctx.cancel).toHaveBeenCalledTimes(1);
    expect(ctx.finish).not.toHaveBeenCalled();
    expect(ctx.finishWaitingUser).not.toHaveBeenCalled();
  });

  it("rethrows cancellation before run start because no Tychonic evidence exists yet", async () => {
    const source = generateDeclarativeWorkflowModule({
      bundleName: "cancelBeforeStartWorkflow",
      spec: parseDeclarativeWorkflowSpecYaml({
        bundleName: "cancelBeforeStartWorkflow",
        source: [
          "version: tychonic.workflow.v1",
          "name: cancelBeforeStartWorkflow",
          "worktree: false",
          "max_steps: 1",
          "start: verify",
          "states:",
          "  verify:",
          "    type: verify",
          "    command: echo ok",
          "    on_pass:",
          "      finish: true",
          "    on_fail:",
          "      finish: verify failed",
          ""
        ].join("\n")
      })
    });
    const generated = loadGeneratedWorkflow(source);
    const cancellation = new Error("workflow cancelled before start");
    const ctx = {
      start: vi.fn(async () => {
        throw cancellation;
      }),
      createWorktree: vi.fn(async () => undefined),
      verify: vi.fn(),
      work: vi.fn(),
      review: vi.fn(),
      finish: vi.fn(),
      finishWaitingUser: vi.fn(),
      hasRun: vi.fn(() => false),
      cancel: vi.fn()
    };

    await expect(generated({
      input: { cwd: "/repo", profile: { version: "tychonic.config.v1", states: {}, policies: {} } },
      ctx,
      isCancellation: (error: unknown) => error === cancellation,
      nonCancellable: async (fn: () => Promise<unknown>) => fn()
    })).rejects.toBe(cancellation);

    expect(ctx.cancel).not.toHaveBeenCalled();
    expect(ctx.verify).not.toHaveBeenCalled();
  });
});

function loadGeneratedWorkflow(source: string): (args: {
  input: unknown;
  ctx: unknown;
  isCancellation: (error: unknown) => boolean;
  nonCancellable: (fn: () => Promise<unknown>) => Promise<unknown>;
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
    assertReviewFailReturnTo: () => never,
    createTychonicWorkflowContext: () => unknown,
    renderDeclarativePrompt: (template: string) => string
  ) => (input: unknown) => Promise<unknown>;

  return async (args) => {
    const workflow = factory(
      { nonCancellable: args.nonCancellable },
      args.isCancellation,
      () => ({}),
      () => {
        throw new Error("assertReviewFailReturnTo should not run");
      },
      () => args.ctx,
      (template) => template
    );
    return workflow(args.input);
  };
}
