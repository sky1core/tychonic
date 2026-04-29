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
    expect(command).toBe(
      "codex -a never exec --skip-git-repo-check --json --sandbox workspace-write -"
    );
  });

  it("runNew passes explicit model and reasoning effort settings", () => {
    const { command } = codexAdapter.runNew({
      ...BASE,
      model: "gpt-5.5",
      reasoningEffort: "xhigh"
    });
    expect(command).toBe(
      "codex -a never --model 'gpt-5.5' -c 'model_reasoning_effort=\"xhigh\"' exec --skip-git-repo-check --json --sandbox workspace-write -"
    );
  });

  it("runNew(review) flips sandbox to read-only", () => {
    const { command } = codexAdapter.runNew({ ...BASE, role: "review" });
    expect(command).toBe(
      "codex -a never exec --skip-git-repo-check --json --sandbox read-only -"
    );
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
    expect(command).toBe(
      "codex -a never exec resume --skip-git-repo-check --json '11111111-2222-3333-4444-555555555555' -"
    );
  });

  it("runResume keeps explicit model and reasoning effort settings", () => {
    const { command } = codexAdapter.runResume({
      ...BASE,
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      sessionId: "11111111-2222-3333-4444-555555555555"
    });
    expect(command).toBe(
      "codex -a never --model 'gpt-5.5' -c 'model_reasoning_effort=\"xhigh\"' exec resume --skip-git-repo-check --json '11111111-2222-3333-4444-555555555555' -"
    );
  });

  it("runResume(review) omits sandbox because the current resume subcommand does not accept it", () => {
    const { command } = codexAdapter.runResume({
      ...BASE,
      role: "review",
      sessionId: "abc"
    });
    expect(command).not.toContain("--sandbox");
    expect(command).toContain(" resume --skip-git-repo-check --json 'abc' -");
  });

  it("quotes resume session ids because they come from external CLI output", () => {
    const { command } = codexAdapter.runResume({
      ...BASE,
      sessionId: "abc'; echo unsafe #"
    });
    expect(command).toContain("--json 'abc'\\''; echo unsafe #' -");
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
