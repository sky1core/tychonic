import { describe, expect, it } from "vitest";
import { kiroAdapter } from "../../src/adapters/openp.js";
import type { AdapterRunInput } from "../../src/adapters/types.js";

const BASE: AdapterRunInput = {
  prompt: "do the thing",
  worktreeCwd: "/tmp/wt",
  role: "work"
};

describe("kiroAdapter", () => {
  it("name is kiro", () => {
    expect(kiroAdapter.name).toBe("kiro");
  });

  it("runNew(work) emits --dangerously-skip-permissions", () => {
    const { command } = kiroAdapter.runNew(BASE);
    expect(command).toBe(
      "openp kiro --timeout 0 --output-format stream-json --dangerously-skip-permissions"
    );
  });

  it("runNew(review) omits --dangerously-skip-permissions and --json-schema", () => {
    const { command } = kiroAdapter.runNew({ ...BASE, role: "review" });
    expect(command).toBe("openp kiro --timeout 0 --output-format stream-json");
    expect(command).not.toContain("--dangerously-skip-permissions");
    expect(command).not.toContain("--json-schema");
  });

  it("runNew honours explicit trustAllTools=false on a worker role", () => {
    const { command } = kiroAdapter.runNew({ ...BASE, trustAllTools: false });
    expect(command).not.toContain("--dangerously-skip-permissions");
  });

  it("runNew honours explicit trustAllTools=true on a review role", () => {
    const { command } = kiroAdapter.runNew({ ...BASE, role: "review", trustAllTools: true });
    expect(command).toContain("--dangerously-skip-permissions");
  });

  it("runResume(work) appends --resume with --dangerously-skip-permissions", () => {
    const { command } = kiroAdapter.runResume({
      ...BASE,
      sessionId: "sess_kiro_123"
    });
    expect(command).toBe(
      "openp kiro --timeout 0 --output-format stream-json --dangerously-skip-permissions --resume 'sess_kiro_123'"
    );
  });

  it("runResume(review) omits --dangerously-skip-permissions", () => {
    const { command } = kiroAdapter.runResume({
      ...BASE,
      role: "review",
      sessionId: "sess_kiro_123"
    });
    expect(command).toBe(
      "openp kiro --timeout 0 --output-format stream-json --resume 'sess_kiro_123'"
    );
    expect(command).not.toContain("--dangerously-skip-permissions");
  });
});
