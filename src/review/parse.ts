import { parseReviewResult, type ReviewResult } from "./schema.js";

export function parseReviewOutput(output: string): ReviewResult | undefined {
  const candidates = collectReviewCandidates(output);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i];
    if (candidate === undefined) continue;
    const parsed = tryParseAsReview(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

const MAX_VISIT_DEPTH = 8;
const FENCED_BLOCK_PATTERN = /```(?:[A-Za-z0-9_+-]+)?\s*\n([\s\S]*?)\n```/g;

function collectReviewCandidates(output: string): string[] {
  const candidates: string[] = [];
  visit(output, 0, candidates);
  return candidates;
}

function visit(text: string, depth: number, out: string[]): void {
  if (depth > MAX_VISIT_DEPTH) return;
  const trimmed = text.trim();
  if (trimmed.length === 0) return;

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    out.push(trimmed);
    // Whole-output object may itself be an envelope (e.g., Gemini's
    // `{ response: "<stringified review JSON>", ... }`). Unwrap known
    // envelope text fields and recurse so the caller still sees the
    // inner review candidate.
    let parsedWhole: unknown;
    try {
      parsedWhole = JSON.parse(trimmed);
    } catch {
      parsedWhole = undefined;
    }
    if (parsedWhole !== undefined) {
      for (const inner of extractEnvelopeText(parsedWhole)) {
        visit(inner, depth + 1, out);
      }
    }
  }

  for (const match of text.matchAll(FENCED_BLOCK_PATTERN)) {
    const inner = match[1]?.trim();
    if (inner && inner.startsWith("{") && inner.endsWith("}")) {
      out.push(inner);
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const substring = trimmed.slice(firstBrace, lastBrace + 1);
    if (substring !== trimmed) out.push(substring);
  }

  for (const line of text.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine.startsWith("{") || !trimmedLine.endsWith("}")) continue;
    out.push(trimmedLine);
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedLine);
    } catch {
      continue;
    }
    for (const inner of extractEnvelopeText(parsed)) {
      visit(inner, depth + 1, out);
    }
  }
}

function extractEnvelopeText(value: unknown): string[] {
  const out: string[] = [];
  if (!value || typeof value !== "object") return out;
  const obj = value as Record<string, unknown>;

  // Codex exec --json stream: { type:"item.completed", item:{ type:"agent_message", text:"..." } }
  const item = obj.item;
  if (item && typeof item === "object") {
    const text = (item as Record<string, unknown>).text;
    if (typeof text === "string") out.push(text);
  }

  // Claude --output-format stream-json terminal line: { type:"result", result:"..." }
  if (typeof obj.result === "string") {
    out.push(obj.result);
  }

  // Claude --output-format stream-json assistant line:
  // { type:"assistant", message:{ content:[{ type:"text", text:"..." }, ...] } }
  const message = obj.message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      for (const entry of content) {
        if (entry && typeof entry === "object") {
          const text = (entry as Record<string, unknown>).text;
          if (typeof text === "string") out.push(text);
        }
      }
    }
  }

  // Generic fallback for single-object envelopes that carry { text: "..." }.
  if (typeof obj.text === "string") {
    out.push(obj.text);
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
