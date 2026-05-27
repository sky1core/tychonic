import { describe, expect, it } from "vitest";
import { codexAdapter } from "../../src/adapters/openp.js";
import type { AdapterRunInput } from "../../src/adapters/types.js";

const BASE: AdapterRunInput = {
  prompt: "do the thing",
  worktreeCwd: "/tmp/wt",
  role: "work"
};

describe("codexAdapter", () => {
  it("name is codex", () => {
    expect(codexAdapter.name).toBe("codex");
  });

  it("runNew(work) makes Codex trusted execution explicit", () => {
    const { command } = codexAdapter.runNew(BASE);
    expect(command).toBe(
      "openp codex --timeout 0 --output-format stream-json --dangerously-skip-permissions"
    );
  });

  it("runNew(review) includes --json-schema without private permission-mode flags", () => {
    const { command } = codexAdapter.runNew({ ...BASE, role: "review" });
    expect(command).toContain("--json-schema");
    expect(command).not.toContain("--permission-mode");
  });

  it("runResume appends --resume without private permission-mode flags", () => {
    const { command } = codexAdapter.runResume({
      ...BASE,
      sessionId: "11111111-2222-3333-4444-555555555555"
    });
    expect(command).toBe(
      "openp codex --timeout 0 --output-format stream-json --dangerously-skip-permissions --resume '11111111-2222-3333-4444-555555555555'"
    );
  });

  it("runResume(review) includes --json-schema and --resume", () => {
    const { command } = codexAdapter.runResume({
      ...BASE,
      role: "review",
      sessionId: "abc"
    });
    expect(command).not.toContain("--permission-mode");
    expect(command).toContain("--json-schema");
    expect(command).toContain("--resume 'abc'");
  });
});
