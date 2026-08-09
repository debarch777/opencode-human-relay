import { randomUUID } from "node:crypto"
import type { RelayMode } from "./config.js"
import type { RelayConversationState } from "./prompt.js"
import { readClipboard } from "./util.js"

export interface PendingRelayInfo {
  id: string
  prompt: string
  mode: RelayMode
  /** SHA-1 of the rendered prompt text. */
  fingerprint: string
  /** True when this relay is a delta for an ongoing web chat. */
  isContinuation: boolean
  createdAt: number
}

export interface RelayCreateInput {
  prompt: string
  mode: RelayMode
  fingerprint: string
  /** The web-chat conversation this relay belongs to. */
  conversationId: string
  isContinuation: boolean
}

interface PendingEntry {
  info: PendingRelayInfo
  conversationId: string
  resolve: (text: string) => void
  reject: (err: Error) => void
}

/**
 * Tracks model calls that are waiting for a human reply. One process-wide
 * manager is shared by every model instance so that the bridge and the
 * clipboard watcher can resolve whichever call the user answers.
 */
export class RelayManager {
  private entries = new Map<string, PendingEntry>()
  private order: string[] = []
  private lastAccepted = ""
  private conversations = new Map<string, RelayConversationState>()
  private activeConversationId: string | undefined

  /** Create a new pending relay and return a promise that settles with the reply text. */
  create(
    prompt: string,
    mode: RelayMode,
  ): { id: string; promise: Promise<string> }
  create(input: RelayCreateInput): { id: string; promise: Promise<string> }
  create(
    arg: string | RelayCreateInput,
    maybeMode?: RelayMode,
  ): { id: string; promise: Promise<string> } {
    const input: RelayCreateInput =
      typeof arg === "string"
        ? {
            prompt: arg,
            mode: maybeMode ?? "manual",
            fingerprint: "",
            conversationId: randomUUID(),
            isContinuation: false,
          }
        : arg
    const id = randomUUID()
    let resolve!: (text: string) => void
    let reject!: (err: Error) => void
    const promise = new Promise<string>((res, rej) => {
      resolve = res
      reject = rej
    })
    this.entries.set(id, {
      info: {
        id,
        prompt: input.prompt.trim(),
        mode: input.mode,
        fingerprint: input.fingerprint,
        isContinuation: input.isContinuation,
        createdAt: Date.now(),
      },
      conversationId: input.conversationId,
      resolve,
      reject,
    })
    this.order.push(id)
    return { id, promise }
  }

  /**
   * Record the conversation state for the most recent relay so the next relay
   * can detect a continuation. Only the last state is used for detection.
   */
  rememberConversation(state: RelayConversationState): void {
    this.conversations.set(state.id, state)
    this.activeConversationId = state.id
  }

  /** The conversation state of the most recent relay, if any. */
  get activeConversation(): RelayConversationState | undefined {
    return this.activeConversationId
      ? this.conversations.get(this.activeConversationId)
      : undefined
  }

  /** Flag a conversation so the next relay includes a format reminder. */
  markFormatFailure(conversationId: string): void {
    const state = this.conversations.get(conversationId)
    if (state) state.needsFormatReminder = true
  }

  get count(): number {
    return this.entries.size
  }

  /** Oldest pending relay (FIFO). */
  get oldest(): PendingRelayInfo | undefined {
    for (const id of this.order) {
      const entry = this.entries.get(id)
      if (entry) return entry.info
    }
    return undefined
  }

  list(): PendingRelayInfo[] {
    return this.order.flatMap((id) => {
      const entry = this.entries.get(id)
      return entry ? [entry.info] : []
    })
  }

  /** Resolve a specific relay by id. Returns false if it no longer exists. */
  resolve(id: string, text: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.cleanup(id)
    entry.resolve(text.trim())
    return true
  }

  /** Resolve the oldest pending relay. Returns the id on success. */
  resolveOldest(text: string): string | undefined {
    const oldest = this.oldest
    if (!oldest) return undefined
    this.resolve(oldest.id, text)
    return oldest.id
  }

  /** Cancel a specific relay by id. */
  cancel(id: string, reason: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.cleanup(id)
    entry.reject(new Error(reason))
    return true
  }

  cancelAll(reason: string): void {
    for (const id of [...this.order]) {
      this.cancel(id, reason)
    }
  }

  get lastAcceptedContent(): string {
    return this.lastAccepted
  }

  set lastAcceptedContent(value: string) {
    this.lastAccepted = value
  }

  private cleanup(id: string): void {
    this.entries.delete(id)
    this.order = this.order.filter((x) => x !== id)
  }
}

/**
 * Decide whether clipboard content should be treated as a reply. Normalizes
 * whitespace so a prompt ending in a newline can never be mistaken for its own
 * reply (or vice versa).
 */
export function isAcceptableReply(
  text: string,
  pendingPrompts: Iterable<string>,
  lastAccepted: string,
): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (trimmed === lastAccepted) return false
  for (const prompt of pendingPrompts) {
    if (trimmed === prompt.trim()) return false
  }
  return true
}

/**
 * Poll the clipboard and auto-resolve the oldest pending relay when a reply is
 * detected. The reply is any clipboard content that is non-empty, differs from
 * every pending prompt, and differs from the last accepted reply.
 *
 * Returns a `stop` function.
 */
export function startClipboardWatcher(
  manager: RelayManager,
  pollMs: number,
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const loop = async (): Promise<void> => {
    if (stopped) return
    if (manager.count > 0) {
      try {
        const text = await readClipboard()
        if (isAcceptableReply(text, manager.list().map((p) => p.prompt), manager.lastAcceptedContent)) {
          const id = manager.resolveOldest(text)
          if (id !== undefined) manager.lastAcceptedContent = text.trim()
        }
      } catch {
        // clipboard unavailable — the manual path still works
      }
    }
    if (!stopped) timer = setTimeout(loop, pollMs)
  }

  // Delay the first read so the prompt-copy has settled.
  timer = setTimeout(loop, Math.max(pollMs, 300))
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
