import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../../src/adapters/claude.js";
import type { AdapterRunInput } from "../../src/adapters/types.js";

const BASE: AdapterRunInput = {
  prompt: "do the thing",
  worktreeCwd: "/tmp/wt",
  role: "work"
};

describe("claudeAdapter", () => {
  it("name is claude", () => {
    expect(claudeAdapter.name).toBe("claude");
  });

  it("runNew(work) emits stream-json + acceptEdits permission mode", () => {
    const { command } = claudeAdapter.runNew(BASE);
    expect(command).toBe(
      "claude -p --output-format stream-json --verbose --permission-mode acceptEdits"
    );
  });

  it("runNew(review) flips permission mode to plan", () => {
    const { command } = claudeAdapter.runNew({ ...BASE, role: "review" });
    expect(command).toContain("--permission-mode plan");
    expect(command).toContain("--tools Read,Grep,Glob");
    expect(command).toContain("--json-schema");
    expect(command).not.toContain("tychonic.review.v1");
  });

  it("runNew(review) embeds a schema for semantic review payloads only", () => {
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
    expect(objectField(schema, "properties")).not.toHaveProperty("schema_version");
    expect(schema).not.toHaveProperty("oneOf");
    expect(schema).not.toHaveProperty("allOf");
    expect(schema).not.toHaveProperty("anyOf");

    const properties = objectField(schema, "properties");
    const findings = objectField(properties, "findings");
    const findingItems = objectField(findings, "items");
    expect(findingItems).toMatchObject({
      additionalProperties: false,
      properties: {
        severity: { enum: ["critical", "high", "medium", "low"] },
        title: { type: "string", minLength: 1 },
        detail: { type: "string", minLength: 1 },
        target: { type: "string", minLength: 1 },
        target_session_id: { type: "string" }
      },
      required: ["severity", "title", "detail"]
    });
  });

  it("runNew honours an explicit permissionMode override", () => {
    const { command } = claudeAdapter.runNew({
      ...BASE,
      permissionMode: "bypassPermissions"
    });
    expect(command).toContain("--permission-mode bypassPermissions");
    expect(command).not.toContain("acceptEdits");
  });

  it("runResume appends --resume <session-id> to base args", () => {
    const { command } = claudeAdapter.runResume({
      ...BASE,
      sessionId: "11111111-2222-3333-4444-555555555555"
    });
    expect(command).toBe(
      "claude -p --output-format stream-json --verbose --permission-mode acceptEdits --resume 11111111-2222-3333-4444-555555555555"
    );
  });

  it("runResume(review) keeps role-specific permission mode", () => {
    const { command } = claudeAdapter.runResume({
      ...BASE,
      role: "review",
      sessionId: "abc"
    });
    expect(command).toContain("--permission-mode plan");
    expect(command).toContain("--tools Read,Grep,Glob");
    expect(command).toContain("--json-schema");
    expect(command).toContain("--resume abc");
  });

  it("parseResult extracts session_id from the system.init event", () => {
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "11111111-2222-3333-4444-555555555555",
        cwd: "/tmp/wt"
      }),
      JSON.stringify({ type: "assistant", message: { role: "assistant" } })
    ].join("\n");
    expect(claudeAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "11111111-2222-3333-4444-555555555555"
    });
  });

  it("parseResult tolerates non-JSON noise before the JSONL stream", () => {
    const stdout = [
      "warning: telemetry disabled",
      "",
      JSON.stringify({ type: "system", session_id: "abc-123" })
    ].join("\n");
    expect(claudeAdapter.parseResult(stdout, "", 0)).toEqual({
      sessionId: "abc-123"
    });
  });

  it("parseResult returns empty when no session_id is present", () => {
    expect(claudeAdapter.parseResult("hello world\n", "", 0)).toEqual({});
  });
});

function extractReviewJsonSchema(command: string): Record<string, unknown> {
  const match = /--json-schema '([^']+)'/.exec(command);
  if (!match?.[1]) {
    throw new Error(`expected --json-schema argument in command: ${command}`);
  }
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    throw new Error(`expected object field ${key}`);
  }
  return field as Record<string, unknown>;
}
