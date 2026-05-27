import { parseReviewResult, type ReviewResult } from "./schema.js";

export function parseReviewOutput(output: string): ReviewResult | undefined {
  return tryParseAsReview(output.trim());
}

export function parseBuiltInReviewOutput(output: string): ReviewResult | undefined {
  const trimmed = output.trim();
  const terminalResult = extractBuiltInTerminalResult(trimmed);
  return terminalResult !== undefined ? tryParseAsBuiltInReview(terminalResult) : undefined;
}

function extractBuiltInTerminalResult(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  let terminalResult: string | undefined;
  for (const line of lines) {
    const parsed = parseJsonObjectLine(line);
    const openp = parsed ? openpRecord(parsed) : undefined;
    if (openp === undefined || !isOpenPResultRecord(openp)) continue;
    const structuredOutput = openp.structuredOutput;
    if (structuredOutput !== undefined && structuredOutput !== null) {
      terminalResult = JSON.stringify(structuredOutput);
      continue;
    }
    terminalResult = openPResultAnswerText(openp);
  }
  return terminalResult;
}

function isOpenPResultRecord(openp: Record<string, unknown>): boolean {
  return openp.form === "result" && openp.scope === "active";
}

function openPResultAnswerText(openp: Record<string, unknown>): string | undefined {
  const output = recordValue(openp.output);
  const answer = output?.answer;
  if (!Array.isArray(answer)) return undefined;
  return answer.filter((item): item is string => typeof item === "string" && item.length > 0).join("\n\n");
}

function parseJsonObjectLine(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith("{") || !line.endsWith("}")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

function openpRecord(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  return recordValue(obj.openp);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeBuiltInStructuredOutput(value: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeBuiltInReviewOptionalFields(value);
  if (value.schema_version !== undefined) {
    return normalized;
  }
  return {
    schema_version: "tychonic.review.v1",
    ...normalized
  };
}

function normalizeBuiltInReviewOptionalFields(value: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(value.findings)) {
    return value;
  }
  return {
    ...value,
    findings: value.findings.map((finding) => {
      if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
        return finding;
      }
      const out = { ...(finding as Record<string, unknown>) };
      if (out.target === null) {
        delete out.target;
      }
      if (out.target_session_id === null) {
        delete out.target_session_id;
      }
      return out;
    })
  };
}

function tryParseAsReview(candidate: string): ReviewResult | undefined {
  const trimmed = candidate.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  try {
    return parseReviewValue(value);
  } catch {
    return undefined;
  }
}

function tryParseAsBuiltInReview(candidate: string): ReviewResult | undefined {
  const parsed = parseJsonObjectLine(candidate.trim());
  if (parsed === undefined) return undefined;
  try {
    return parseReviewValue(normalizeBuiltInStructuredOutput(parsed));
  } catch {
    return undefined;
  }
}

function parseReviewValue(value: unknown): ReviewResult {
  return parseReviewResult(value);
}
