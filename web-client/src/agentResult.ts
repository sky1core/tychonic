type JsonObject = Record<string, unknown>

const REVIEW_WIRE_SCHEMA_VERSION = "tychonic.review.v1"
const REVIEW_FINDING_SEVERITIES = ["critical", "high", "medium", "low"] as const

export function extractAgentResult(raw: string): string {
  const trimmed = raw.trim()

  const objects = parseJsonObjectLines(trimmed)
  if (objects.length > 0) {
    for (let index = objects.length - 1; index >= 0; index--) {
      const eventResult = formatEventResult(objects[index])
      if (eventResult) return eventResult
    }

    for (let index = objects.length - 1; index >= 0; index--) {
      const assistantText = assistantMessageText(objects[index]) ?? codexItemText(objects[index])
      if (assistantText) return assistantText
    }
  }

  const singleObject = parseJsonObject(trimmed)
  return singleObject
    ? formatEventResult(singleObject) ?? formatWireReviewResult(singleObject) ?? JSON.stringify(singleObject, null, 2)
    : raw
}

function parseJsonObjectLines(value: string): JsonObject[] {
  return value
    .split(/\r?\n/)
    .map((line) => parseJsonObject(line.trim()))
    .filter((object): object is JsonObject => object !== undefined)
}

function parseJsonObject(value: string): JsonObject | undefined {
  if (!value.startsWith("{") || !value.endsWith("}")) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isJsonObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function formatJsonReviewText(value: string): string | undefined {
  const object = parseJsonObject(value.trim())
  return object ? formatSemanticReviewResult(object) : undefined
}

function formatEventResult(value: JsonObject): string | undefined {
  const openp = openpPayload(value)
  if (openp) return formatOpenPResult(openp)
  return undefined
}

function formatOpenPResult(value: JsonObject): string | undefined {
  if (value.form !== "result" || value.scope !== "active") return undefined
  const structured = value.structuredOutput
  if (isJsonObject(structured) || Array.isArray(structured)) {
    return formatSemanticReviewResult(structured) ?? JSON.stringify(structured, null, 2)
  }
  const answer = openPAnswerText(value)
  if (answer !== undefined) return formatJsonReviewText(answer) ?? answer
  return undefined
}

function openPAnswerText(value: JsonObject): string | undefined {
  const output = value.output
  if (!isJsonObject(output)) return undefined
  const answer = output.answer
  if (!Array.isArray(answer)) return undefined
  return answer.filter((item): item is string => typeof item === "string" && item.length > 0).join("\n\n")
}

function formatWireReviewResult(value: unknown): string | undefined {
  const result = reviewResult(value, "wire")
  return result ? formatReviewMarkdown(result) : undefined
}

function formatSemanticReviewResult(value: unknown): string | undefined {
  const result = reviewResult(value, "semantic")
  return result ? formatReviewMarkdown(result) : undefined
}

function formatReviewMarkdown(value: ReviewResult): string {
  const lines = [`**Status:** ${value.status}`, "", value.summary]
  if (value.findings.length === 0) {
    lines.push("", "**Findings:** none")
    return lines.join("\n")
  }

  lines.push("", "**Findings**")
  for (const finding of value.findings) {
    const target = typeof finding.target === "string" && finding.target.length > 0 ? ` (${finding.target})` : ""
    lines.push(`- Severity: **${finding.severity}** - ${finding.title}${target}: ${finding.detail}`)
  }
  return lines.join("\n")
}

type ReviewFinding = {
  severity: (typeof REVIEW_FINDING_SEVERITIES)[number]
  title: string
  detail: string
  target?: string | null
  target_session_id?: string | null
}

type ReviewResult = JsonObject & {
  status: string
  summary: string
  findings: ReviewFinding[]
}

function reviewResult(value: unknown, mode: "wire" | "semantic"): ReviewResult | undefined {
  if (!isJsonObject(value)) return undefined
  if (!hasReviewTopLevelShape(value, mode)) return undefined
  if (typeof value.status !== "string" || !["pass", "fail"].includes(value.status)) return undefined
  if (typeof value.summary !== "string" || value.summary.length === 0) return undefined
  if (!Array.isArray(value.findings)) return undefined
  if (!value.findings.every((finding) => isReviewFinding(finding, mode))) return undefined
  if (value.status === "pass" && value.findings.length !== 0) return undefined
  if (value.status === "fail" && value.findings.length === 0) return undefined
  return value as ReviewResult
}

function hasReviewTopLevelShape(value: JsonObject, mode: "wire" | "semantic"): boolean {
  const keys = Object.keys(value)
  const hasSemanticKeys = keys.includes("status") && keys.includes("summary") && keys.includes("findings")
  if (!hasSemanticKeys) return false

  if (mode === "wire") {
    return (
      keys.length === 4 &&
      keys.includes("schema_version") &&
      value.schema_version === REVIEW_WIRE_SCHEMA_VERSION
    )
  }

  const hasSchemaVersion = keys.includes("schema_version")
  return (
    (keys.length === 3 || (keys.length === 4 && hasSchemaVersion)) &&
    (!hasSchemaVersion || value.schema_version === REVIEW_WIRE_SCHEMA_VERSION)
  )
}

function isReviewFinding(value: unknown, mode: "wire" | "semantic"): value is ReviewFinding {
  if (!isJsonObject(value)) return false
  const keys = Object.keys(value)
  const allowedKeys = ["severity", "title", "detail", "target", "target_session_id"]
  if (!keys.every((key) => allowedKeys.includes(key))) return false
  const hasRequiredFields =
    REVIEW_FINDING_SEVERITIES.includes(value.severity as (typeof REVIEW_FINDING_SEVERITIES)[number]) &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    typeof value.detail === "string" &&
    value.detail.length > 0
  const hasValidTarget =
    value.target === undefined ||
    typeof value.target === "string" ||
    (mode === "semantic" && value.target === null)
  const hasValidTargetSessionId =
    value.target_session_id === undefined ||
    typeof value.target_session_id === "string" ||
    (mode === "semantic" && value.target_session_id === null)
  return hasRequiredFields && hasValidTarget && hasValidTargetSessionId
}

function assistantMessageText(value: JsonObject): string | undefined {
  const openp = openpPayload(value)
  if (openp?.form === "streaming") {
    const output = openp.output
    if (isJsonObject(output) && typeof output.answer === "string") return output.answer
  }

  const message = value.message
  if (!isJsonObject(message)) return undefined
  const content = message.content
  if (!Array.isArray(content)) return undefined
  const textBlocks = content.filter(
    (block): block is { type: "text"; text: string } =>
      isJsonObject(block) && block.type === "text" && typeof block.text === "string",
  )
  return textBlocks.length > 0 ? textBlocks.map((block) => block.text).join("\n") : undefined
}

function openpPayload(value: JsonObject): JsonObject | undefined {
  const openp = value.openp
  return isJsonObject(openp) ? openp : undefined
}

function codexItemText(value: JsonObject): string | undefined {
  if (value.type !== "item.completed") return undefined
  const item = value.item
  if (!isJsonObject(item)) return undefined
  if (typeof item.text !== "string") return undefined
  return item.text
}
