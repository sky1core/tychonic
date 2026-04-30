import { describe, expect, it } from "vitest";
import { codexAdapter } from "../../src/adapters/codex.js";
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

  it("runNew(work) emits workspace-write sandbox + approval=never", () => {
    const { command } = codexAdapter.runNew(BASE);
    expect(command).toContain("last_message=$(mktemp");
    expect(command).toContain(
      'codex -a never exec --skip-git-repo-check --json --sandbox workspace-write --output-last-message "$last_message" -'
    );
    expect(command).toContain('cat "$last_message"');
  });

  it("runNew passes explicit model and reasoning effort settings", () => {
    const { command } = codexAdapter.runNew({
      ...BASE,
      model: "gpt-5.5",
      reasoningEffort: "xhigh"
    });
    expect(command).toContain("codex -a never --model");
    expect(command).toContain("gpt-5.5");
    expect(command).toContain('model_reasoning_effort="xhigh"');
    expect(command).toContain('exec --skip-git-repo-check --json --sandbox workspace-write --output-last-message "$last_message" -');
  });

  it("runNew(review) keeps workspace-write so review checks can create temporary files", () => {
    const { command } = codexAdapter.runNew({ ...BASE, role: "review" });
    expect(command).toContain('review_schema=$(mktemp');
    expect(command).toContain(
      'codex -a never exec --skip-git-repo-check --json --sandbox workspace-write --output-schema "$review_schema" --output-last-message "$last_message" -'
    );
  });

  it("runNew(review) writes a semantic review output schema for Codex", () => {
    const { command } = codexAdapter.runNew({ ...BASE, role: "review" });
    const marker = "TYCHONIC_CODEX_REVIEW_SCHEMA";
    const lines = command.split("\n");
    const first = lines.findIndex((line) => line.includes("<<") && line.includes(marker));
    const second = lines.findIndex((line, index) => index > first && line.trim() === marker);
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    const schemaText = lines.slice(first + 1, second).join("\n");
    const schema = JSON.parse(schemaText.trim());
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["status", "summary", "findings"],
      properties: {
        status: { type: "string", enum: ["pass", "fail"] },
        summary: { type: "string" },
        findings: { type: "array" }
      }
    });
    expect(schema.properties).not.toHaveProperty("schema_version");
    expect(schema.properties.findings.items.required).toEqual(["severity", "title", "detail"]);
    expect(schema.properties.findings.items.properties).not.toHaveProperty("target");
  });

  it("runNew honours explicit sandbox + approval overrides", () => {
    const { command } = codexAdapter.runNew({
      ...BASE,
      sandbox: "danger-full-access",
      approval: "on-request"
    });
    expect(command).toContain("-a on-request");
    expect(command).toContain("--sandbox danger-full-access");
    expect(command).not.toContain("workspace-write");
  });

  it("runResume puts session id between sandbox and stdin marker", () => {
    const { command } = codexAdapter.runResume({
      ...BASE,
      sessionId: "11111111-2222-3333-4444-555555555555"
    });
    expect(command).toContain('codex -a never exec resume --skip-git-repo-check --json --output-last-message "$last_message"');
    expect(command).toContain("11111111-2222-3333-4444-555555555555");
  });

  it("runResume keeps explicit model and reasoning effort settings", () => {
    const { command } = codexAdapter.runResume({
      ...BASE,
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      sessionId: "11111111-2222-3333-4444-555555555555"
    });
    expect(command).toContain("codex -a never --model");
    expect(command).toContain("gpt-5.5");
    expect(command).toContain('model_reasoning_effort="xhigh"');
    expect(command).toContain('exec resume --skip-git-repo-check --json --output-last-message "$last_message"');
    expect(command).toContain("11111111-2222-3333-4444-555555555555");
  });

  it("runResume(review) omits sandbox because the current resume subcommand does not accept it", () => {
    const { command } = codexAdapter.runResume({
      ...BASE,
      role: "review",
      sessionId: "abc"
    });
    expect(command).not.toContain("--sandbox");
    expect(command).toContain(' resume --skip-git-repo-check --json --output-last-message "$last_message"');
    expect(command).toContain("abc");
  });

  it("quotes resume session ids because they come from external CLI output", () => {
    const { command } = codexAdapter.runResume({
      ...BASE,
      sessionId: "abc'; echo unsafe #"
    });
    expect(command).toContain("abc");
    expect(command).toContain("echo unsafe");
    expect(command).toContain("\\'\\''");
  });

  it("parseResult extracts thread_id from current thread.started event", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "019dce88-aff2-73c2-8acc-167810fd3280" }),
      JSON.stringify({ type: "turn.started" })
    ].join("\n");
    expect(codexAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "019dce88-aff2-73c2-8acc-167810fd3280"
    });
  });

  it("parseResult extracts session_id from a flat session_meta event", () => {
    const stdout = [
      JSON.stringify({ type: "session_meta", session_id: "deadbeef-1111" }),
      JSON.stringify({ type: "assistant_message", text: "hi" })
    ].join("\n");
    expect(codexAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "deadbeef-1111"
    });
  });

  it("parseResult extracts session_id from a nested session_configured event", () => {
    const stdout = [
      JSON.stringify({
        id: "evt-1",
        msg: {
          type: "session_configured",
          session_id: "11111111-2222-3333-4444-555555555555",
          model: "o3"
        }
      })
    ].join("\n");
    expect(codexAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "11111111-2222-3333-4444-555555555555"
    });
  });

  it("parseResult returns empty when no session id is present", () => {
    const stdout = JSON.stringify({ type: "assistant_message", text: "hi" });
    expect(codexAdapter.parseResult(stdout, "", 0)).toEqual({});
  });
});
