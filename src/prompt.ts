import { randomUUID } from "node:crypto"
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
import type { RelayPromptMode, ResolvedConfig } from "./config.js"
import { prettyJSON, sha1 } from "./util.js"

type Part = LanguageModelV3TextPart | LanguageModelV3FilePart | LanguageModelV3ReasoningPart | LanguageModelV3ToolCallPart | LanguageModelV3ToolResultPart | LanguageModelV3ToolApprovalResponsePart
type ToolLike = LanguageModelV3FunctionTool | { type: "provider"; name: string }

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
    case "user":
      return `# User\n${renderParts(message.content, config, false)}\n`
    case "assistant":
      return `# Assistant\n${renderParts(message.content, config, true)}\n`
    case "tool":
      return `# Tool result\n${renderParts(message.content, config, false)}\n`
    default:
      return ""
  }
}

function renderParts(
  content: Array<unknown>,
  config: ResolvedConfig,
  stripBanners: boolean,
): string {
  return content
    .map((part) => {
      const p = part as Part
      if (stripBanners && p.type === "text") {
        return stripBanner(p.text, config.relay.bannerMarker)
      }
      return renderPart(p, config)
    })
    .filter(Boolean)
    .join("\n")
}

function renderTools(tools: ToolLike[]): string {
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
 * pasting into a web AI (ChatGPT, Claude, Gemini, ...). This is the `full`
 * form: instruction + tools + entire history.
 */
export function renderPrompt(
  options: LanguageModelV3CallOptions,
  config: ResolvedConfig,
): RenderedPrompt {
  const messages = options.prompt ?? []
  const prompt = [renderStaticBlock(options, config), renderHistorySection(messages, config)]
    .filter(Boolean)
    .join("\n\n")
  return { prompt, messageCount: messages.length }
}

/** The instruction + tools block that goes into the web chat once. */
function renderStaticBlock(options: LanguageModelV3CallOptions, config: ResolvedConfig): string {
  const sections: string[] = []

  if (config.relay.instruction) {
    sections.push(config.relay.instruction)
  }

  const tools = options.tools
  if (tools && tools.length > 0) {
    sections.push(`# Available tools\n${renderTools(tools as ToolLike[])}`)
  }

  if (options.toolChoice && options.toolChoice.type === "none") {
    sections.push(`# Note\nTool use is disabled for this turn. Answer directly.`)
  }

  return sections.join("\n\n")
}

/** Render the full message history as a `# Conversation history` section. */
function renderHistorySection(messages: LanguageModelV3Message[], config: ResolvedConfig): string {
  const rendered = messages.map((message) => renderMessage(message, config)).filter(Boolean)
  if (rendered.length === 0) return ""
  return `# Conversation history\n${rendered.join("\n")}`
}

/** Render only the new user/tool messages for a same-chat continuation. */
function renderDelta(messages: LanguageModelV3Message[], config: ResolvedConfig): string {
  const sections: string[] = []
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "tool") continue
    const rendered = renderMessage(message, config).trimEnd()
    if (rendered) sections.push(rendered)
  }
  return sections.join("\n\n")
}

/**
 * Stable fingerprint of the tool set. Two relays that both want to talk to the
 * web model about the same tools can share one web chat; a different tool set
 * forces a fresh conversation (and a fresh full prompt).
 */
export function conversationToolFingerprint(tools: ToolLike[]): string {
  const entries = (tools ?? []).map((tool) => {
    if (tool.type === "provider") return `provider:${tool.name}`
    return JSON.stringify({
      name: tool.name,
      description: tool.description ?? "",
      schema: tool.inputSchema ?? null,
    })
  })
  entries.sort()
  return sha1(entries.join("\n"))
}

/** Stable fingerprint of a message history (banner lines stripped). */
export function conversationFingerprint(
  messages: LanguageModelV3Message[],
  config: ResolvedConfig,
): string {
  return sha1(messages.map((m) => sha1(renderMessage(m, config))).join("\n"))
}

/**
 * State of a single web-chat conversation. The static block and history
 * fingerprints let later relays detect a continuation and render a delta.
 */
export interface RelayConversationState {
  /** Unique id for this web chat. Reused across continuations. */
  id: string
  /** SHA-1 of the tool set at the start of the conversation. */
  toolFingerprint: string
  /** SHA-1 of the full message history at the last relay. */
  fingerprint: string
  /** The instruction + tools block that was pasted first. */
  staticBlock: string
  /** Per-message fingerprints of the history at the last relay (prefix anchor). */
  history: string[]
  /** Set when the previous reply had a tool block that failed to parse. */
  needsFormatReminder: boolean
}

export interface RelayRenderResult {
  /** The exact prompt to paste into the web chat for this relay. */
  prompt: string
  messageCount: number
  /** True when this relay reuses an existing web chat and sends only a delta. */
  isContinuation: boolean
  /** The (new or updated) conversation state to record on the relay. */
  conversation: RelayConversationState
}

const CONTINUATION_NOTE = `### Continuation
This is a continuation of our conversation. Below are the new tool results and/or
user messages since your last reply. Respond exactly as before, using the format
from the initial instructions when calling tools.`

const FORMAT_REMINDER = `# Format reminder
Your previous reply contained a tool block that could not be parsed. When you
need to call a tool, output the exact block form and nothing else around it:

<opencode:tool name="TOOL_NAME">
{"json": "arguments"}
</opencode:tool>`

/**
 * Render the prompt for one relay. In `conversation` mode the instruction +
 * tools block is sent once per web chat and later relays for the same chat only
 * send the new tool results / user messages (the web model's own replies live
 * in the chat, not in the prompt). A format reminder is appended when the
 * previous reply failed to parse a tool block. In `full` mode every relay
 * re-sends the whole thing.
 */
export function renderRelayPrompt(
  options: LanguageModelV3CallOptions,
  config: ResolvedConfig,
  prev: RelayConversationState | undefined,
  promptModeOverride?: RelayPromptMode,
): RelayRenderResult {
  const messages = options.prompt ?? []
  const mode = promptModeOverride ?? config.relay.promptMode

  const fps = messages.map((m) => sha1(renderMessage(m, config)))
  const toolFp = conversationToolFingerprint((options.tools ?? []) as ToolLike[])
  const staticBlock = renderStaticBlock(options, config)

  const isContinuation =
    mode === "conversation" &&
    prev !== undefined &&
    prev.toolFingerprint === toolFp &&
    fps.length >= prev.history.length &&
    fps.slice(0, prev.history.length).every((f, i) => f === prev.history[i])

  if (!isContinuation) {
    return {
      prompt: [staticBlock, renderHistorySection(messages, config)].filter(Boolean).join("\n\n"),
      messageCount: messages.length,
      isContinuation: false,
      conversation: {
        id: randomUUID(),
        toolFingerprint: toolFp,
        fingerprint: conversationFingerprint(messages, config),
        staticBlock,
        history: fps,
        needsFormatReminder: false,
      },
    }
  }

  const anchor = prev!.history.length
  const extra = messages.slice(anchor)
  const sections: string[] = []
  const delta = renderDelta(extra, config)
  if (delta) sections.push(delta)
  if (prev!.needsFormatReminder) sections.push(FORMAT_REMINDER)
  if (sections.length === 0) sections.push("(No new information since your last reply.)")

  return {
    prompt: `${CONTINUATION_NOTE}\n\n${sections.join("\n\n")}`,
    messageCount: messages.length,
    isContinuation: true,
    conversation: {
      id: prev!.id,
      toolFingerprint: toolFp,
      fingerprint: conversationFingerprint(messages, config),
      staticBlock: prev!.staticBlock,
      history: fps,
      needsFormatReminder: false,
    },
  }
}

/** Build the transient waiting banner shown in the transcript while we wait. */
export function buildBanner(
  config: ResolvedConfig,
  effectiveMode: "clipboard" | "manual",
  isContinuation = false,
): string {
  const marker = config.relay.bannerMarker
  const suffix = isContinuation ? " (continuation of the same web chat)" : ""
  if (effectiveMode === "clipboard") {
    return `${marker} Waiting for the web model's reply. It will be detected automatically when you copy it back to the clipboard.${suffix}`
  }
  return `${marker} Waiting for the web model's reply. Run: opencode-human-relay paste${suffix}`
}

/** Strip banner lines from a history assistant text. Used for testing/rendering. */
export { stripBanner }
