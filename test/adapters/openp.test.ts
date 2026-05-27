import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../../src/adapters/openp.js";
import type { AdapterRunInput } from "../../src/adapters/types.js";
import { FINDING_SEVERITIES } from "../../src/domain/types.js";

const BASE: AdapterRunInput = {
  prompt: "do the thing",
  worktreeCwd: "/tmp/wt",
  role: "work"
};

describe("openp shared adapter behavior", () => {
  it("runNew uses a resolved absolute OpenP executable when provided", () => {
    const { command } = claudeAdapter.runNew({
      ...BASE,
      executablePaths: { openp: "/opt/tychonic/bin/openp" }
    });
    expect(command).toContain("'/opt/tychonic/bin/openp' claude");
  });

  it("runNew passes explicit model and effort settings", () => {
    const { command } = claudeAdapter.runNew({
      ...BASE,
      model: "opus",
      reasoningEffort: "max"
    });
    expect(command).toContain("--model 'opus' --effort 'max'");
  });

  it("runResume keeps explicit model and effort settings", () => {
    const { command } = claudeAdapter.runResume({
      ...BASE,
      model: "opus",
      reasoningEffort: "max",
      sessionId: "sess-1"
    });
    expect(command).toContain("--model 'opus' --effort 'max'");
    expect(command).toContain("--resume 'sess-1'");
  });

  it("quotes resume session ids to prevent shell injection", () => {
    const { command } = claudeAdapter.runResume({
      ...BASE,
      sessionId: "abc'; echo unsafe #"
    });
    expect(command).toContain("--resume 'abc'\\''; echo unsafe #'");
  });

  it("review JSON schema covers the semantic review payload contract", () => {
    const { command } = claudeAdapter.runNew({ ...BASE, role: "review" });
    const schema = extractReviewJsonSchema(command);
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        status: { enum: ["pass", "fail"] },
        summary: { type: "string", minLength: 1 },
        findings: { type: "array" }
      },
      required: ["status", "summary", "findings"]
    });
    const properties = schema.properties as Record<string, unknown>;
    expect(properties).not.toHaveProperty("schema_version");

    const findings = properties.findings as Record<string, unknown>;
    const findingItems = findings.items as Record<string, unknown>;
    expect(findingItems).toMatchObject({
      additionalProperties: false,
      properties: {
        severity: { enum: FINDING_SEVERITIES },
        title: { type: "string", minLength: 1 },
        detail: { type: "string", minLength: 1 },
        target: {
          anyOf: [{ type: "string", minLength: 1 }, { type: "null" }]
        },
        target_session_id: {
          anyOf: [{ type: "string", minLength: 1 }, { type: "null" }]
        }
      },
      required: ["severity", "title", "detail", "target", "target_session_id"]
    });
    expect(String(findings.description)).toContain("Actionable problems only");
    expect(String(findingItems.description)).toContain("One actionable problem");
  });
});

describe("openp shared parseResult", () => {
  it("extracts sessionId and reportedModel from OpenP result records", () => {
    const stdout = [
      openpStreamingAnswerLine(
        "11111111-2222-3333-4444-555555555555",
        "starting",
        { model: "requested-model" }
      ),
      openpResultLine(
        "11111111-2222-3333-4444-555555555555",
        ["done"],
        { model: "claude-opus-4-7" }
      )
    ].join("\n");
    expect(claudeAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "11111111-2222-3333-4444-555555555555",
      reportedModel: "claude-opus-4-7"
    });
  });

  it("uses the terminal active result record for reportedModel", () => {
    const stdout = [
      openpResultLine("session-1", ["intermediate"], { model: "wrong-intermediate-model" }),
      openpResultLine("session-1", ["final"], { model: "terminal-model" })
    ].join("\n");
    expect(claudeAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "session-1",
      reportedModel: "terminal-model"
    });
  });

  it("does not extract reportedModel from scope-less result records", () => {
    const stdout = openpResultLineWithoutScope("session-1", ["final"], { model: "scope-less-model" });
    expect(claudeAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "session-1"
    });
  });

  it("does not stop scanning before a long stream's terminal result", () => {
    const streamingLines = Array.from({ length: 160 }, (_, index) =>
      openpStreamingAnswerLine("session-1", `chunk ${index}`)
    );
    const stdout = [
      ...streamingLines,
      openpResultLine("session-1", ["final"], { model: "terminal-model-after-long-stream" })
    ].join("\n");
    expect(claudeAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "session-1",
      reportedModel: "terminal-model-after-long-stream"
    });
  });

  it("extracts sessionId from terminal result events", () => {
    const stdout = openpResultLine("019dce88-aff2-73c2-8acc-167810fd3280");
    expect(claudeAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "019dce88-aff2-73c2-8acc-167810fd3280"
    });
  });

  it("extracts sessionId from later non-init events", () => {
    const stdout = openpStreamingAnswerLine("deadbeef-1111", "hi");
    expect(claudeAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "deadbeef-1111"
    });
  });

  it("tolerates non-JSON noise before the JSONL stream", () => {
    const stdout = [
      "warning: telemetry disabled",
      "",
      openpResultLine("abc-123")
    ].join("\n");
    expect(claudeAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "abc-123"
    });
  });

  it("ignores legacy raw thread ids and top-level session_id fields", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "11111111-2222-3333-4444-555555555555" }),
      JSON.stringify({ type: "result", session_id: "legacy-session-id" })
    ].join("\n");
    expect(claudeAdapter.parseResult(stdout, "", 0)).toEqual({});
  });

  it("returns empty when no openp.sessionId is present", () => {
    expect(claudeAdapter.parseResult("", "", 0)).toEqual({});
    expect(claudeAdapter.parseResult("hello world\n", "", 0)).toEqual({});
    expect(claudeAdapter.parseResult(
      JSON.stringify({
        openp: {
          version: 1,
          form: "streaming",
          scope: "active",
          output: { answer: "hi" },
          structuredOutput: null,
          metadata: {}
        }
      }), "", 0
    )).toEqual({});
  });
});

function extractReviewJsonSchema(command: string): Record<string, unknown> {
  const match = /--json-schema '([^']+)'/.exec(command);
  if (!match?.[1]) {
    throw new Error(`expected --json-schema argument in command: ${command}`);
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function openpResultLine(
  sessionId: string,
  answer: string[] = [],
  metadata: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    openp: {
      version: 1,
      form: "result",
      scope: "active",
      sessionId,
      output: { answer, reasoning: [], toolCall: [], toolResult: [] },
      structuredOutput: null,
      metadata
    }
  });
}

function openpResultLineWithoutScope(
  sessionId: string,
  answer: string[] = [],
  metadata: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    openp: {
      version: 1,
      form: "result",
      sessionId,
      output: { answer, reasoning: [], toolCall: [], toolResult: [] },
      structuredOutput: null,
      metadata
    }
  });
}

function openpStreamingAnswerLine(
  sessionId: string,
  answer: string,
  metadata: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    openp: {
      version: 1,
      form: "streaming",
      scope: "active",
      sessionId,
      output: { answer },
      structuredOutput: null,
      metadata
    }
  });
}
