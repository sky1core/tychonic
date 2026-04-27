import { describe, expect, it } from "vitest";
import { parseReviewOutput } from "../src/review/parse.js";

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

  it("parses a pretty-printed review JSON object", () => {
    const parsed = parseReviewOutput(JSON.stringify(JSON.parse(failReview), null, 2));
    expect(parsed?.status).toBe("fail");
  });

  it("rejects JSON embedded between noise lines", () => {
    expect(parseReviewOutput(`noise line\n${failReview}\ntrailing noise`)).toBeUndefined();
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

  it("rejects plain text", () => {
    expect(parseReviewOutput("High: missing verification\nDetail: tests are not run")).toBeUndefined();
  });

  it("rejects empty output", () => {
    expect(parseReviewOutput("")).toBeUndefined();
    expect(parseReviewOutput("   \n\n ")).toBeUndefined();
  });
});

describe("parseReviewOutput — codex exec --json stream envelope", () => {
  it("unwraps a terminal item.completed/agent_message containing raw review JSON", () => {
    const stream = [
      `{"type":"thread.started","thread_id":"t"}`,
      `{"type":"turn.started"}`,
      `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"thinking out loud"}}`,
      `{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":${JSON.stringify(passReview)}}}`,
      `{"type":"turn.completed","usage":{"input_tokens":1}}`
    ].join("\n");
    const parsed = parseReviewOutput(stream);
    expect(parsed?.status).toBe("pass");
  });

  it("selects the LAST agent_message when earlier ones contain non-matching JSON", () => {
    const earlier = `{"schema_version":"tychonic.review.v1","status":"fail","summary":"draft","findings":[{"severity":"low","title":"x","detail":"y","target":"z"}]}`;
    const stream = [
      `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":${JSON.stringify(earlier)}}}`,
      `{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":${JSON.stringify(passReview)}}}`,
      `{"type":"turn.completed"}`
    ].join("\n");
    const parsed = parseReviewOutput(stream);
    expect(parsed?.status).toBe("pass");
    expect(parsed?.findings).toEqual([]);
  });

  it("rejects review JSON wrapped in a fenced code block inside agent_message", () => {
    const fenced = "Here is the review:\n\n```json\n" + failReview + "\n```\n";
    const stream = [
      `{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":${JSON.stringify(fenced)}}}`,
      `{"type":"turn.completed"}`
    ].join("\n");
    expect(parseReviewOutput(stream)).toBeUndefined();
  });

  it("returns undefined when no agent_message contains a conforming review", () => {
    const stream = [
      `{"type":"thread.started","thread_id":"t"}`,
      `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"i looked at the code"}}`,
      `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls"}}`,
      `{"type":"turn.completed"}`
    ].join("\n");
    expect(parseReviewOutput(stream)).toBeUndefined();
  });

  it("ignores non-JSON adapter warning lines while still unwrapping documented codex envelopes", () => {
    const stream = [
      `2026-04-27T15:59:43.003779Z ERROR codex_core::session: failed to load skill /path/SKILL.md: invalid YAML`,
      `{"type":"thread.started","thread_id":"t"}`,
      `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"checking"}}`,
      `{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":${JSON.stringify(passReview)}}}`,
      `{"type":"turn.completed"}`
    ].join("\n");
    const parsed = parseReviewOutput(stream);
    expect(parsed?.status).toBe("pass");
  });

});

describe("parseReviewOutput — gemini envelope is not unwrapped", () => {
  it("does not treat gemini --output-format json as a built-in reviewer contract", () => {
    // SPEC §structured-review: only `codex` and `claude` emit
    // `tychonic.review.v1` by default. A real gemini --output-format json
    // object has `{ response: "<stringified review>", ... }`. The parser
    // must NOT unwrap that envelope; if an operator wants gemini as a
    // reviewer they must emit the contract directly.
    const geminiLike = JSON.stringify({
      session_id: "sess_test",
      response: passReview,
      stats: { models: { "gemini-test": {} } }
    });
    expect(parseReviewOutput(geminiLike)).toBeUndefined();
  });
});

describe("parseReviewOutput — claude --print --output-format stream-json", () => {
  it("unwraps the final result field containing raw review JSON", () => {
    const stream = [
      `{"type":"system","subtype":"init","session_id":"s1","model":"claude-opus-4-7"}`,
      `{"type":"assistant","message":{"id":"msg_1","role":"assistant","content":[{"type":"text","text":"let me check"}]}}`,
      `{"type":"assistant","message":{"id":"msg_2","role":"assistant","content":[{"type":"text","text":"found nothing"}]}}`,
      `{"type":"result","subtype":"success","is_error":false,"duration_ms":12,"result":${JSON.stringify(passReview)},"session_id":"s1"}`
    ].join("\n");
    const parsed = parseReviewOutput(stream);
    expect(parsed?.status).toBe("pass");
  });

  it("rejects a result field with fenced code block around review JSON", () => {
    const fenced = "Summary of review:\n\n```json\n" + failReview + "\n```";
    const stream = [
      `{"type":"system","subtype":"init","session_id":"s1"}`,
      `{"type":"result","subtype":"success","result":${JSON.stringify(fenced)},"session_id":"s1"}`
    ].join("\n");
    expect(parseReviewOutput(stream)).toBeUndefined();
  });

  it("rejects assistant.message.content text when result field is absent", () => {
    const stream = [
      `{"type":"system","subtype":"init","session_id":"s1"}`,
      `{"type":"assistant","message":{"id":"m","role":"assistant","content":[{"type":"text","text":${JSON.stringify(passReview)}}]}}`
    ].join("\n");
    expect(parseReviewOutput(stream)).toBeUndefined();
  });

  it("selects the LAST terminal result over earlier terminal results", () => {
    const earlier = `{"schema_version":"tychonic.review.v1","status":"fail","summary":"early","findings":[{"severity":"low","title":"x","detail":"y","target":"z"}]}`;
    const stream = [
      `{"type":"system","subtype":"init","session_id":"s1"}`,
      `{"type":"result","subtype":"success","result":${JSON.stringify(earlier)},"session_id":"s1"}`,
      `{"type":"result","subtype":"success","result":${JSON.stringify(passReview)},"session_id":"s1"}`
    ].join("\n");
    const parsed = parseReviewOutput(stream);
    expect(parsed?.status).toBe("pass");
  });

  it("returns undefined for a stream that never emits a conforming review", () => {
    const stream = [
      `{"type":"system","subtype":"init","session_id":"s1"}`,
      `{"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"i am working on it"}]}}`,
      `{"type":"result","subtype":"success","result":"looked good to me","session_id":"s1"}`
    ].join("\n");
    expect(parseReviewOutput(stream)).toBeUndefined();
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
