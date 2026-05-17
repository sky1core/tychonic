import { describe, expect, it } from "vitest";
import { responseTextForDisplay, stateCommandForDisplay } from "../web-client/src/stateEvidence";

describe("status UI state evidence display decisions", () => {
  it("hides built-in agent wrapper commands from state config even without session metadata", () => {
    expect(
      stateCommandForDisplay({
        attemptCommand: "codex exec --json ...",
        stateConfigAgent: "codex"
      })
    ).toBeUndefined();
  });

  it("hides commands when an attempt references a missing session and no custom command config exists", () => {
    expect(
      stateCommandForDisplay({
        attemptAgentSessionId: "session_1",
        attemptCommand: "claude -p ..."
      })
    ).toBeUndefined();
  });

  it("shows custom command evidence and falls back to state config command when attempt command is absent", () => {
    expect(
      stateCommandForDisplay({
        stateConfigCommand: "npm test"
      })
    ).toBe("npm test");
    expect(
      stateCommandForDisplay({
        attemptCommand: "npm run typecheck",
        stateConfigCommand: "npm test"
      })
    ).toBe("npm run typecheck");
  });

  it("renders empty response artifacts explicitly", () => {
    expect(responseTextForDisplay("")).toBe("(empty response)");
    expect(responseTextForDisplay("   \n")).toBe("(empty response)");
    expect(responseTextForDisplay(undefined)).toBeUndefined();
    expect(responseTextForDisplay("review passed")).toBe("review passed");
  });
});
