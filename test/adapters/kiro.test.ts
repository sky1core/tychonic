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
  it("name is kiro", () => {
    expect(kiroAdapter.name).toBe("kiro");
  });

  it("runNew(work) emits an ACP client wrapper", () => {
    const { command } = kiroAdapter.runNew(BASE);
    expect(command).toContain("kiro-cli");
    expect(command).toContain('"acp"');
    expect(command).toContain("session/new");
    expect(command).toContain("session/prompt");
    expect(command).toContain("__TYCHONIC_KIRO_SESSION_START__");
    expect(command).toContain("fs/read_text_file");
    expect(command).toContain("terminal/create");
    expect(command).not.toContain("/chat save");
    expect(command).not.toContain("--list-sessions");
  });

  it("runNew passes an explicit model setting to the ACP process", () => {
    const { command } = kiroAdapter.runNew({
      ...BASE,
      model: "claude-sonnet-4.5"
    });
    expect(command).toContain("'claude-sonnet-4.5'");
    expect(command).toContain('...(model ? ["--model", model] : [])');
  });

  it("session/prompt uses Kiro 2.1.1's prompt field before content fallback", () => {
    const { command } = kiroAdapter.runNew(BASE);
    const promptIndex = command.indexOf('request("session/prompt", { sessionId, prompt: content })');
    const contentIndex = command.indexOf('request("session/prompt", { sessionId, content })');
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(contentIndex).toBeGreaterThan(promptIndex);
  });

  it("filters Kiro extension notifications instead of dumping full tool lists", () => {
    const { command } = kiroAdapter.runNew(BASE);
    expect(command).toContain('method === "_kiro.dev/session/update"');
    expect(command).toContain('method === "_kiro.dev/metadata"');
    expect(command).toContain("kiro_metadata");
    expect(command).not.toContain("kiro_extension");
  });

  it("runNew(review) emits ACP wrapper without trust-all-tools", () => {
    const { command } = kiroAdapter.runNew({ ...BASE, role: "review" });
    expect(command).toContain("kiro-cli");
    expect(command).toContain('"acp"');
    expect(command).toContain("session/prompt");
    expect(command).toContain("'0'");
    expect(command).toContain("'review'");
    expect(command).toContain('writeTextFile: role !== "review"');
    expect(command).toContain("review role may run checks but must not write files");
    expect(command).toContain("kiro review modified tracked files; review may run checks but must not edit code");
  });

  it("runNew honours explicit trustAllTools=false on a worker role", () => {
    const { command } = kiroAdapter.runNew({ ...BASE, trustAllTools: false });
    expect(command).toContain("const trustAllTools = process.argv[4] === \"1\"");
    expect(command).toContain("'0'");
  });

  it("runNew(work) passes the work role into the ACP client", () => {
    const { command } = kiroAdapter.runNew(BASE);
    expect(command).toContain("'work'");
  });

  it("runResume(work) loads the exact previous ACP session id", () => {
    const { command } = kiroAdapter.runResume({
      ...BASE,
      sessionId: "sess_kiro_123"
    });
    expect(command).toContain("session/load");
    expect(command).toContain("'sess_kiro_123'");
    expect(command).not.toContain("--resume-id");
  });

  it("runResume(work) keeps an explicit model setting", () => {
    const { command } = kiroAdapter.runResume({
      ...BASE,
      model: "kiro-model-id",
      sessionId: "sess_kiro_123"
    });
    expect(command).toContain("'sess_kiro_123'");
    expect(command).toContain("'kiro-model-id'");
    expect(command).toContain('...(model ? ["--model", model] : [])');
  });

  it("runResume(review) throws AdapterUnsupported (reviewer role unsupported)", () => {
    expect(() =>
      kiroAdapter.runResume({
        ...BASE,
        role: "review",
        sessionId: "sess_kiro_123"
      })
    ).toThrow(AdapterUnsupported);
  });

  it("parseResult extracts session_id from ACP session export", () => {
    const stdout = [
      "kiro output",
      "__TYCHONIC_KIRO_SESSION_START__",
      JSON.stringify({ session_id: "sess_kiro_123" }),
      "__TYCHONIC_KIRO_SESSION_END__"
    ].join("\n");
    expect(kiroAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "sess_kiro_123"
    });
  });

  it("parseResult returns empty when no ACP export is present", () => {
    expect(kiroAdapter.parseResult("Chat SessionId: abc-123\n", "", 0)).toEqual({});
    expect(kiroAdapter.parseResult("", "", 0)).toEqual({});
  });
});
