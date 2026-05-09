import { parseReviewResult, type ReviewResult } from "./schema.js";

export type BuiltInReviewOutputAdapter = "claude" | "codex";

export function parseReviewOutput(output: string): ReviewResult | undefined {
  return tryParseAsReview(output.trim());
}

export function parseBuiltInReviewOutput(
  output: string,
  adapter: BuiltInReviewOutputAdapter
): ReviewResult | undefined {
  const trimmed = output.trim();
  if (adapter === "codex") {
    const terminalLastMessage = extractBuiltInTrailingLastMessage(trimmed);
    return terminalLastMessage !== undefined ? tryParseAsBuiltInReview(terminalLastMessage) : undefined;
  }

  const terminalResult = extractBuiltInTerminalResult(trimmed);
  if (terminalResult !== undefined) {
    return tryParseAsBuiltInReview(terminalResult);
  }
  return undefined;
}

function extractBuiltInTrailingLastMessage(output: string): string | undefined {
  if (output.length === 0) return undefined;
  const lines = output.split(/\r?\n/);
  let lastAdapterEventIndex = -1;
  for (let index = 0; index < lines.length; index++) {
    const parsed = parseJsonObjectLine(lines[index]?.trim() ?? "");
    if (parsed !== undefined && isBuiltInAdapterEvent(parsed)) {
      lastAdapterEventIndex = index;
    }
  }
  if (lastAdapterEventIndex < 0) return undefined;

  const trailing = lines.slice(lastAdapterEventIndex + 1).join("\n").trim();
  return trailing.length > 0 ? trailing : undefined;
}

function extractBuiltInTerminalResult(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  let terminalResult: string | undefined;
  for (const line of lines) {
    const parsed = parseJsonObjectLine(line);
    if (parsed === undefined || parsed.type !== "result") continue;
    const structuredOutput = parsed.structured_output;
    if (structuredOutput && typeof structuredOutput === "object" && !Array.isArray(structuredOutput)) {
      terminalResult = JSON.stringify(structuredOutput);
      continue;
    }
    const text = parsed.result;
    terminalResult = typeof text === "string" ? text : undefined;
  }
  return terminalResult;
}

function isBuiltInAdapterEvent(value: Record<string, unknown>): boolean {
  return typeof value.type === "string";
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

function normalizeBuiltInStructuredOutput(value: Record<string, unknown>): Record<string, unknown> {
  if (value.schema_version !== undefined) {
    return value;
  }
  return {
    schema_version: "tychonic.review.v1",
    ...value
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
