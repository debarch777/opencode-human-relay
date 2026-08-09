import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider"
import type { RelayMode, ResolvedConfig } from "./config.js"
import { buildBanner, renderPrompt } from "./prompt.js"
import { parseToolCalls } from "./parse.js"
import { writeClipboard } from "./util.js"
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

  private perCallOptions(options: LanguageModelV3CallOptions): { mode: RelayMode; autoCopy: boolean } {
    const po = providerOptions(options, this.config.name)
    const relayCfg = this.config.relay
    const nested = po && typeof po.relay === "object" && po.relay !== null ? (po.relay as Record<string, unknown>) : undefined
    const overrideMode = po?.mode ?? nested?.mode
    const overrideAutoCopy = po && typeof po.autoCopy === "boolean" ? po.autoCopy : nested && typeof nested.autoCopy === "boolean" ? nested.autoCopy : undefined
    const mode: RelayMode =
      overrideMode === "clipboard" || overrideMode === "manual" ? overrideMode : relayCfg.mode
    const autoCopy = overrideAutoCopy === undefined ? relayCfg.autoCopy : overrideAutoCopy
    return { mode, autoCopy }
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { prompt } = renderPrompt(options, this.config)
    const { mode, autoCopy } = this.perCallOptions(options)

    startRelayBridge(this.config.relay)
    const relay = relayManager.create(prompt, mode)
    if (mode === "clipboard") {
      if (autoCopy) await tryCopyPrompt(prompt)
      ensureClipboardWatcher(this.config.relay.clipboardPollMs)
    }

    try {
      const text = await relay.promise
      const calls = parseToolCalls(text)
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
    const { prompt } = renderPrompt(options, this.config)
    const { mode, autoCopy } = this.perCallOptions(options)

    startRelayBridge(this.config.relay)
    const relay = relayManager.create(prompt, mode)

    const banner = this.config.relay.banner ? buildBanner(this.config, mode) : ""
    let clipboardNote = ""
    if (mode === "clipboard") {
      if (autoCopy) {
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
