import type { RelaySettings } from "./config.js"
import { RelayManager, startClipboardWatcher } from "./relay.js"
import { ensureBridge } from "./bridge.js"

/** Process-wide relay manager shared by all model instances. */
export const relayManager = new RelayManager()

let watcherStop: (() => void) | undefined

/** Start the clipboard watcher once. Safe to call multiple times. */
export function ensureClipboardWatcher(pollMs: number): void {
  if (!watcherStop) watcherStop = startClipboardWatcher(relayManager, pollMs)
}

let bridgeStarted = false
let bridge: Awaited<ReturnType<typeof ensureBridge>> | undefined

/** Start the local relay bridge once per process. Safe to call multiple times. */
export function startRelayBridge(settings: RelaySettings): void {
  if (bridgeStarted) return
  bridgeStarted = true
  void ensureBridge(settings, relayManager)
    .then((b) => {
      bridge = b
    })
    .catch(() => {
      bridgeStarted = false
    })
}

/** Stop the bridge (mainly for tests). */
export async function stopRelayBridge(): Promise<void> {
  bridgeStarted = false
  if (bridge) {
    await bridge.stop()
    bridge = undefined
  }
}
