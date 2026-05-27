import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../../src/adapters/openp.js";
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

  it("runNew(work) uses only OpenP public flags by default", () => {
    const { command } = claudeAdapter.runNew(BASE);
    expect(command).toBe(
      "openp claude --timeout 0 --output-format stream-json"
    );
  });

  it("runNew(review) includes --json-schema without private permission-mode flags", () => {
    const { command } = claudeAdapter.runNew({ ...BASE, role: "review" });
    expect(command).toContain("--json-schema");
    expect(command).not.toContain("--permission-mode");
  });

  it("runNew maps explicit bypass permission to OpenP's public trust flag", () => {
    const { command } = claudeAdapter.runNew({
      ...BASE,
      permissionMode: "bypassPermissions"
    });
    expect(command).toContain("--dangerously-skip-permissions");
    expect(command).not.toContain("--permission-mode");
  });

  it("runResume appends --resume without private permission-mode flags", () => {
    const { command } = claudeAdapter.runResume({
      ...BASE,
      sessionId: "11111111-2222-3333-4444-555555555555"
    });
    expect(command).toBe(
      "openp claude --timeout 0 --output-format stream-json --resume '11111111-2222-3333-4444-555555555555'"
    );
  });

  it("runResume(review) includes --json-schema and --resume", () => {
    const { command } = claudeAdapter.runResume({
      ...BASE,
      role: "review",
      sessionId: "abc"
    });
    expect(command).toContain("--json-schema");
    expect(command).toContain("--resume 'abc'");
    expect(command).not.toContain("--permission-mode");
  });
});
