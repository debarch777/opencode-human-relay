import { after, beforeEach, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { createHumanRelay } from "../src/index.js"
import { relayManager, stopRelayBridge } from "../src/state.js"

const stateDir = mkdtempSync(path.join(os.tmpdir(), "relay-test-"))

const provider = createHumanRelay({
  name: "human-relay",
  relay: { mode: "manual", banner: false, stateDir, port: 18999 },
})

after(async () => {
  await stopRelayBridge()
  rmSync(stateDir, { recursive: true, force: true })
})

beforeEach(() => {
  relayManager.cancelAll("test teardown")
})

const options: LanguageModelV3CallOptions = {
  prompt: [{ role: "user", content: [{ type: "text", text: "What is 2+2?" }] }],
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function readAll(stream: ReadableStream<{ type: string }>): Promise<Array<Record<string, unknown>>> {
  const reader = stream.getReader()
  const parts: Array<Record<string, unknown>> = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    parts.push(value as Record<string, unknown>)
  }
  return parts
}

test("doStream relays a text reply", async () => {
  const lm = provider.languageModel("human-relay")
  const result = await lm.doStream(options)

  const pending = relayManager.list()
  assert.equal(pending.length, 1)
  const id = pending[0]!.id

  const reading = readAll(result.stream)
  await delay(50)
  assert.equal(relayManager.resolve(id, "Hello from the web model!"), true)
  const parts = await reading

  const types = parts.map((p) => p.type)
  assert.ok(types.includes("stream-start"))
  assert.ok(types.includes("text-start"))
  assert.ok(types.includes("text-end"))
  assert.ok(types.includes("finish"))

  const text = parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")
  assert.equal(text, "Hello from the web model!")

  const finish = parts.find((p) => p.type === "finish")
  assert.equal(finish?.finishReason.unified, "stop")
})

test("doStream parses tool calls and strips the block from text", async () => {
  const lm = provider.languageModel("human-relay")
  const result = await lm.doStream({
    ...options,
    tools: [
      {
        type: "function",
        name: "read",
        description: "Read a file.",
        inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
      },
    ],
    toolChoice: { type: "auto" },
  })

  const pending = relayManager.list()
  const id = pending[pending.length - 1]!.id

  const reading = readAll(result.stream)
  await delay(50)
  relayManager.resolve(
    id,
    'Let me read that.\n<opencode:tool name="read">{"filePath":"a.ts"}</opencode:tool>',
  )
  const parts = await reading

  const toolCalls = parts.filter((p) => p.type === "tool-call")
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0]!.toolName, "read")
  assert.deepEqual(JSON.parse(toolCalls[0]!.input as string), { filePath: "a.ts" })

  const text = parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("")
  assert.equal(text, "Let me read that.")
  assert.ok(!text.includes("opencode:tool"))

  const finish = parts.find((p) => p.type === "finish")
  assert.equal(finish?.finishReason.unified, "tool-calls")
})

test("doGenerate returns text and tool calls as content", async () => {
  const lm = provider.languageModel("human-relay")
  const resultPromise = lm.doGenerate(options)
  await delay(50)

  const pending = relayManager.list()
  const id = pending[pending.length - 1]!.id
  relayManager.resolve(id, 'prose here\n<opencode:tool name="read">{"filePath":"b.ts"}</opencode:tool>')

  const result = await resultPromise
  const textParts = result.content.filter((c) => c.type === "text")
  const callParts = result.content.filter((c) => c.type === "tool-call")
  assert.equal(textParts.length, 1)
  assert.equal(textParts[0]!.type, "text")
  assert.equal(callParts.length, 1)
  assert.equal(callParts[0]!.type, "tool-call")
  assert.equal(result.finishReason.unified, "tool-calls")
})

test("doGenerate reports error finish reason when cancelled", async () => {
  const lm = provider.languageModel("human-relay")
  const resultPromise = lm.doGenerate(options)
  await delay(50)

  const pending = relayManager.list()
  const id = pending[pending.length - 1]!.id
  relayManager.cancel(id, "aborted")

  const result = await resultPromise
  assert.equal(result.finishReason.unified, "error")
})

const readTools = [
  {
    type: "function",
    name: "read",
    description: "Read a file.",
    inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
  },
]

test("conversation mode continues the same chat with a delta", async () => {
  const lm = provider.languageModel("human-relay")
  const base = { tools: readTools, toolChoice: { type: "auto" } }

  const s1 = await lm.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Read the file" }] }],
    ...base,
  })
  await delay(30)
  const p1 = relayManager.list()
  assert.equal(p1.length, 1)
  assert.ok(p1[0]!.prompt.includes("# Available tools"), "first relay sends the full prompt")
  assert.equal(p1[0]!.isContinuation, false)
  const id1 = p1[0]!.id
  relayManager.resolve(id1, '<opencode:tool name="read">{"filePath":"a.ts"}</opencode:tool>')
  await readAll(s1.stream)

  const history = [
    { role: "user", content: [{ type: "text", text: "Read the file" }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: '{"filePath":"a.ts"}' }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "export const x = 1" } }] },
  ]
  const s2 = await lm.doStream({ prompt: history, ...base })
  await delay(30)
  const p2 = relayManager.list()
  const p2Relay = p2[p2.length - 1]!
  assert.equal(p2Relay.isContinuation, true, "same chat is continued")
  assert.ok(p2Relay.prompt.includes("### Continuation"))
  assert.ok(p2Relay.prompt.includes("export const x = 1"), "delta carries the new tool result")
  assert.ok(!p2Relay.prompt.includes("# Available tools"), "static block not re-sent")
  assert.ok(!p2Relay.prompt.includes("Read the file"), "old user message not re-sent")
  relayManager.resolve(p2Relay.id, "Done!")
  await readAll(s2.stream)
})

test("a broken tool block flags the conversation for a format reminder", async () => {
  const lm = provider.languageModel("human-relay")
  const base = { tools: readTools, toolChoice: { type: "auto" } }

  const s1 = await lm.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "Use a tool" }] }],
    ...base,
  })
  await delay(30)
  const p1 = relayManager.list()
  const id1 = p1[p1.length - 1]!.id
  // Structurally broken block: opener present, closing tag missing.
  relayManager.resolve(id1, 'Let me call the tool:\n<opencode:tool name="read">{"filePath":"a.ts"')
  await readAll(s1.stream)

  const history = [
    { role: "user", content: [{ type: "text", text: "Use a tool" }] },
    { role: "assistant", content: [{ type: "text", text: 'Let me call the tool:\n<opencode:tool name="read">{"filePath":"a.ts"' }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "x" } }] },
  ]
  const s2 = await lm.doStream({ prompt: history, ...base })
  await delay(30)
  const p2 = relayManager.list()
  const p2Relay = p2[p2.length - 1]!
  assert.equal(p2Relay.isContinuation, true)
  assert.ok(p2Relay.prompt.includes("# Format reminder"), "next relay carries a format reminder")
  relayManager.resolve(p2Relay.id, "ok")
  await readAll(s2.stream)
})
