import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../../src/adapters/claude.js";
import type { AdapterRunInput } from "../../src/adapters/types.js";

const BASE: AdapterRunInput = {
  prompt: "do the thing",
  worktreeCwd: "/tmp/wt",
  role: "work"
};

describe("claudeAdapter", () => {
  it("name is claude", () => {
    expect(claudeAdapter.name).toBe("claude");
  });

  it("runNew(work) emits stream-json + acceptEdits permission mode", () => {
    const { command } = claudeAdapter.runNew(BASE);
    expect(command).toBe(
      "claude -p --output-format stream-json --verbose --permission-mode acceptEdits"
    );
  });

  it("runNew(review) flips permission mode to plan", () => {
    const { command } = claudeAdapter.runNew({ ...BASE, role: "review" });
    expect(command).toBe(
      "claude -p --output-format stream-json --verbose --permission-mode plan"
    );
  });

  it("runNew honours an explicit permissionMode override", () => {
    const { command } = claudeAdapter.runNew({
      ...BASE,
      permissionMode: "bypassPermissions"
    });
    expect(command).toContain("--permission-mode bypassPermissions");
    expect(command).not.toContain("acceptEdits");
  });

  it("runResume appends --resume <session-id> to base args", () => {
    const { command } = claudeAdapter.runResume({
      ...BASE,
      sessionId: "11111111-2222-3333-4444-555555555555"
    });
    expect(command).toBe(
      "claude -p --output-format stream-json --verbose --permission-mode acceptEdits --resume 11111111-2222-3333-4444-555555555555"
    );
  });

  it("runResume(review) keeps role-specific permission mode", () => {
    const { command } = claudeAdapter.runResume({
      ...BASE,
      role: "review",
      sessionId: "abc"
    });
    expect(command).toContain("--permission-mode plan");
    expect(command).toContain("--resume abc");
  });

  it("parseResult extracts session_id from the system.init event", () => {
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "11111111-2222-3333-4444-555555555555",
        cwd: "/tmp/wt"
      }),
      JSON.stringify({ type: "assistant", message: { role: "assistant" } })
    ].join("\n");
    expect(claudeAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "11111111-2222-3333-4444-555555555555"
    });
  });

  it("parseResult tolerates non-JSON noise before the JSONL stream", () => {
    const stdout = [
      "warning: telemetry disabled",
      "",
      JSON.stringify({ type: "system", session_id: "abc-123" })
    ].join("\n");
    expect(claudeAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "abc-123"
    });
  });

  it("parseResult returns empty when no session_id is present", () => {
    expect(claudeAdapter.parseResult("hello world\n", "", 0)).toEqual({});
  });
});
