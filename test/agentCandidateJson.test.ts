import { describe, expect, it } from "vitest";
import { parseAgentCandidatesJSON } from "../src/cli/agentCandidateJson.js";

describe("parseAgentCandidatesJSON", () => {
  it("parses command-only worker candidates", () => {
    expect(
      parseAgentCandidatesJSON(
        JSON.stringify([
          {
            agent: "codex",
            command: "codex exec --json"
          },
          {
            agent: "local-worker",
            command: "node worker.js",
            resume_command: "node resume.js"
          }
        ]),
        "--worker-candidates-json"
      )
    ).toEqual([
      {
        agent: "codex",
        command: "codex exec --json"
      },
      {
        agent: "local-worker",
        command: "node worker.js",
        resumeCommand: "node resume.js"
      }
    ]);
  });

  it("rejects unsupported candidate shapes", () => {
    expect(() => parseAgentCandidatesJSON("{}", "--review-candidates-json")).toThrow(/must be a JSON array/);
    expect(() => parseAgentCandidatesJSON("[{}]", "--review-candidates-json")).toThrow(/agent must be/);
    expect(() =>
      parseAgentCandidatesJSON('[{"agent":"codex","unknown":true}]', "--review-candidates-json")
    ).toThrow(/unknown is not supported/);
    expect(() =>
      parseAgentCandidatesJSON(
        '[{"agent":"worker","resumeCommand":"a","resume_command":"b"}]',
        "--worker-candidates-json"
      )
    ).toThrow(/resumeCommand or resume_command, not both/);
  });
});
