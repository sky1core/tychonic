import { describe, expect, it } from "vitest";
import { geminiAdapter } from "../../src/adapters/gemini.js";
import { AdapterUnsupported } from "../../src/adapters/types.js";
import type { AdapterRunInput } from "../../src/adapters/types.js";

const BASE: AdapterRunInput = {
  prompt: "do the thing",
  worktreeCwd: "/tmp/wt",
  role: "work"
};

describe("geminiAdapter", () => {
  it("name is gemini", () => {
    expect(geminiAdapter.name).toBe("gemini");
  });

  it("runNew(work) emits yolo approval + sandbox + stream-json", () => {
    const { command } = geminiAdapter.runNew(BASE);
    expect(command).toBe(
      'gemini --approval-mode yolo --sandbox --output-format stream-json -p ""'
    );
  });

  it("runNew honours an explicit permissionMode override of plan", () => {
    const { command } = geminiAdapter.runNew({
      ...BASE,
      permissionMode: "plan"
    });
    expect(command).toContain("--approval-mode plan");
    expect(command).not.toContain("yolo");
  });

  it("runNew(review) throws AdapterUnsupported (no non-interactive review surface)", () => {
    expect(() => geminiAdapter.runNew({ ...BASE, role: "review" })).toThrow(
      AdapterUnsupported
    );
  });

  it("runResume always throws AdapterUnsupported (no stable resume id)", () => {
    expect(() =>
      geminiAdapter.runResume({ ...BASE, sessionId: "irrelevant" })
    ).toThrow(AdapterUnsupported);
  });

  it("AdapterUnsupported carries adapter + operation metadata", () => {
    try {
      geminiAdapter.runResume({ ...BASE, sessionId: "x" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterUnsupported);
      const e = err as AdapterUnsupported;
      expect(e.adapter).toBe("gemini");
      expect(e.operation).toBe("runResume");
    }
  });

  it("parseResult always returns empty (sessions non-resumable)", () => {
    const stdout = JSON.stringify({ session_id: "would-not-help-anyway" });
    expect(geminiAdapter.parseResult(stdout, "", 0)).toEqual({});
  });
});
