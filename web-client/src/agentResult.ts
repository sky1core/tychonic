type JsonObject = Record<string, unknown>

export function extractAgentResult(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith("{")) return raw

  const trailingObject = parseTrailingObjectAfterLastAdapterEvent(trimmed)
  if (trailingObject) return formatReviewResult(trailingObject) ?? JSON.stringify(trailingObject, null, 2)

  const objects = parseJsonObjectLines(trimmed)
  if (objects.length > 0) {
    for (let index = objects.length - 1; index >= 0; index--) {
      const structured = objects[index].structured_output
      if (isJsonObject(structured) || Array.isArray(structured)) {
        return formatReviewResult(structured) ?? JSON.stringify(structured, null, 2)
      }
      const result = objects[index].result
      if (typeof result === "string") return formatJsonReviewText(result) ?? result
    }

    for (let index = objects.length - 1; index >= 0; index--) {
      const object = objects[index]
      if (!isAdapterEvent(object)) return formatReviewResult(object) ?? JSON.stringify(object, null, 2)
    }

    for (let index = objects.length - 1; index >= 0; index--) {
      const assistantText = assistantMessageText(objects[index])
      if (assistantText) return assistantText
    }
  }

  const singleObject = parseJsonObject(trimmed)
  return singleObject ? formatReviewResult(singleObject) ?? JSON.stringify(singleObject, null, 2) : raw
}

function parseJsonObjectLines(value: string): JsonObject[] {
  return value
    .split(/\r?\n/)
    .map((line) => parseJsonObject(line.trim()))
    .filter((object): object is JsonObject => object !== undefined)
}

function parseTrailingObjectAfterLastAdapterEvent(value: string): JsonObject | undefined {
  const lines = value.split(/\r?\n/)
  let lastAdapterEventIndex = -1
  for (let index = 0; index < lines.length; index++) {
    const object = parseJsonObject(lines[index].trim())
    if (object && isAdapterEvent(object)) {
      lastAdapterEventIndex = index
    }
  }
  if (lastAdapterEventIndex < 0 || lastAdapterEventIndex >= lines.length - 1) return undefined
  const trailing = lines.slice(lastAdapterEventIndex + 1).join("\n").trim()
  const object = parseJsonObject(trailing)
  return object && !isAdapterEvent(object) ? object : undefined
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

function isAdapterEvent(value: JsonObject): boolean {
  return typeof value.type === "string"
}

function formatJsonReviewText(value: string): string | undefined {
  const object = parseJsonObject(value.trim())
  return object ? formatReviewResult(object) : undefined
}

function formatReviewResult(value: unknown): string | undefined {
  if (!isJsonObject(value) || !isReviewResult(value)) return undefined

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
  severity: string
  title: string
  detail: string
  target?: string
}

type ReviewResult = JsonObject & {
  status: string
  summary: string
  findings: ReviewFinding[]
}

function isReviewResult(value: JsonObject): value is ReviewResult {
  if (typeof value.status !== "string" || typeof value.summary !== "string" || !Array.isArray(value.findings)) {
    return false
  }
  return value.findings.every(isReviewFinding)
}

function isReviewFinding(value: unknown): value is ReviewFinding {
  if (!isJsonObject(value)) return false
  const hasRequiredFields =
    typeof value.severity === "string" && typeof value.title === "string" && typeof value.detail === "string"
  const hasValidTarget = value.target === undefined || typeof value.target === "string"
  return hasRequiredFields && hasValidTarget
}

function assistantMessageText(value: JsonObject): string | undefined {
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
