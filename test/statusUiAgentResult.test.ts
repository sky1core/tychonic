import { describe, expect, it } from "vitest";
import { extractAgentResult } from "../web-client/src/agentResult";

describe("status UI agent result extraction", () => {
  it("extracts Claude work result text from stream-json output", () => {
    const output = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "session_1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "draft" }] } }),
      JSON.stringify({ type: "result", result: "final worker answer" })
    ].join("\n");

    expect(extractAgentResult(output)).toBe("final worker answer");
  });

  it("extracts Claude structured review output from terminal result events", () => {
    const output = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "session_1" }),
      JSON.stringify({
        type: "result",
        result: "structured review emitted",
        structured_output: {
          status: "pass",
          summary: "structured review passed",
          findings: []
        }
      })
    ].join("\n");

    expect(extractAgentResult(output)).toBe("**Status:** pass\n\nstructured review passed\n\n**Findings:** none");
  });

  it("extracts Codex appended review last-message after JSONL events", () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_1" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            status: "fail",
            summary: "draft",
            findings: [{ severity: "low", title: "draft", detail: "not final" }]
          })
        }
      }),
      JSON.stringify({ type: "turn.completed" }),
      JSON.stringify({
        status: "pass",
        summary: "codex semantic review passed",
        findings: []
      })
    ].join("\n");

    expect(extractAgentResult(output)).toBe("**Status:** pass\n\ncodex semantic review passed\n\n**Findings:** none");
  });

  it("extracts pretty Codex appended review last-message after JSONL events", () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_1" }),
      JSON.stringify({ type: "turn.completed" }),
      JSON.stringify(
        {
          status: "pass",
          summary: "pretty codex semantic review passed",
          findings: []
        },
        null,
        2
      )
    ].join("\n");

    expect(extractAgentResult(output)).toBe(
      "**Status:** pass\n\npretty codex semantic review passed\n\n**Findings:** none"
    );
  });

  it("formats failed structured review findings as readable Markdown", () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_1" }),
      JSON.stringify({ type: "turn.completed" }),
      JSON.stringify({
        schema_version: "tychonic.review.v1",
        status: "fail",
        summary: "review found a real mismatch",
        findings: [
          {
            severity: "high",
            title: "Wrong file content",
            detail: "Expected exact text but found a different value.",
            target: "agent-review-fail.md"
          }
        ]
      })
    ].join("\n");

    expect(extractAgentResult(output)).toBe(
      [
        "**Status:** fail",
        "",
        "review found a real mismatch",
        "",
        "**Findings**",
        "- Severity: **high** - Wrong file content (agent-review-fail.md): Expected exact text but found a different value."
      ].join("\n")
    );
  });
});
