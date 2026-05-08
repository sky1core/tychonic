import { parseBuiltInReviewOutput, parseReviewOutput } from "../../review/parse.js";
import type { ContractCheck } from "./types.js";

const wirePass = `{"schema_version":"tychonic.review.v1","status":"pass","summary":"ok","findings":[]}`;
const semanticPass = `{"status":"pass","summary":"ok","findings":[]}`;

export const reviewContractChecks: readonly ContractCheck[] = [
  {
    area: "review",
    name: "command review parser accepts only a whole wire object",
    run() {
      const parsed = parseReviewOutput(wirePass);
      if (parsed?.status !== "pass") {
        throw new Error("wire review object was not accepted");
      }
    }
  },
  {
    area: "review",
    name: "command review parser rejects semantic-only objects",
    run() {
      if (parseReviewOutput(semanticPass) !== undefined) {
        throw new Error("semantic-only review object was accepted by command parser");
      }
    }
  },
  {
    area: "review",
    name: "command review parser rejects unknown wire fields",
    run() {
      const extraTopLevel = `{"schema_version":"tychonic.review.v1","status":"pass","summary":"ok","findings":[],"verdict":"approve"}`;
      const extraFinding = `{"schema_version":"tychonic.review.v1","status":"fail","summary":"bad","findings":[{"severity":"low","title":"t","detail":"d","extra":"x"}]}`;
      if (parseReviewOutput(extraTopLevel) !== undefined) {
        throw new Error("review wire object with an unknown top-level field was accepted");
      }
      if (parseReviewOutput(extraFinding) !== undefined) {
        throw new Error("review wire object with an unknown finding field was accepted");
      }
    }
  },
  {
    area: "review",
    name: "command review parser rejects JSONL streams",
    run() {
      const stream = [
        `{"type":"item.completed","item":{"type":"agent_message","text":${JSON.stringify(wirePass)}}}`,
        `{"type":"turn.completed"}`
      ].join("\n");
      if (parseReviewOutput(stream) !== undefined) {
        throw new Error("JSONL review stream was accepted by command parser");
      }
    }
  },
  {
    area: "review",
    name: "built-in parser unwraps documented adapter envelopes",
    run() {
      const stream = [
        `{"type":"item.completed","item":{"type":"agent_message","text":${JSON.stringify(semanticPass)}}}`,
        `{"type":"turn.completed"}`
      ].join("\n");
      const parsed = parseBuiltInReviewOutput(stream);
      if (parsed?.schema_version !== "tychonic.review.v1" || parsed.status !== "pass") {
        throw new Error("built-in adapter envelope was not normalized");
      }
    }
  },
  {
    area: "review",
    name: "built-in parser rejects bare semantic JSON outside documented envelopes",
    run() {
      const stream = [
        `{"type":"thread.started"}`,
        `{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"unterminated`,
        semanticPass
      ].join("\n");
      if (parseBuiltInReviewOutput(stream) !== undefined) {
        throw new Error("bare semantic review JSON outside documented envelopes was accepted");
      }
    }
  }
] as const;
