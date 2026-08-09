import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { HumanRelayOptions, ResolvedConfig } from "./config.js"
import { resolveConfig } from "./config.js"
import { HumanRelayModel } from "./model.js"

export type { HumanRelayOptions, RelayMode, RelayPromptMode, RelaySettings, ResolvedConfig } from "./config.js"
export { resolveConfig } from "./config.js"
export { HumanRelayModel, zeroUsage, chunkText } from "./model.js"
export { renderPrompt, renderRelayPrompt, buildBanner } from "./prompt.js"
export type { RelayConversationState, RelayRenderResult, RenderedPrompt } from "./prompt.js"
export { conversationFingerprint, conversationToolFingerprint } from "./prompt.js"
export { parseToolCalls, extractJSONObject, stripCodeFence } from "./parse.js"
export { RelayManager } from "./relay.js"
export type { RelayCreateInput, PendingRelayInfo } from "./relay.js"
export { ensureBridge, readStateFile } from "./bridge.js"

export interface HumanRelayProvider {
  name: string
  languageModel: (modelId: string) => LanguageModelV3
}

/**
 * Provider factory for opencode's `provider` config. opencode invokes the first
 * exported `create*` function with `{ name, ...options }` where `options` comes
 * from the `options` key of the provider entry (plus env-derived settings).
 *
 * ```jsonc
 * // opencode.json
 * {
 *   "provider": {
 *     "human-relay": {
 *       "npm": "opencode-human-relay",
 *       "name": "Human Relay (copy/paste)",
 *       "models": {
 *         "human-relay": { "name": "Human Relay" }
 *       },
 *       "options": {
 *         "relay": { "mode": "clipboard" }
 *       }
 *     }
 *   }
 * }
 * ```
 */
export function createHumanRelay(options: HumanRelayOptions): HumanRelayProvider {
  const config: ResolvedConfig = resolveConfig(options)
  const languageModel = (modelId: string): LanguageModelV3 =>
    new HumanRelayModel({
      ...config,
      modelId: modelId.length > 0 ? modelId : config.modelId,
    })
  return {
    name: config.name,
    languageModel,
  }
}
