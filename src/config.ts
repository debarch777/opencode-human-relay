import os from "node:os"
import path from "node:path"

/**
 * How the human reply is collected.
 *
 * - `clipboard`: the prompt is copied to the clipboard automatically and the
 *   reply is detected as soon as it is copied back.
 * - `manual`: nothing is copied automatically; run `opencode-human-relay paste`
 *   (or `submit`) to feed the reply back. Useful when there is no clipboard
 *   tool available (e.g. headless servers, SSH sessions).
 */
export type RelayMode = "clipboard" | "manual"

/**
 * How much of the conversation is re-sent on each relay.
 *
 * - `conversation`: the instruction + tools block is sent once when a new web
 *   chat starts; later relays for the same chat send only the new tool results
 *   and user messages (the web AI's own replies stay in the chat). A format
 *   reminder is appended only when a previous reply failed to parse.
 * - `full`: every relay re-sends the instruction + tools + entire history
 *   (the original behavior).
 */
export type RelayPromptMode = "conversation" | "full"

/** `createHumanRelay` options, mirroring what opencode passes into provider factories. */
export interface HumanRelayOptions {
  /** opencode passes `name` = provider id, e.g. `"human-relay"`. */
  name?: string
  /** Provider-specific namespace for this package. */
  relay?: {
    /** Relay mode. Defaults to `clipboard` (auto-fallback to `manual` if no clipboard tool is found). */
    mode?: RelayMode
    /** Local HTTP bridge port. Defaults to 17899. */
    port?: number
    /** How often (ms) to poll the clipboard in `clipboard` mode. Defaults to 1500. */
    clipboardPollMs?: number
    /** Copy the prompt to the clipboard automatically. Defaults to true. */
    autoCopy?: boolean
    /** Directory for the bridge state file. Defaults to the OS data dir. */
    stateDir?: string
    /** Extra instructions injected into every prompt. */
    instruction?: string
    /**
     * How much of the conversation is re-sent per relay.
     * Defaults to `conversation`.
     */
    promptMode?: RelayPromptMode
    /** Whether to emit a short "[human-relay] waiting..." banner as assistant text. Defaults to true. */
    banner?: boolean
    /** Markers stripped from assistant text when rendering history. */
    bannerMarker?: string
  }
  /** Ignored by this provider (present for opencode compat). */
  apiKey?: string
  /** Ignored by this provider (present for opencode compat). */
  headers?: Record<string, string>
  /** Ignored by this provider (present for opencode compat). */
  baseURL?: string
  /** Tolerate any other opencode-injected options. */
  [key: string]: unknown
}

export interface RelaySettings {
  mode: RelayMode
  port: number
  clipboardPollMs: number
  autoCopy: boolean
  stateDir: string
  instruction: string
  promptMode: RelayPromptMode
  banner: boolean
  bannerMarker: string
}

export interface ResolvedConfig {
  name: string
  modelId: string
  relay: RelaySettings
}

export const DEFAULT_INSTRUCTION = `TOOL USE
You are the reasoning model behind opencode, an agentic coding assistant. You do
not have direct access to tools. When you need to call a tool, output ONE or MORE
tool blocks and no prose around them:

<opencode:tool name="read">
{"filePath": "src/index.ts"}
</opencode:tool>

Rules for tool blocks:
- Use the exact tool name from the "Available tools" list.
- The JSON body must be a single object matching the tool's parameter schema.
- If you need multiple tools, output multiple blocks back to back.
- Output tool blocks only when a tool call is genuinely useful; otherwise reply
  normally in plain text.
- The conversation history below labels roles (User / Assistant / Tool result).
  Tool results are the actual output returned to you after a tool ran.`

export const DEFAULT_BANNER_MARKER = "[human-relay]"

export function defaultStateDir(): string {  const home = os.homedir()
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "opencode-human-relay")
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
      "opencode-human-relay",
    )
  }
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
    "opencode-human-relay",
  )
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function num(value: unknown, fallback: number, min: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : Number(value)
  return Number.isFinite(n) && n >= min ? n : fallback
}

/**
 * Resolve relay settings from (in priority order) explicit options, then
 * environment variables, then defaults.
 *
 * Environment variables:
 * - `HUMAN_RELAY_MODE`            -> `clipboard` | `manual`
 * - `HUMAN_RELAY_PROMPT_MODE`     -> `conversation` | `full`
 * - `HUMAN_RELAY_PORT`            -> bridge port
 * - `HUMAN_RELAY_CLIPBOARD_POLL_MS`
 * - `HUMAN_RELAY_STATE_DIR`
 * - `HUMAN_RELAY_AUTO_COPY`       -> `true` | `false`
 */
export function resolveConfig(input: unknown, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const options = (input ?? {}) as HumanRelayOptions
  const relay = options.relay ?? {}

  const envMode = str(env.HUMAN_RELAY_MODE)
  const mode: RelayMode =
    (envMode === "clipboard" || envMode === "manual" ? envMode : undefined) ??
    (relay.mode === "clipboard" || relay.mode === "manual" ? relay.mode : "clipboard")

  const port = num(env.HUMAN_RELAY_PORT, num(relay.port, 17899, 1), 1)

  const clipboardPollMs = num(
    env.HUMAN_RELAY_CLIPBOARD_POLL_MS,
    num(relay.clipboardPollMs, 1500, 100),
    100,
  )

  const autoCopyRaw =
    env.HUMAN_RELAY_AUTO_COPY ??
    (relay.autoCopy === undefined ? undefined : String(relay.autoCopy))
  const autoCopy = autoCopyRaw === undefined ? true : autoCopyRaw.toLowerCase() !== "false"

  const stateDir = str(env.HUMAN_RELAY_STATE_DIR) ?? str(relay.stateDir) ?? defaultStateDir()

  const instruction = str(relay.instruction) ?? DEFAULT_INSTRUCTION
  const banner = relay.banner !== false
  const bannerMarker = str(relay.bannerMarker) ?? DEFAULT_BANNER_MARKER

  const envPromptMode = str(env.HUMAN_RELAY_PROMPT_MODE)
  const promptMode: RelayPromptMode =
    (envPromptMode === "conversation" || envPromptMode === "full" ? envPromptMode : undefined) ??
    (relay.promptMode === "conversation" || relay.promptMode === "full"
      ? relay.promptMode
      : "conversation")

  const relaySettings: RelaySettings = {
    mode,
    port,
    clipboardPollMs,
    autoCopy,
    stateDir,
    instruction,
    promptMode,
    banner,
    bannerMarker,
  }

  return {
    name: str(options.name) ?? "human-relay",
    modelId: "human-relay",
    relay: relaySettings,
  }
}
