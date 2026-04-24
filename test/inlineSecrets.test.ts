import { describe, expect, it } from "vitest";
import { TychonicConfigSchema } from "../src/catalog/types.js";
import { assertNoInlineSecrets, findInlineSecrets } from "../src/security/inlineSecrets.js";

describe("inline secret guard", () => {
  it("detects literal token assignments and allows environment references", () => {
    expect(findInlineSecrets("env ANTHROPIC_AUTH_TOKEN=local claude --print")).toEqual([
      { key: "ANTHROPIC_AUTH_TOKEN", kind: "env_assignment" }
    ]);
    expect(findInlineSecrets("env 'ANTHROPIC_AUTH_TOKEN=local' claude --print")).toEqual([
      { key: "ANTHROPIC_AUTH_TOKEN", kind: "env_assignment" }
    ]);
    expect(findInlineSecrets('env "ANTHROPIC_AUTH_TOKEN=local" claude --print')).toEqual([
      { key: "ANTHROPIC_AUTH_TOKEN", kind: "env_assignment" }
    ]);
    expect(findInlineSecrets("env ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN claude --print")).toEqual([]);
    expect(findInlineSecrets("env 'ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN' claude --print")).toEqual([]);
    expect(findInlineSecrets("tool --api-key literal")).toEqual([{ key: "--api-key", kind: "flag" }]);
    expect(findInlineSecrets("tool --api-key $TOOL_API_KEY")).toEqual([]);
  });

  it("rejects inline secrets in configured activity commands", () => {
    expect(() =>
      TychonicConfigSchema.parse({
        version: "tychonic.config.v1",
        states: {
          work: {
            type: "work",
            command: "env ANTHROPIC_AUTH_TOKEN=local claude --print"
          }
        }
      })
    ).toThrow(/inline secret/);
  });

  it("throws a readable error for runtime command options", () => {
    expect(() => assertNoInlineSecrets("worker --password hunter2", "worker command")).toThrow(
      /worker command must not contain inline secret values/
    );
  });
});
