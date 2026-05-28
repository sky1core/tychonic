import { describe, expect, it } from "vitest";
import { extractAgentResult, primaryAgentResult } from "../web-client/src/agentResult";

describe("status UI agent result extraction", () => {
  it("extracts Claude work result text from stream-json output", () => {
    const output = [
      openpStreamingAnswerLine("session_1", "draft"),
      openpResultLine({ sessionId: "session_1", answer: "final worker answer" })
    ].join("\n");

    expect(extractAgentResult(output)).toBe("final worker answer");
  });

  it("ignores non-JSON prefix lines before OpenP terminal result output", () => {
    const output = [
      "warning: telemetry disabled",
      openpResultLine({ sessionId: "session_1", answer: "final answer after warning" })
    ].join("\n");

    expect(extractAgentResult(output)).toBe("final answer after warning");
  });

  it("does not format malformed command review output with non-JSON prefix lines", () => {
    const review = JSON.stringify({
      schema_version: "tychonic.review.v1",
      status: "pass",
      summary: "not an exact command review payload",
      findings: []
    });
    const output = ["warning: command wrote extra output", review].join("\n");

    expect(extractAgentResult(output)).toBe(output);
  });

  it("does not format semantic-only single JSON as a command review", () => {
    const output = JSON.stringify({
      status: "pass",
      summary: "missing command wire schema",
      findings: []
    });

    expect(extractAgentResult(output)).toBe(JSON.stringify(JSON.parse(output), null, 2));
  });

  it("does not format command review JSON that violates review invariants", () => {
    const output = JSON.stringify({
      schema_version: "tychonic.review.v1",
      status: "pass",
      summary: "pass results cannot contain findings",
      findings: [
        {
          severity: "low",
          title: "Non-empty finding",
          detail: "This object is malformed for a pass result."
        }
      ]
    });

    expect(extractAgentResult(output)).toBe(JSON.stringify(JSON.parse(output), null, 2));
  });

  it("formats exact command review wire JSON", () => {
    const output = JSON.stringify({
      schema_version: "tychonic.review.v1",
      status: "pass",
      summary: "command review passed",
      findings: []
    });

    expect(extractAgentResult(output)).toBe("**Status:** pass\n\ncommand review passed\n\n**Findings:** none");
  });

  it("does not format legacy structured_output envelopes as valid command reviews", () => {
    const output = JSON.stringify({
      type: "result",
      structured_output: {
        status: "pass",
        summary: "adapter envelope is not the command wire contract",
        findings: []
      }
    });

    expect(extractAgentResult(output)).toBe(JSON.stringify(JSON.parse(output), null, 2));
  });

  it("does not format legacy result-string envelopes as valid command reviews", () => {
    const output = JSON.stringify({
      type: "result",
      result: JSON.stringify({
        status: "pass",
        summary: "adapter result string is not the command wire contract",
        findings: []
      })
    });

    expect(extractAgentResult(output)).toBe(JSON.stringify(JSON.parse(output), null, 2));
  });

  it("does not treat scope-less OpenP result records as terminal results", () => {
    const output = openpResultLineWithoutScope({ sessionId: "session_1", answer: "final answer" });

    expect(extractAgentResult(output)).toBe(JSON.stringify(JSON.parse(output), null, 2));
  });

  it("extracts Claude structured review output from terminal result events", () => {
    const output = [
      openpResultLine({
        sessionId: "session_1",
        answer: "structured review emitted",
        structuredOutput: {
          status: "pass",
          summary: "structured review passed",
          findings: []
        }
      })
    ].join("\n");

    expect(extractAgentResult(output)).toBe("**Status:** pass\n\nstructured review passed\n\n**Findings:** none");
  });

  it("extracts OpenP Codex structured review output from terminal result events", () => {
    const output = [
      openpStreamingAnswerLine(
        "thread_1",
        JSON.stringify({
          status: "fail",
          summary: "draft",
          findings: [{ severity: "low", title: "draft", detail: "not final" }]
        })
      ),
      openpResultLine({
        sessionId: "thread_1",
        structuredOutput: {
          status: "pass",
          summary: "codex semantic review passed",
          findings: []
        }
      })
    ].join("\n");

    expect(extractAgentResult(output)).toBe("**Status:** pass\n\ncodex semantic review passed\n\n**Findings:** none");
  });

  it("extracts OpenP Codex review JSON from terminal result text", () => {
    const output = [
      openpResultLine({
        sessionId: "thread_1",
        answer: JSON.stringify({
          status: "pass",
          summary: "codex result text passed",
          findings: []
        })
      })
    ].join("\n");

    expect(extractAgentResult(output)).toBe(
      "**Status:** pass\n\ncodex result text passed\n\n**Findings:** none"
    );
  });

  it("extracts Codex item.completed text during streaming (no trailing object yet)", () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_1" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "agent_message",
          text: "I'm analyzing the code and will provide a review shortly."
        }
      })
    ].join("\n");

    expect(extractAgentResult(output)).toBe(
      "I'm analyzing the code and will provide a review shortly."
    );
  });

  it("leaves Codex item.completed structured review text unformatted during streaming", () => {
    const reviewText = JSON.stringify({
      status: "fail",
      summary: "partial review in progress",
      findings: [{ severity: "low", title: "progress", detail: "not final" }]
    });
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_1" }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "agent_message",
          text: reviewText
        }
      })
    ].join("\n");

    expect(extractAgentResult(output)).toBe(reviewText);
  });

  it("formats failed structured review findings as readable Markdown", () => {
    const output = [
      openpResultLine({
        sessionId: "thread_1",
        structuredOutput: {
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
        }
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

  it("formats OpenP nullable finding targets as absent", () => {
    const output = [
      openpResultLine({
        sessionId: "thread_1",
        structuredOutput: {
          status: "fail",
          summary: "review found an issue without a concrete target",
          findings: [
            {
              severity: "medium",
              title: "Missing validation",
              detail: "The review could not identify a specific file.",
              target: null,
              target_session_id: null
            }
          ]
        }
      })
    ].join("\n");

    expect(extractAgentResult(output)).toBe(
      [
        "**Status:** fail",
        "",
        "review found an issue without a concrete target",
        "",
        "**Findings**",
        "- Severity: **medium** - Missing validation: The review could not identify a specific file."
      ].join("\n")
    );
  });

  it("uses parsed review artifacts ahead of raw adapter event streams for the primary response", () => {
    const rawOutput = [
      openpResultLine({
        sessionId: "thread_1",
        answer: "raw adapter stream summary"
      })
    ].join("\n");
    const parsedOutput = JSON.stringify({
      schema_version: "tychonic.review.v1",
      status: "pass",
      summary: "parsed artifact summary",
      findings: []
    });

    expect(primaryAgentResult({
      parsedArtifactContent: parsedOutput,
      resultArtifactContent: rawOutput
    })).toBe("**Status:** pass\n\nparsed artifact summary\n\n**Findings:** none");
  });
});

function openpResultLine(input: {
  sessionId: string;
  answer?: string;
  structuredOutput?: unknown;
}): string {
  return JSON.stringify({
    openp: {
      version: 1,
      form: "result",
      scope: "active",
      sessionId: input.sessionId,
      output: {
        answer: input.answer && input.answer.length > 0 ? [input.answer] : [],
        reasoning: [],
        toolCall: [],
        toolResult: []
      },
      structuredOutput: input.structuredOutput ?? null,
      metadata: {}
    }
  });
}

function openpResultLineWithoutScope(input: {
  sessionId: string;
  answer?: string;
}): string {
  return JSON.stringify({
    openp: {
      version: 1,
      form: "result",
      sessionId: input.sessionId,
      output: {
        answer: input.answer && input.answer.length > 0 ? [input.answer] : [],
        reasoning: [],
        toolCall: [],
        toolResult: []
      },
      structuredOutput: null,
      metadata: {}
    }
  });
}

function openpStreamingAnswerLine(sessionId: string, answer: string): string {
  return JSON.stringify({
    openp: {
      version: 1,
      form: "streaming",
      scope: "active",
      sessionId,
      output: { answer },
      structuredOutput: null,
      metadata: {}
    }
  });
}
