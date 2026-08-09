import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider"
import type { RelayMode, RelayPromptMode, ResolvedConfig } from "./config.js"
import { buildBanner, renderRelayPrompt } from "./prompt.js"
import type { ParsedToolCall } from "./parse.js"
import { parseToolCalls } from "./parse.js"
import { sha1, writeClipboard } from "./util.js"
import { ensureClipboardWatcher, relayManager, startRelayBridge } from "./state.js"

const TOOL_BLOCK_REMOVE_RE = /<opencode:tool[\s\S]*?<\/opencode:tool>/gi

export function zeroUsage(): {
  inputTokens: { total: number | undefined; noCache: number | undefined; cacheRead: number | undefined; cacheWrite: number | undefined }
  outputTokens: { total: number | undefined; text: number | undefined; reasoning: number | undefined }
  raw: Record<string, never>
} {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
    raw: {},
  }
}

function stripToolBlocks(text: string): string {
  return text.replace(TOOL_BLOCK_REMOVE_RE, "").trim()
}

/** Chunk text into small deltas for a natural streaming feel. */
export function chunkText(text: string, size = 400): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size))
  }
  return chunks
}

export interface HumanRelayModelOptions {
  config: ResolvedConfig
}

/**
 * A `LanguageModelV3` that relays prompts to a human-in-the-loop: the prompt
 * is copied to the clipboard (or shown via the CLI), and the pasted reply from
 * a web AI (ChatGPT, Claude, ...) is returned as the model response. Tool calls
 * in the reply are parsed and surfaced to opencode's agent loop.
 */
export class HumanRelayModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const
  readonly provider: string
  readonly modelId: string
  readonly supportedUrls: Record<string, RegExp[]> = {}

  constructor(private readonly config: ResolvedConfig) {
    this.provider = config.name
    this.modelId = config.modelId
  }

  private perCallOptions(options: LanguageModelV3CallOptions): {
    mode: RelayMode
    autoCopy: boolean
    promptMode: RelayPromptMode
  } {
    const po = providerOptions(options, this.config.name)
    const relayCfg = this.config.relay
    const nested = po && typeof po.relay === "object" && po.relay !== null ? (po.relay as Record<string, unknown>) : undefined
    const overrideMode = po?.mode ?? nested?.mode
    const overrideAutoCopy = po && typeof po.autoCopy === "boolean" ? po.autoCopy : nested && typeof nested.autoCopy === "boolean" ? nested.autoCopy : undefined
    const overridePromptMode = po?.promptMode ?? nested?.promptMode
    const mode: RelayMode =
      overrideMode === "clipboard" || overrideMode === "manual" ? overrideMode : relayCfg.mode
    const autoCopy = overrideAutoCopy === undefined ? relayCfg.autoCopy : overrideAutoCopy
    const promptMode: RelayPromptMode =
      overridePromptMode === "conversation" || overridePromptMode === "full"
        ? overridePromptMode
        : relayCfg.promptMode
    return { mode, autoCopy, promptMode }
  }

  /** Create a relay for the given options, reusing an ongoing web chat when possible. */
  private beginRelay(options: LanguageModelV3CallOptions): {
    prompt: string
    isContinuation: boolean
    conversationId: string
    relay: { id: string; promise: Promise<string> }
  } {
    const { mode, autoCopy, promptMode } = this.perCallOptions(options)
    const rendered = renderRelayPrompt(options, this.config, relayManager.activeConversation, promptMode)
    relayManager.rememberConversation(rendered.conversation)
    const relay = relayManager.create({
      prompt: rendered.prompt,
      mode,
      fingerprint: sha1(rendered.prompt),
      conversationId: rendered.conversation.id,
      isContinuation: rendered.isContinuation,
    })

    startRelayBridge(this.config.relay)
    if (mode === "clipboard") {
      if (autoCopy) void tryCopyPrompt(rendered.prompt)
      ensureClipboardWatcher(this.config.relay.clipboardPollMs)
    }
    return {
      prompt: rendered.prompt,
      isContinuation: rendered.isContinuation,
      conversationId: rendered.conversation.id,
      relay,
    }
  }

  /** After a reply, flag the conversation when a tool block failed to parse. */
  private maybeMarkFormatFailure(
    text: string,
    calls: ParsedToolCall[],
    options: LanguageModelV3CallOptions,
    conversationId: string,
  ): void {
    const hasTools = (options.tools?.length ?? 0) > 0
    const toolChoiceNone = options.toolChoice?.type === "none"
    if (!hasTools || toolChoiceNone) return
    if (calls.length > 0) return
    if (!/<opencode:tool\b/i.test(text)) return
    relayManager.markFormatFailure(conversationId)
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { prompt, conversationId, relay } = this.beginRelay(options)

    try {
      const text = await relay.promise
      const calls = parseToolCalls(text)
      this.maybeMarkFormatFailure(text, calls, options, conversationId)
      const content: LanguageModelV3Content[] = []
      const cleanText = stripToolBlocks(text)
      if (cleanText) content.push({ type: "text", text: cleanText })
      for (const call of calls) {
        content.push({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        })
      }
      return {
        content,
        finishReason: { unified: calls.length > 0 ? "tool-calls" : "stop", raw: undefined },
        usage: zeroUsage(),
        warnings: [],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `[human-relay] ${String(err)}` }],
        finishReason: { unified: "error", raw: undefined },
        usage: zeroUsage(),
        warnings: [],
      }
    }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const { prompt, isContinuation, conversationId, relay } = this.beginRelay(options)
    const perCall = this.perCallOptions(options)

    const banner = this.config.relay.banner ? buildBanner(this.config, perCall.mode, isContinuation) : ""
    let clipboardNote = ""
    if (perCall.mode === "clipboard") {
      if (perCall.autoCopy) {
        try {
          await writeClipboard(prompt)
          clipboardNote = ` — prompt copied to clipboard`
        } catch {
          // no clipboard tool: fall back to manual instructions in the banner
          clipboardNote = ""
        }
      }
      ensureClipboardWatcher(this.config.relay.clipboardPollMs)
    }

    const bannerText = `${banner}${clipboardNote}`

    const markFormatFailure = (text: string, calls: ParsedToolCall[], opts: LanguageModelV3CallOptions, convId: string): void =>
      this.maybeMarkFormatFailure(text, calls, opts, convId)

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] })

        if (bannerText) {
          const id = "relay-banner"
          controller.enqueue({ type: "text-start", id })
          for (const delta of chunkText(bannerText)) {
            controller.enqueue({ type: "text-delta", id, delta })
          }
          controller.enqueue({ type: "text-end", id })
        }

        const onAbort = (): void => {
          relayManager.cancel(relay.id, "request aborted")
        }
        options.abortSignal?.addEventListener("abort", onAbort, { once: true })

        try {
          const text = await relay.promise
          if (options.abortSignal?.aborted) {
            controller.close()
            return
          }
          const calls = parseToolCalls(text)
          markFormatFailure(text, calls, options, conversationId)
          const cleanText = stripToolBlocks(text)

          if (cleanText) {
            const id = "relay-text"
            controller.enqueue({ type: "text-start", id })
            for (const delta of chunkText(cleanText)) {
              controller.enqueue({ type: "text-delta", id, delta })
            }
            controller.enqueue({ type: "text-end", id })
          }

          for (const call of calls) {
            controller.enqueue({
              type: "tool-call",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input,
            })
          }

          controller.enqueue({
            type: "finish",
            usage: zeroUsage(),
            finishReason: { unified: calls.length > 0 ? "tool-calls" : "stop", raw: undefined },
          })
          controller.close()
        } catch (err) {
          controller.enqueue({ type: "error", error: err })
          controller.enqueue({
            type: "finish",
            usage: zeroUsage(),
            finishReason: { unified: "error", raw: undefined },
          })
          controller.close()
        } finally {
          options.abortSignal?.removeEventListener("abort", onAbort)
        }
      },
    })

    return { stream }
  }
}

function providerOptions(
  options: LanguageModelV3CallOptions,
  providerName: string,
): Record<string, unknown> | undefined {
  const po = options.providerOptions
  if (!po || typeof po !== "object") return undefined
  const candidates = [
    "opencode-human-relay",
    providerName,
    "human-relay",
  ]
  for (const key of candidates) {
    const value = (po as Record<string, unknown>)[key]
    if (value && typeof value === "object") return value as Record<string, unknown>
  }
  return undefined
}

async function tryCopyPrompt(prompt: string): Promise<boolean> {
  try {
    await writeClipboard(prompt)
    return true
  } catch {
    return false
  }
}
