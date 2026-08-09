#!/usr/bin/env node
import { createRequire } from "node:module"
import { createInterface } from "node:readline"
import { defaultStateDir } from "./config.js"
import { readStateFile } from "./bridge.js"
import { readClipboard, writeClipboard } from "./util.js"

const require = createRequire(import.meta.url)
const VERSION = (require("../package.json") as { version: string }).version

const HELP = `opencode-human-relay — bridge between opencode and a web AI (ChatGPT, Claude, ...)

Usage:
  opencode-human-relay status                     Show bridge status and pending requests
  opencode-human-relay get                        Print the current pending prompt to stdout
  opencode-human-relay copy                       Re-copy the current pending prompt to the clipboard
  opencode-human-relay paste [text...]            Submit the web AI's reply (piped stdin, --clipboard, or args)
  opencode-human-relay cancel                     Cancel the current pending request
  opencode-human-relay version                    Print version
  opencode-human-relay help                       Show this help

The relay bridge runs automatically inside an opencode session that uses the
human-relay provider. These commands talk to it over 127.0.0.1.

Environment:
  HUMAN_RELAY_STATE_DIR   Directory of the bridge state file (default: OS data dir)
`

interface State {
  port: number
  token: string
}

function loadState(): State | undefined {
  const dir = process.env.HUMAN_RELAY_STATE_DIR ?? defaultStateDir()
  const info = readStateFile(dir)
  if (!info) return undefined
  return { port: info.port, token: info.token }
}

export class RelayUnreachableError extends Error {
  constructor() {
    super("relay bridge not reachable")
    this.name = "RelayUnreachableError"
  }
}

async function relay<T>(state: State, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${state.port}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-relay-token": state.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new RelayUnreachableError()
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

function noSession(): never {
  console.error(
    "No active human-relay session found.\n" +
      "Start opencode with the human-relay provider configured, then try again.",
  )
  process.exit(1)
}

function handleRelayError(err: unknown): never {
  if (err instanceof RelayUnreachableError) noSession()
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(1)
}

async function readPipedStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString("utf8")
  return text.length > 0 ? text : null
}

function readMultiline(prefix: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    process.stdout.write(prefix)
    const lines: string[] = []
    rl.on("line", (line) => lines.push(line))
    rl.on("close", () => resolve(lines.join("\n")))
  })
}

async function cmdStatus(): Promise<void> {
  const state = loadState()
  if (!state) noSession()
  try {
    const health = await relay<{ ok: boolean; pending: number }>(state!, "GET", "/health")
    const list = await relay<{ relays: Array<{ id: string; createdAt: number }> }>(state!, "GET", "/relay/list")
    console.log(`Bridge:  http://127.0.0.1:${state!.port} (${health.ok ? "ok" : "unknown"})`)
    console.log(`Pending requests: ${list.relays.length}`)
    for (const r of list.relays) {
      console.log(`  - ${r.id} (since ${new Date(r.createdAt).toISOString()})`)
    }
  } catch (err) {
    handleRelayError(err)
  }
}

async function cmdGet(): Promise<void> {
  const state = loadState()
  if (!state) noSession()
  const data = await relay<{ relay: { prompt: string } | null }>(state, "GET", "/relay/current")
  if (!data.relay) {
    console.error("No pending request.")
    process.exit(1)
  }
  process.stdout.write(data.relay.prompt.endsWith("\n") ? data.relay.prompt : data.relay.prompt + "\n")
}

async function cmdCopy(): Promise<void> {
  const state = loadState()
  if (!state) noSession()
  const data = await relay<{ relay: { prompt: string } | null }>(state, "GET", "/relay/current")
  if (!data.relay) {
    console.error("No pending request.")
    process.exit(1)
  }
  await writeClipboard(data.relay.prompt)
  console.log("Prompt copied to clipboard.")
}

async function cmdPaste(args: string[]): Promise<void> {
  let text: string | undefined

  if (args.includes("--clipboard")) {
    text = await readClipboard().catch(() => undefined)
  } else if (args.length > 0) {
    text = args.join(" ")
  } else {
    const piped = await readPipedStdin()
    if (piped !== null) {
      text = piped
    } else {
      text = await readMultiline("Paste the web model's reply, then press Ctrl+D:\n")
    }
  }

  text = text?.trim()
  if (!text) {
    console.error(
      "No reply provided. Pipe it in (echo '...' | opencode-human-relay paste),\n" +
        "pass --clipboard to read the clipboard, or pass the text as arguments.",
    )
    process.exit(1)
  }

  const state = loadState()
  if (!state) noSession()
  const data = await relay<{ ok: boolean; id?: string }>(state, "POST", "/relay/current/submit", { text })
  console.log(`Reply accepted${data.id ? ` (relay ${data.id})` : ""}.`)
}

async function cmdCancel(): Promise<void> {
  const state = loadState()
  if (!state) noSession()
  const data = await relay<{ ok: boolean; id?: string }>(state, "POST", "/relay/current/cancel")
  console.log(`Cancelled${data.id ? ` (relay ${data.id})` : ""}.`)
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2)
  switch (cmd) {
    case "status":
      await cmdStatus()
      break
    case "get":
      await cmdGet()
      break
    case "copy":
      await cmdCopy()
      break
    case "paste":
    case "submit":
      await cmdPaste(args)
      break
    case "cancel":
      await cmdCancel()
      break
    case "version":
    case "--version":
      console.log(VERSION)
      break
    case "help":
    case "--help":
    case undefined:
      process.stdout.write(HELP)
      break
    default:
      console.error(`Unknown command: ${cmd}\n`)
      process.stdout.write(HELP)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(1)
})
