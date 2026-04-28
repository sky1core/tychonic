import { describe, expect, it } from "vitest";
import { kiroAcpAdapter } from "../../src/adapters/kiroAcp.js";
import { AdapterUnsupported } from "../../src/adapters/types.js";
import type { AdapterRunInput } from "../../src/adapters/types.js";

const BASE: AdapterRunInput = {
  prompt: "do the thing",
  worktreeCwd: "/tmp/wt",
  role: "work"
};

describe("kiroAcpAdapter", () => {
  it("name is kiro-acp", () => {
    expect(kiroAcpAdapter.name).toBe("kiro-acp");
  });

  it("runNew(work) emits an ACP client wrapper", () => {
    const { command } = kiroAcpAdapter.runNew(BASE);
    expect(command).toContain("kiro-cli");
    expect(command).toContain('"acp"');
    expect(command).toContain("session/new");
    expect(command).toContain("session/prompt");
    expect(command).toContain("__TYCHONIC_KIRO_ACP_SESSION_START__");
    expect(command).toContain("fs/read_text_file");
    expect(command).toContain("terminal/create");
    expect(command).not.toContain("/chat save");
    expect(command).not.toContain("--list-sessions");
  });

  it("session/prompt uses Kiro 2.1.1's prompt field before content fallback", () => {
    const { command } = kiroAcpAdapter.runNew(BASE);
    const promptIndex = command.indexOf('request("session/prompt", { sessionId, prompt: content })');
    const contentIndex = command.indexOf('request("session/prompt", { sessionId, content })');
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(contentIndex).toBeGreaterThan(promptIndex);
  });

  it("filters Kiro extension notifications instead of dumping full tool lists", () => {
    const { command } = kiroAcpAdapter.runNew(BASE);
    expect(command).toContain('method === "_kiro.dev/session/update"');
    expect(command).toContain('method === "_kiro.dev/metadata"');
    expect(command).toContain("kiro_acp_metadata");
    expect(command).not.toContain("kiro_acp_extension");
  });

  it("runNew(review) emits ACP wrapper without trust-all-tools", () => {
    const { command } = kiroAcpAdapter.runNew({ ...BASE, role: "review" });
    expect(command).toContain("kiro-cli");
    expect(command).toContain('"acp"');
    expect(command).toContain("session/prompt");
    expect(command).toContain("'0'");
  });

  it("runNew honours explicit trustAllTools=false on a worker role", () => {
    const { command } = kiroAcpAdapter.runNew({ ...BASE, trustAllTools: false });
    expect(command).toContain("const trustAllTools = process.argv[4] === \"1\"");
    expect(command).toContain("'0'");
  });

  it("runResume(work) loads the exact previous ACP session id", () => {
    const { command } = kiroAcpAdapter.runResume({
      ...BASE,
      sessionId: "sess_kiro_acp_123"
    });
    expect(command).toContain("session/load");
    expect(command).toContain("'sess_kiro_acp_123'");
    expect(command).not.toContain("--resume-id");
  });

  it("runResume(review) throws AdapterUnsupported (reviewer role unsupported)", () => {
    expect(() =>
      kiroAcpAdapter.runResume({
        ...BASE,
        role: "review",
        sessionId: "sess_kiro_acp_123"
      })
    ).toThrow(AdapterUnsupported);
  });

  it("parseResult extracts session_id from ACP session export", () => {
    const stdout = [
      "kiro output",
      "__TYCHONIC_KIRO_ACP_SESSION_START__",
      JSON.stringify({ session_id: "sess_kiro_acp_123" }),
      "__TYCHONIC_KIRO_ACP_SESSION_END__"
    ].join("\n");
    expect(kiroAcpAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "sess_kiro_acp_123"
    });
  });

  it("parseResult returns empty when no ACP export is present", () => {
    expect(kiroAcpAdapter.parseResult("Chat SessionId: abc-123\n", "", 0)).toEqual({});
    expect(kiroAcpAdapter.parseResult("", "", 0)).toEqual({});
  });
});
