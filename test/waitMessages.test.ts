import { describe, expect, it } from "vitest";
import { stoppedWorkflowCliPayload, stoppedWorkflowMessage } from "../src/cli/waitMessages.js";

describe("stoppedWorkflowMessage", () => {
  it("prints copyable evidence and interaction commands for a pending interactive state", () => {
    const message = stoppedWorkflowMessage({
      reason: "pending_interaction",
      workflowId: "wf_pending",
      pendingState: "qa"
    });

    expect(message).toContain("Workflow is waiting for input at state 'qa'.");
    expect(message).toContain("`tychonic status --workflow-id wf_pending --include-result`");
    expect(message).toContain("`tychonic inbox --workflow-id wf_pending`");
    expect(message).toContain("`tychonic artifacts --workflow-id wf_pending`");
    expect(message).toContain("`tychonic logs --workflow-id wf_pending`");
    expect(message).toContain("`tychonic approve wf_pending --state qa`");
    expect(message).toContain("`tychonic reject wf_pending --state qa --feedback \"<feedback>\"`");
    expect(message).toContain("`tychonic modify wf_pending --state qa --note \"<note>\"`");
  });

  it("prints the result inspection command for succeeded workflows", () => {
    const message = stoppedWorkflowMessage({
      reason: "run_status",
      workflowId: "wf_done",
      status: "succeeded"
    });

    expect(message).toBe(
      "Workflow finished with status 'succeeded'. Read the result with `tychonic status --workflow-id wf_done --include-result`."
    );
  });

  it("prints evidence commands for terminal attention states", () => {
    const message = stoppedWorkflowMessage({
      reason: "run_status",
      workflowId: "wf_attention",
      status: "waiting_user"
    });

    expect(message).toContain("Workflow needs attention with status 'waiting_user'.");
    expect(message).toContain("`tychonic status --workflow-id wf_attention --include-result`");
    expect(message).toContain("`tychonic inbox --workflow-id wf_attention`");
    expect(message).toContain("documented recovery path");
  });

  it("quotes workflow ids and state names when needed for copyable shell commands", () => {
    const message = stoppedWorkflowMessage({
      reason: "pending_interaction",
      workflowId: "wf odd",
      pendingState: "qa's turn"
    });

    expect(message).toContain("`tychonic approve 'wf odd' --state 'qa'\\''s turn'`");
  });

  it("keeps wait CLI payloads concise and leaves full results behind status --include-result", () => {
    const stoppedResult = {
      reason: "run_status",
      workflowId: "wf_done",
      runId: "run_done",
      status: "succeeded",
      result: {
        run: {
          states: Array.from({ length: 50 }, (_, index) => ({ name: `state_${index}` }))
        }
      }
    } as const;
    const payload = stoppedWorkflowCliPayload(stoppedResult);

    expect(payload).toEqual({
      workflowId: "wf_done",
      runId: "run_done",
      message:
        "Workflow finished with status 'succeeded'. Read the result with `tychonic status --workflow-id wf_done --include-result`.",
      status: "succeeded"
    });
    expect("result" in payload).toBe(false);
  });
});
