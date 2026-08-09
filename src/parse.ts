import { randomUUID } from "node:crypto"

export interface ParsedToolCall {
  toolCallId: string
  toolName: string
  /** JSON-stringified arguments, matching the tool's input schema. */
  input: string
  /** Original XML block text. */
  raw: string
}

const TOOL_BLOCK_RE = /<opencode:tool\s+name=["']([a-zA-Z0-9._:\-/]+)["']\s*>([\s\S]*?)<\/opencode:tool>/gi

/** Strip a surrounding markdown code fence, e.g. ```xml ... ```. */
export function stripCodeFence(content: string): string {
  const trimmed = content.trim()
  const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed)
  return fence ? fence[1]?.trim() ?? trimmed : trimmed
}

/**
 * Extract the first balanced JSON object from a string, tolerating surrounding
 * prose or code fences. Returns `undefined` when no balanced object is found.
 */
export function extractJSONObject(content: string): string | undefined {
  const start = content.indexOf("{")
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < content.length; i++) {
    const char = content[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) return content.slice(start, i + 1)
    }
  }
  return undefined
}

/**
 * Parse web-AI replies for `<opencode:tool name="...">...</opencode:tool>`
 * blocks and convert them into model tool calls.
 *
 * The content of each block is expected to be JSON. Blocks wrapped in markdown
 * code fences are tolerated.
 */
export function parseToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = []
  TOOL_BLOCK_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TOOL_BLOCK_RE.exec(text)) !== null) {
    const toolName = match[1]!
    let content = stripCodeFence(match[2] ?? "")

    let input: unknown
    try {
      input = JSON.parse(content)
    } catch {
      const extracted = extractJSONObject(content)
      if (extracted !== undefined) {
        try {
          input = JSON.parse(extracted)
          content = extracted
        } catch {
          input = undefined
        }
      } else {
        input = undefined
      }
    }

    let inputString: string
    if (input === undefined) {
      inputString = JSON.stringify({ error: "unparseable tool input", raw: content })
    } else if (typeof input === "string") {
      // Possibly double-encoded JSON — decode once more if it parses.
      try {
        input = JSON.parse(input)
      } catch {
        // keep as-is
      }
      inputString = JSON.stringify(input)
    } else {
      inputString = JSON.stringify(input)
    }

    calls.push({
      toolCallId: randomUUID(),
      toolName,
      input: inputString,
      raw: match[0],
    })
  }
  return calls
}
