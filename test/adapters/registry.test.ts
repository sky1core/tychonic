import { describe, expect, it } from "vitest";
import {
  BUILTIN_AGENT_NAMES,
  getAgentAdapter,
  isBuiltInAgentName
} from "../../src/adapters/index.js";

describe("adapter registry", () => {
  it("exports the built-in agent names in stable order", () => {
    expect(BUILTIN_AGENT_NAMES).toEqual(["claude", "codex", "gemini", "kiro", "kiro-acp"]);
  });

  it("isBuiltInAgentName recognises each built-in name", () => {
    for (const name of BUILTIN_AGENT_NAMES) {
      expect(isBuiltInAgentName(name)).toBe(true);
    }
  });

  it("isBuiltInAgentName rejects free-form labels and undefined", () => {
    expect(isBuiltInAgentName("claude-test-stub")).toBe(false);
    expect(isBuiltInAgentName("CLAUDE")).toBe(false);
    expect(isBuiltInAgentName("")).toBe(false);
    expect(isBuiltInAgentName(undefined)).toBe(false);
  });

  it("getAgentAdapter returns a self-named adapter for each built-in", () => {
    for (const name of BUILTIN_AGENT_NAMES) {
      const adapter = getAgentAdapter(name);
      expect(adapter.name).toBe(name);
      expect(typeof adapter.runNew).toBe("function");
      expect(typeof adapter.runResume).toBe("function");
      expect(typeof adapter.parseResult).toBe("function");
    }
  });
});
