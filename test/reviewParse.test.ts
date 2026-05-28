import { describe, expect, it } from "vitest";
import { parseBuiltInReviewOutput, parseReviewOutput } from "../src/review/parse.js";

const passReview = `{"schema_version":"tychonic.review.v1","status":"pass","summary":"ok","findings":[]}`;
const failReview = `{"schema_version":"tychonic.review.v1","status":"fail","summary":"one bug","findings":[{"severity":"high","title":"t","detail":"d","target":"src/x.ts"}]}`;

describe("parseReviewOutput — raw JSON", () => {
  it("parses a single pass-shaped JSON object", () => {
    const parsed = parseReviewOutput(passReview);
    expect(parsed?.status).toBe("pass");
    expect(parsed?.findings).toEqual([]);
  });

  it("parses a single fail-shaped JSON object", () => {
    const parsed = parseReviewOutput(failReview);
    expect(parsed?.status).toBe("fail");
    expect(parsed?.findings[0]?.title).toBe("t");
  });

  it("parses fail findings without target when the reviewer cannot identify a concrete file", () => {
    const noTarget = `{"schema_version":"tychonic.review.v1","status":"fail","summary":"one issue","findings":[{"severity":"medium","title":"unclear behavior","detail":"needs investigation"}]}`;
    const parsed = parseReviewOutput(noTarget);
    expect(parsed?.status).toBe("fail");
    expect(parsed?.findings[0]?.target).toBeUndefined();
  });

  it("rejects null optional fields on raw command reviewer output", () => {
    const rawNullTarget = `{"schema_version":"tychonic.review.v1","status":"fail","summary":"one issue","findings":[{"severity":"medium","title":"unclear behavior","detail":"needs investigation","target":null,"target_session_id":null}]}`;
    expect(parseReviewOutput(rawNullTarget)).toBeUndefined();
  });

  it("parses a pretty-printed review JSON object", () => {
    const parsed = parseReviewOutput(JSON.stringify(JSON.parse(failReview), null, 2));
    expect(parsed?.status).toBe("fail");
  });

  it("rejects JSON embedded between noise lines", () => {
    expect(parseReviewOutput(`noise line\n${failReview}\ntrailing noise`)).toBeUndefined();
  });

  it("rejects JSONL streams on the command/wire-only parser", () => {
    const stream = [
      failReview,
      `{"schema_version":"tychonic.review.v1","status":"pass","summary":"ok","findings":[]}`
    ].join("\n");
    expect(parseReviewOutput(stream)).toBeUndefined();
  });

  it("rejects pass result with non-empty findings", () => {
    const bad = `{"schema_version":"tychonic.review.v1","status":"pass","summary":"ok","findings":[{"severity":"low","title":"t","detail":"d","target":"x"}]}`;
    expect(parseReviewOutput(bad)).toBeUndefined();
  });

  it("rejects fail result with empty findings", () => {
    const bad = `{"schema_version":"tychonic.review.v1","status":"fail","summary":"ok","findings":[]}`;
    expect(parseReviewOutput(bad)).toBeUndefined();
  });

  it("rejects wrong schema_version", () => {
    const bad = passReview.replace("tychonic.review.v1", "tychonic.review.v2");
    expect(parseReviewOutput(bad)).toBeUndefined();
  });

  it("rejects raw semantic payload without schema_version", () => {
    const semanticOnly = `{"status":"pass","summary":"ok","findings":[]}`;
    expect(parseReviewOutput(semanticOnly)).toBeUndefined();
  });

  it("rejects unknown review wire fields instead of stripping them", () => {
    const extraTopLevel = `{"schema_version":"tychonic.review.v1","status":"pass","summary":"ok","findings":[],"verdict":"approve"}`;
    const extraFinding = `{"schema_version":"tychonic.review.v1","status":"fail","summary":"bad","findings":[{"severity":"low","title":"t","detail":"d","extra":"x"}]}`;

    expect(parseReviewOutput(extraTopLevel)).toBeUndefined();
    expect(parseReviewOutput(extraFinding)).toBeUndefined();
  });

  it("rejects built-in adapter envelopes on the command/wire-only parser", () => {
    const codexSemanticEnvelope = [
      openpStreamingAnswerLine({ sessionId: "t" }),
      openpStreamingAnswerLine({ sessionId: "t", answer: `{"status":"pass","summary":"ok","findings":[]}` }),
      openpResultLine({ sessionId: "t", answer: `{"status":"pass","summary":"ok","findings":[]}` })
    ].join("\n");
    const claudeSemanticEnvelope = openpResultLine({
      sessionId: "s1",
      answer: "ok",
      structuredOutput: { status: "pass", summary: "ok", findings: [] }
    });
    const claudeWireEnvelope = openpResultLine({ sessionId: "s1", answer: passReview });

    expect(parseReviewOutput(codexSemanticEnvelope)).toBeUndefined();
    expect(parseReviewOutput(claudeSemanticEnvelope)).toBeUndefined();
    expect(parseReviewOutput(claudeWireEnvelope)).toBeUndefined();
  });

  it("rejects plain text", () => {
    expect(parseReviewOutput("High: missing verification\nDetail: tests are not run")).toBeUndefined();
  });

  it("rejects empty output", () => {
    expect(parseReviewOutput("")).toBeUndefined();
    expect(parseReviewOutput("   \n\n ")).toBeUndefined();
  });
});

describe("parseBuiltInReviewOutput — OpenP codex stream-json envelope", () => {
  it("does not treat codex agent_message JSON as a review verdict", () => {
    const wireStream = [
      openpStreamingAnswerLine({ sessionId: "t" }),
      openpStreamingAnswerLine({ sessionId: "t", answer: "thinking out loud" }),
      openpStreamingAnswerLine({ sessionId: "t", answer: passReview })
    ].join("\n");
    const semanticPass = `{"status":"pass","summary":"semantic pass","findings":[]}`;
    const semanticStream = [
      openpStreamingAnswerLine({ sessionId: "t" }),
      openpStreamingAnswerLine({ sessionId: "t", answer: semanticPass })
    ].join("\n");

    expect(parseBuiltInReviewOutput(wireStream)).toBeUndefined();
    expect(parseBuiltInReviewOutput(semanticStream)).toBeUndefined();
  });

  it("does not select among multiple codex agent_message JSON objects", () => {
    const earlier = `{"schema_version":"tychonic.review.v1","status":"fail","summary":"draft","findings":[{"severity":"low","title":"x","detail":"y","target":"z"}]}`;
    const stream = [
      openpStreamingAnswerLine({ sessionId: "t", answer: earlier }),
      openpStreamingAnswerLine({ sessionId: "t", answer: passReview })
    ].join("\n");
    expect(parseBuiltInReviewOutput(stream)).toBeUndefined();
  });

  it("uses the terminal OpenP result over earlier assistant JSON", () => {
    const earlyProgress = `{"status":"fail","summary":"starting review...","findings":[{"severity":"low","title":"not final","detail":"progress message only"}]}`;
    const stream = [
      openpStreamingAnswerLine({ sessionId: "t" }),
      openpStreamingAnswerLine({ sessionId: "t", answer: earlyProgress }),
      openpResultLine({
        sessionId: "t",
        structuredOutput: { status: "pass", summary: "final review passed", findings: [] }
      })
    ].join("\n");

    const parsed = parseBuiltInReviewOutput(stream);
    expect(parsed?.schema_version).toBe("tychonic.review.v1");
    expect(parsed?.status).toBe("pass");
    expect(parsed?.summary).toBe("final review passed");
    expect(parsed?.findings).toEqual([]);
  });

  it("normalizes OpenP structuredOutput null optional finding fields to absent", () => {
    const stream = [
      openpStreamingAnswerLine({ sessionId: "t" }),
      openpResultLine({
        sessionId: "t",
        structuredOutput: {
          status: "fail",
          summary: "one issue",
          findings: [
            {
              severity: "medium",
              title: "unclear behavior",
              detail: "needs investigation",
              target: null,
              target_session_id: null
            }
          ]
        }
      })
    ].join("\n");

    const parsed = parseBuiltInReviewOutput(stream);
    expect(parsed?.status).toBe("fail");
    expect(parsed?.findings[0]?.target).toBeUndefined();
    expect(parsed?.findings[0]?.target_session_id).toBeUndefined();
  });

  it("does not fall back to earlier assistant JSON when terminal result is invalid", () => {
    const earlyProgress = `{"status":"pass","summary":"not final","findings":[]}`;
    const stream = [
      openpStreamingAnswerLine({ sessionId: "t" }),
      openpStreamingAnswerLine({ sessionId: "t", answer: earlyProgress }),
      openpResultLine({
        sessionId: "t",
        structuredOutput: { status: "fail", summary: "invalid terminal review", findings: [] }
      })
    ].join("\n");

    expect(parseBuiltInReviewOutput(stream)).toBeUndefined();
  });

  it("does not fall back to result answer when non-null structuredOutput is invalid", () => {
    const stream = [
      openpStreamingAnswerLine({ sessionId: "t" }),
      openpResultLine({
        sessionId: "t",
        answer: `{"status":"pass","summary":"answer fallback","findings":[]}`,
        structuredOutput: []
      })
    ].join("\n");

    expect(parseBuiltInReviewOutput(stream)).toBeUndefined();
  });

  it("ignores review JSON wrapped in a fenced code block inside agent_message", () => {
    const fenced = "Here is the review:\n\n```json\n" + failReview + "\n```\n";
    const stream = [
      openpStreamingAnswerLine({ sessionId: "t", answer: fenced })
    ].join("\n");
    expect(parseBuiltInReviewOutput(stream)).toBeUndefined();
  });

  it("returns undefined when no OpenP terminal result exists", () => {
    const stream = [
      openpStreamingAnswerLine({ sessionId: "t" }),
      openpStreamingAnswerLine({ sessionId: "t", answer: "i looked at the code" })
    ].join("\n");
    expect(parseBuiltInReviewOutput(stream)).toBeUndefined();
  });

  it("accepts OpenP result events on the codex path", () => {
    const stream = [
      openpStreamingAnswerLine({ sessionId: "t" }),
      openpResultLine({
        sessionId: "t",
        answer: `{"status":"pass","summary":"openp result","findings":[]}`
      })
    ].join("\n");
    const parsed = parseBuiltInReviewOutput(stream);
    expect(parsed?.status).toBe("pass");
    expect(parsed?.summary).toBe("openp result");
  });

  it("rejects scope-less OpenP result events because terminal review verdicts must be active results", () => {
    const stream = openpResultLineWithoutScope({
      sessionId: "t",
      answer: `{"status":"pass","summary":"scope-less result","findings":[]}`
    });

    expect(parseBuiltInReviewOutput(stream)).toBeUndefined();
  });

  it("ignores non-JSON adapter warning lines before the OpenP terminal result", () => {
    const stream = [
      `2026-04-27T15:59:43.003779Z ERROR codex_core::session: failed to load skill /path/SKILL.md: invalid YAML`,
      openpStreamingAnswerLine({ sessionId: "t" }),
      openpStreamingAnswerLine({ sessionId: "t", answer: "checking" }),
      openpResultLine({
        sessionId: "t",
        answer: `{"status":"pass","summary":"terminal result passed","findings":[]}`
      })
    ].join("\n");
    const parsed = parseBuiltInReviewOutput(stream);
    expect(parsed?.status).toBe("pass");
    expect(parsed?.summary).toBe("terminal result passed");
  });

  it("rejects a bare semantic payload line after a malformed codex tool event", () => {
    const semanticPass = `{"status":"pass","summary":"last message file","findings":[]}`;
    const stream = [
      openpStreamingAnswerLine({ sessionId: "t" }),
      openpStreamingAnswerLine({ sessionId: "t", answer: "checking" }),
      `{"openp":{"version":1,"form":"streaming","scope":"active","sessionId":"t","output":{"answer":"unterminated`,
      semanticPass
    ].join("\n");
    expect(parseBuiltInReviewOutput(stream)).toBeUndefined();
  });
});

describe("parseBuiltInReviewOutput — OpenP claude stream-json envelope", () => {
  it("unwraps the final result field containing raw review JSON", () => {
    const stream = [
      openpStreamingAnswerLine({ sessionId: "s1", metadata: { model: "claude-opus-4-8" } }),
      openpStreamingAnswerLine({ sessionId: "s1", answer: "let me check" }),
      openpStreamingAnswerLine({ sessionId: "s1", answer: "found nothing" }),
      openpResultLine({ sessionId: "s1", answer: passReview })
    ].join("\n");
    const parsed = parseBuiltInReviewOutput(stream);
    expect(parsed?.status).toBe("pass");
  });

  it("unwraps the terminal structuredOutput object when result is prose", () => {
    const semanticFailReview = {
      status: "fail",
      summary: "one bug",
      findings: [{ severity: "high", title: "t", detail: "d" }]
    };
    const stream = [
      openpStreamingAnswerLine({ sessionId: "s1", metadata: { model: "claude-opus-4-8" } }),
      openpResultLine({
        sessionId: "s1",
        answer: "Reviewed the change and produced structured output.",
        structuredOutput: semanticFailReview
      })
    ].join("\n");
    const parsed = parseBuiltInReviewOutput(stream);
    expect(parsed?.schema_version).toBe("tychonic.review.v1");
    expect(parsed?.status).toBe("fail");
    expect(parsed?.findings[0]?.title).toBe("t");
    expect(parsed?.findings[0]?.target).toBeUndefined();
  });

  it("rejects structuredOutput that does not match the review contract", () => {
    const stream = [
      openpStreamingAnswerLine({ sessionId: "s1" }),
      openpResultLine({
        sessionId: "s1",
        answer: "looks fine",
        structuredOutput: {
          status: "pass",
          summary: "contradictory payload",
          findings: [{ severity: "low", title: "t", detail: "d" }]
        }
      })
    ].join("\n");
    expect(parseBuiltInReviewOutput(stream)).toBeUndefined();
  });

  it("rejects structuredOutput that supplies a wrong schema_version", () => {
    const stream = [
      openpStreamingAnswerLine({ sessionId: "s1" }),
      openpResultLine({
        sessionId: "s1",
        answer: "Reviewed the change and produced structured output.",
        structuredOutput: {
          schema_version: "tychonic.review.v2",
          status: "pass",
          summary: "wrong version",
          findings: []
        }
      })
    ].join("\n");
    expect(parseBuiltInReviewOutput(stream)).toBeUndefined();
  });

  it("rejects a result field with fenced code block around review JSON", () => {
    const fenced = "Summary of review:\n\n```json\n" + failReview + "\n```";
    const stream = [
      openpStreamingAnswerLine({ sessionId: "s1" }),
      openpResultLine({ sessionId: "s1", answer: fenced })
    ].join("\n");
    expect(parseBuiltInReviewOutput(stream)).toBeUndefined();
  });

  it("rejects streaming answer text when result field is absent", () => {
    const stream = [
      openpStreamingAnswerLine({ sessionId: "s1" }),
      openpStreamingAnswerLine({ sessionId: "s1", answer: passReview })
    ].join("\n");
    expect(parseBuiltInReviewOutput(stream)).toBeUndefined();
  });

  it("selects the LAST terminal result over earlier terminal results", () => {
    const earlier = `{"schema_version":"tychonic.review.v1","status":"fail","summary":"early","findings":[{"severity":"low","title":"x","detail":"y","target":"z"}]}`;
    const stream = [
      openpStreamingAnswerLine({ sessionId: "s1" }),
      openpResultLine({ sessionId: "s1", answer: earlier }),
      openpResultLine({ sessionId: "s1", answer: passReview })
    ].join("\n");
    const parsed = parseBuiltInReviewOutput(stream);
    expect(parsed?.status).toBe("pass");
  });

  it("returns undefined for a stream that never emits a conforming review", () => {
    const stream = [
      openpStreamingAnswerLine({ sessionId: "s1" }),
      openpStreamingAnswerLine({ sessionId: "s1", answer: "i am working on it" }),
      openpResultLine({ sessionId: "s1", answer: "looked good to me" })
    ].join("\n");
    expect(parseBuiltInReviewOutput(stream)).toBeUndefined();
  });
});

describe("parseReviewOutput — generic fenced code blocks", () => {
  it("rejects review JSON inside a ```json fenced block in otherwise plain text output", () => {
    const out = "Here is my review:\n\n```json\n" + passReview + "\n```\n\nDone.";
    expect(parseReviewOutput(out)).toBeUndefined();
  });

  it("rejects review JSON inside an unlabeled fenced block", () => {
    const out = "prefix\n```\n" + failReview + "\n```\nsuffix";
    expect(parseReviewOutput(out)).toBeUndefined();
  });
});

function openpResultLine(input: {
  sessionId: string;
  answer?: string;
  structuredOutput?: unknown;
  metadata?: Record<string, unknown>;
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
      metadata: input.metadata ?? {}
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

function openpStreamingAnswerLine(input: {
  sessionId: string;
  answer?: string;
  metadata?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    openp: {
      version: 1,
      form: "streaming",
      scope: "active",
      sessionId: input.sessionId,
      output: { answer: input.answer ?? "" },
      structuredOutput: null,
      metadata: input.metadata ?? {}
    }
  });
}
