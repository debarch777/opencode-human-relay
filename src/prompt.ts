import type {
  JSONSchema7,
  LanguageModelV3CallOptions,
  LanguageModelV3FilePart,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3ReasoningPart,
  LanguageModelV3TextPart,
  LanguageModelV3ToolApprovalResponsePart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider"
import type { ResolvedConfig } from "./config.js"
import { prettyJSON } from "./util.js"

type Part = LanguageModelV3TextPart | LanguageModelV3FilePart | LanguageModelV3ReasoningPart | LanguageModelV3ToolCallPart | LanguageModelV3ToolResultPart | LanguageModelV3ToolApprovalResponsePart

/** Strip any [human-relay] banner lines from an assistant text part. */
function stripBanner(text: string, marker: string): string {
  if (!marker) return text
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(marker))
    .join("\n")
}

function renderFilePart(part: LanguageModelV3FilePart): string {
  const { data } = part
  let label = part.filename ?? "attachment"
  if (data instanceof URL || (typeof data === "string" && /^https?:\/\//.test(data))) {
    return `[attachment: ${label} — ${data instanceof URL ? data.href : data}]`
  }
  return `[attachment: ${label} — local file contents omitted for the web model]`
}

function renderPart(part: Part, config: ResolvedConfig): string {
  switch (part.type) {
    case "text":
      return part.text
    case "file":
      return renderFilePart(part)
    case "reasoning":
      return ""
    case "tool-call": {
      const input = toJSONString(part.input)
      return `<opencode:tool name="${escapeAttr(part.toolName)}">\n${input}\n</opencode:tool>`
    }
    case "tool-result":
      return `Tool result (${part.toolName ?? "unknown"}, call ${part.toolCallId}):\n${renderToolOutput(part.output)}`
    case "tool-approval-response":
      return `Tool approval (${part.approvalId}): ${part.approved ? "approved" : "denied"}${
        part.reason ? ` — ${part.reason}` : ""
      }`
    default:
      return ""
  }
}

function renderToolOutput(output: unknown): string {
  if (output == null || typeof output !== "object") return String(output ?? "null")
  const o = output as { type?: string; value?: unknown; reason?: string }
  if (o.type === "text" && typeof o.value === "string") return o.value
  if (o.type === "json") return prettyJSON(o.value)
  if (o.type === "execution-denied") return `[execution denied${o.reason ? `: ${o.reason}` : ""}]`
  return prettyJSON(output)
}

function toJSONString(input: unknown): string {
  if (typeof input === "string") {
    try {
      return prettyJSON(JSON.parse(input))
    } catch {
      return JSON.stringify(input)
    }
  }
  return prettyJSON(input)
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;")
}

function renderMessage(message: LanguageModelV3Message, config: ResolvedConfig): string {
  switch (message.role) {
    case "system":
      return `# System\n${message.content}\n`
    case "user": {
      const parts = message.content
        .map((part) => renderPart(part as Part, config))
        .filter(Boolean)
        .join("\n")
      return `# User\n${parts}\n`
    }
    case "assistant": {
      const parts = message.content
        .map((part) => renderPart(part as Part, config))
        .filter(Boolean)
        .join("\n")
      return `# Assistant\n${parts}\n`
    }
    case "tool": {
      const parts = message.content
        .map((part) => renderPart(part as Part, config))
        .filter(Boolean)
        .join("\n")
      return `# Tool result\n${parts}\n`
    }
    default:
      return ""
  }
}

function renderTools(tools: Array<LanguageModelV3FunctionTool | { type: "provider"; name: string }>): string {
  const lines: string[] = []
  for (const tool of tools) {
    if (tool.type === "provider") {
      lines.push(`- ${tool.name} (provider tool)`)
      continue
    }
    const name = tool.name
    const description = tool.description ? ` — ${tool.description}` : ""
    lines.push(`- ${name}${description}`)
    const schema = tool.inputSchema as JSONSchema7 | undefined
    if (schema) {
      const props = schema.properties
      if (props && typeof props === "object") {
        const required = Array.isArray(schema.required) ? schema.required : []
        const propLines = Object.entries(props).map(([key, value]) => {
          const v = value as JSONSchema7
          const type = v.type ? String(v.type) : "any"
          const desc = typeof v.description === "string" ? ` — ${v.description}` : ""
          const req = required.includes(key) ? " (required)" : ""
          return `    - ${key}: ${type}${req}${desc}`
        })
        if (propLines.length > 0) {
          lines.push(`  Parameters:`)
          lines.push(...propLines)
        }
      } else {
        lines.push(`  Parameters (schema): ${JSON.stringify(schema)}`)
      }
    }
  }
  return lines.join("\n")
}

export interface RenderedPrompt {
  prompt: string
  messageCount: number
}

/**
 * Render a `LanguageModelV3CallOptions` into a single text prompt suitable for
 * pasting into a web AI (ChatGPT, Claude, Gemini, ...).
 */
export function renderPrompt(
  options: LanguageModelV3CallOptions,
  config: ResolvedConfig,
): RenderedPrompt {
  const sections: string[] = []

  if (config.relay.instruction) {
    sections.push(config.relay.instruction)
  }

  if (options.tools && options.tools.length > 0) {
    sections.push(`# Available tools\n${renderTools(options.tools as Array<LanguageModelV3FunctionTool | { type: "provider"; name: string }>)}`)
  }

  if (options.toolChoice && options.toolChoice.type === "none") {
    sections.push(`# Note\nTool use is disabled for this turn. Answer directly.`)
  }

  const messages = options.prompt ?? []
  const rendered = messages.map((message) => renderMessage(message, config)).filter(Boolean)
  if (rendered.length > 0) {
    sections.push(`# Conversation history\n${rendered.join("\n")}`)
  }

  if (sections.length === 0) {
    return { prompt: "", messageCount: 0 }
  }

  return { prompt: sections.join("\n\n"), messageCount: messages.length }
}

/** Build the transient waiting banner shown in the transcript while we wait. */
export function buildBanner(config: ResolvedConfig, effectiveMode: "clipboard" | "manual"): string {
  const marker = config.relay.bannerMarker
  if (effectiveMode === "clipboard") {
    return `${marker} Waiting for the web model's reply. It will be detected automatically when you copy it back to the clipboard.`
  }
  return `${marker} Waiting for the web model's reply. Run: opencode-human-relay paste`
}

/** Strip banner lines from a history assistant text. Used for testing/rendering. */
export { stripBanner }
