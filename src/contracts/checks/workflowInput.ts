import { validateTaskWorkflowInput } from "../../workflow.js";
import type { ContractCheck } from "./types.js";
import { expectAccept, expectReject } from "./types.js";

const PROMPTABLE_STATES = ["work", "review"] as const;

export const workflowInputContractChecks: readonly ContractCheck[] = [
  {
    area: "workflow-input",
    name: "accepts task-shaped input with additive prompt instructions",
    run() {
      expectAccept("task-shaped input", () =>
        validateTaskWorkflowInput(
          {
            cwd: "/tmp/tychonic",
            goal: "fix the issue",
            profile: {
              states: {
                work: { type: "work", agent: "claude" },
                review: { type: "review", agent: "claude" }
              }
            },
            promptAdditions: {
              work: "prefer the existing module boundary"
            }
          },
          { promptAdditionStates: PROMPTABLE_STATES }
        )
      );
    }
  },
  {
    area: "workflow-input",
    name: "rejects missing cwd",
    run() {
      expectReject(
        "missing cwd",
        () => validateTaskWorkflowInput({ goal: "x" }),
        /cwd must be a non-empty string/
      );
    }
  },
  {
    area: "workflow-input",
    name: "rejects unknown top-level fields",
    run() {
      expectReject(
        "unknown workflow input field",
        () => validateTaskWorkflowInput({ cwd: "/tmp/tychonic", kiroPreReviewPrompt: "inspect" }),
        /unsupported input field: kiroPreReviewPrompt/
      );
    }
  },
  {
    area: "workflow-input",
    name: "rejects prompt additions when the workflow does not expose them",
    run() {
      expectReject(
        "unexpected promptAdditions",
        () => validateTaskWorkflowInput({ cwd: "/tmp/tychonic", promptAdditions: { work: "x" } }),
        /unsupported input field: promptAdditions/
      );
    }
  },
  {
    area: "workflow-input",
    name: "rejects prompt addition keys outside the workflow-owned state set",
    run() {
      expectReject(
        "unsupported promptAdditions state",
        () =>
          validateTaskWorkflowInput(
            {
              cwd: "/tmp/tychonic",
              promptAdditions: { kiroPreReview: "inspect" }
            },
            { promptAdditionStates: PROMPTABLE_STATES }
          ),
        /unsupported promptAdditions state: kiroPreReview/
      );
    }
  },
  {
    area: "workflow-input",
    name: "rejects prompt addition keys absent from the effective profile",
    run() {
      expectReject(
        "promptAdditions state absent from profile",
        () =>
          validateTaskWorkflowInput(
            {
              cwd: "/tmp/tychonic",
              profile: {
                states: {
                  work: { type: "work", agent: "claude" }
                }
              },
              promptAdditions: { review: "inspect" }
            },
            { promptAdditionStates: PROMPTABLE_STATES }
          ),
        /promptAdditions\.review does not match a configured state/
      );
    }
  },
  {
    area: "workflow-input",
    name: "rejects prompt additions without effective profile states",
    run() {
      expectReject(
        "promptAdditions without effective profile states",
        () =>
          validateTaskWorkflowInput(
            {
              cwd: "/tmp/tychonic",
              promptAdditions: { work: "x" }
            },
            { promptAdditionStates: PROMPTABLE_STATES }
          ),
        /promptAdditions requires effective profile\.states/
      );
    }
  },
  {
    area: "workflow-input",
    name: "rejects verify-only goal input",
    run() {
      expectReject(
        "verify-only goal",
        () => validateTaskWorkflowInput({ cwd: "/tmp/tychonic", goal: "x" }, { allowGoal: false }),
        /unsupported input field: goal/
      );
    }
  }
] as const;
