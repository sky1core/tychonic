import { parseReviewResult, type ReviewResult } from "./schema.js";

export function parseReviewOutput(output: string): ReviewResult | undefined {
  const candidates = collectReviewCandidates(output.trim());
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i];
    if (candidate === undefined) continue;
    const parsed = tryParseAsReview(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

function collectReviewCandidates(output: string): string[] {
  if (output.length === 0) {
    return [];
  }

  const wholeObject = parseJsonObjectLine(output);
  if (wholeObject !== undefined) {
    return [output, ...extractDocumentedEnvelopeCandidates(wholeObject)];
  }

  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 1) {
    return candidatesFromJsonLine(lines[0] ?? "");
  }

  const parsedLines: Array<{ line: string; parsed: Record<string, unknown> }> = [];
  let sawNonJsonLine = false;
  for (const line of lines) {
    const parsed = parseJsonObjectLine(line);
    if (parsed === undefined) {
      sawNonJsonLine = true;
      continue;
    }
    parsedLines.push({ line, parsed });
  }
  if (parsedLines.length === 0) return [];

  const candidates: string[] = [];
  for (const { line, parsed } of parsedLines) {
    if (!sawNonJsonLine) {
      candidates.push(line);
    }

    candidates.push(...extractDocumentedEnvelopeCandidates(parsed));
  }
  return candidates;
}

function candidatesFromJsonLine(line: string): string[] {
  const parsed = parseJsonObjectLine(line);
  if (parsed === undefined) return [];
  return [line, ...extractDocumentedEnvelopeCandidates(parsed)];
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

function extractDocumentedEnvelopeCandidates(value: Record<string, unknown>): string[] {
  const out: string[] = [];
  const obj = value as Record<string, unknown>;

  // Codex exec --json stream: { type:"item.completed", item:{ type:"agent_message", text:"..." } }
  if (obj.type === "item.completed") {
    const item = obj.item;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const itemObj = item as Record<string, unknown>;
      const text = itemObj.text;
      if (itemObj.type === "agent_message" && typeof text === "string") out.push(text.trim());
    }
  }

  // Claude --output-format stream-json terminal line: { type:"result", result:"..." }
  if (obj.type === "result") {
    const text = obj.result;
    if (typeof text === "string") out.push(text);
  }

  return out;
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
    return parseReviewResult(value);
  } catch {
    return undefined;
  }
}
