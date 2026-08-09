import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync, readFileSync, chmodSync, renameSync } from "node:fs"
import path from "node:path"
import http from "node:http"
import type { AddressInfo } from "node:net"
import type { RelaySettings } from "./config.js"
import type { RelayManager } from "./relay.js"
import { sha1 } from "./util.js"

export { sha1 }

export interface BridgeInfo {
  port: number
  token: string
  stateDir: string
  pid: number
  startedAt: string
}

const MAX_BODY = 16 * 1024 * 1024

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error("request body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  })
  res.end(payload)
}

function unauthorized(res: http.ServerResponse): void {
  json(res, 401, { error: "invalid relay token" })
}

export interface Bridge {
  info: BridgeInfo
  stop: () => Promise<void>
}

const active = new Map<number, Promise<Bridge>>()

/**
 * Ensure the local relay bridge is running, returning its port and token.
 * The bridge is a loopback-only HTTP server used by the `opencode-human-relay`
 * CLI to feed replies back into a waiting model call.
 */
export function ensureBridge(
  settings: RelaySettings,
  manager: RelayManager,
): Promise<Bridge> {
  const cached = active.get(settings.port)
  if (cached) return cached

  const promise = startBridge(settings, manager)
  active.set(settings.port, promise)
  promise.catch(() => active.delete(settings.port))
  return promise
}

async function startBridge(settings: RelaySettings, manager: RelayManager): Promise<Bridge> {
  const token = randomBytes(24).toString("hex")
  const { port } = settings

  let server: http.Server | undefined
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = port + attempt
    try {
      server = await listen(candidate)
      break
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === "EADDRINUSE" || code === "EACCES") continue
      throw err
    }
  }
  if (!server) throw new Error(`cannot bind relay bridge on ports ${port}-${port + 19}`)

  const address = server.address() as AddressInfo
  const boundPort = address.port
  const pid = process.pid
  const info: BridgeInfo = {
    port: boundPort,
    token,
    stateDir: settings.stateDir,
    pid,
    startedAt: new Date().toISOString(),
  }
  writeStateFile(info)

  server.on("request", (req, res) => {
    void handle(settings, manager, info, req, res)
  })

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      active.delete(settings.port)
      server?.close(() => resolve())
      server?.closeAllConnections?.()
    })

  return { info, stop }
}

function listen(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve(server)
    })
  })
}

async function handle(
  settings: RelaySettings,
  manager: RelayManager,
  info: BridgeInfo,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true, port: info.port, pending: manager.count })
    return
  }

  if (url.pathname.startsWith("/relay")) {
    if (req.headers["x-relay-token"] !== info.token) {
      unauthorized(res)
      return
    }
  }

  // GET /relay/current
  if (req.method === "GET" && url.pathname === "/relay/current") {
    const relay = manager.oldest
    json(res, 200, {
      relay: relay
        ? {
            id: relay.id,
            prompt: relay.prompt,
            fingerprint: relay.fingerprint,
            isContinuation: relay.isContinuation,
            createdAt: relay.createdAt,
          }
        : null,
    })
    return
  }

  // GET /relay/list
  if (req.method === "GET" && url.pathname === "/relay/list") {
    json(res, 200, { relays: manager.list() })
    return
  }

  // POST /relay/current/cancel
  if (req.method === "POST" && url.pathname === "/relay/current/cancel") {
    const oldest = manager.oldest
    if (!oldest) {
      json(res, 404, { error: "no pending relay" })
      return
    }
    manager.cancel(oldest.id, "cancelled by user")
    json(res, 200, { ok: true, id: oldest.id })
    return
  }

  // POST /relay/cancel-all
  if (req.method === "POST" && url.pathname === "/relay/cancel-all") {
    manager.cancelAll("cancelled by user")
    json(res, 200, { ok: true })
    return
  }

  // POST /relay/current/submit  { "text": "..." }
  if (req.method === "POST" && url.pathname === "/relay/current/submit") {
    const body = await safeReadBody(req, res)
    if (!body) return
    const text = extractText(body)
    if (text === undefined) {
      json(res, 400, { error: "missing string field `text`" })
      return
    }
    const id = manager.resolveOldest(text)
    if (id === undefined) {
      json(res, 404, { error: "no pending relay" })
      return
    }
    manager.lastAcceptedContent = text
    json(res, 200, { ok: true, id })
    return
  }

  // POST /relay/:id/submit  { "text": "..." }
  const submitMatch = /^\/relay\/([^/]+)\/submit$/.exec(url.pathname)
  if (req.method === "POST" && submitMatch) {
    const body = await safeReadBody(req, res)
    if (!body) return
    const text = extractText(body)
    if (text === undefined) {
      json(res, 400, { error: "missing string field `text`" })
      return
    }
    const ok = manager.resolve(submitMatch[1]!, text)
    if (!ok) {
      json(res, 404, { error: "unknown relay id" })
      return
    }
    manager.lastAcceptedContent = text
    json(res, 200, { ok: true, id: submitMatch[1] })
    return
  }

  json(res, 404, { error: "not found" })
}

async function safeReadBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown | null> {
  try {
    const raw = await readBody(req)
    return JSON.parse(raw) as unknown
  } catch {
    json(res, 400, { error: "invalid JSON body" })
    return null
  }
}

function extractText(body: unknown): string | undefined {
  if (body == null || typeof body !== "object") return undefined
  const text = (body as { text?: unknown }).text
  return typeof text === "string" ? text : undefined
}

export function stateFilePath(stateDir: string): string {
  return path.join(stateDir, "state.json")
}

function writeStateFile(info: BridgeInfo): void {
  try {
    mkdirSync(info.stateDir, { recursive: true })
    const payload = JSON.stringify({ version: 1, ...info }, null, 2)
    const tmp = stateFilePath(info.stateDir) + ".tmp"
    writeFileSync(tmp, payload, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, stateFilePath(info.stateDir))
  } catch {
    // state file is best-effort; the CLI shows a hint if it is missing
  }
}

/** Read the state file written by a running bridge (used by the CLI). */
export function readStateFile(stateDir: string): BridgeInfo | undefined {
  try {
    const raw = readFileSync(stateFilePath(stateDir), "utf8")
    const parsed = JSON.parse(raw) as BridgeInfo & { version?: number }
    if (typeof parsed.port !== "number" || typeof parsed.token !== "string") return undefined
    return parsed
  } catch {
    return undefined
  }
}
