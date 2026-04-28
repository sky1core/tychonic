import { describe, expect, it } from "vitest";
import { kiroAdapter } from "../../src/adapters/kiro.js";
import { AdapterUnsupported } from "../../src/adapters/types.js";
import type { AdapterRunInput } from "../../src/adapters/types.js";

const BASE: AdapterRunInput = {
  prompt: "do the thing",
  worktreeCwd: "/tmp/wt",
  role: "work"
};

describe("kiroAdapter", () => {
  it("name is kiro (binary on disk is kiro-cli)", () => {
    expect(kiroAdapter.name).toBe("kiro");
  });

  it("runNew(work) emits same-process session export wrapper", () => {
    const { command } = kiroAdapter.runNew(BASE);
    expect(command).toContain("'kiro-cli' 'chat' '--trust-all-tools' '--wrap' 'never'");
    expect(command).toContain("/chat save");
    expect(command).toContain("__TYCHONIC_KIRO_SESSION_EXPORT_START__");
    expect(command).toContain("JSON.stringify({ conversation_id: conversationId })");
    expect(command).not.toContain('cat "$export_file"');
    expect(command).not.toContain("--list-sessions");
  });

  it("runNew(review) emits prose review wrapper without trust-all-tools", () => {
    const { command } = kiroAdapter.runNew({ ...BASE, role: "review" });
    expect(command).toContain("'kiro-cli' 'chat' '--wrap' 'never'");
    expect(command).not.toContain("--trust-all-tools");
    expect(command).toContain("/chat save");
  });

  it("runNew honours explicit trustAllTools=false on a worker role", () => {
    const { command } = kiroAdapter.runNew({ ...BASE, trustAllTools: false });
    expect(command).toContain("'kiro-cli' 'chat' '--wrap' 'never'");
    expect(command).not.toContain("--trust-all-tools");
    expect(command).not.toContain("--no-interactive");
  });

  it("runResume(work) appends --resume-id <session-id>", () => {
    const { command } = kiroAdapter.runResume({
      ...BASE,
      sessionId: "11111111-2222-3333-4444-555555555555"
    });
    expect(command).toBe(
      "'kiro-cli' 'chat' '--no-interactive' '--trust-all-tools' '--resume-id' '11111111-2222-3333-4444-555555555555'"
    );
  });

  it("runResume(review) throws AdapterUnsupported (reviewer role unsupported)", () => {
    expect(() =>
      kiroAdapter.runResume({
        ...BASE,
        role: "review",
        sessionId: "11111111-2222-3333-4444-555555555555"
      })
    ).toThrow(AdapterUnsupported);
    expect(() =>
      kiroAdapter.runResume({
        ...BASE,
        role: "review",
        sessionId: "11111111-2222-3333-4444-555555555555"
      })
    ).toThrow(/kiro/);
  });

  it("parseResult extracts conversation_id from same-process session export", () => {
    const stdout = [
      "kiro output",
      "__TYCHONIC_KIRO_SESSION_EXPORT_START__",
      JSON.stringify({ conversation_id: "11111111-2222-3333-4444-555555555555" }),
      "__TYCHONIC_KIRO_SESSION_EXPORT_END__"
    ].join("\n");
    expect(kiroAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "11111111-2222-3333-4444-555555555555"
    });
  });

  it("parseResult returns empty when no process-bound export is present", () => {
    expect(kiroAdapter.parseResult("Chat SessionId: abc-123\n", "", 0)).toEqual({});
    expect(kiroAdapter.parseResult("", "", 0)).toEqual({});
  });
});
