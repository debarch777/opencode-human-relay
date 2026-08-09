import { test } from "node:test"
import assert from "node:assert/strict"
import type { JSONSchema7, LanguageModelV3CallOptions, LanguageModelV3FunctionTool, LanguageModelV3Message } from "@ai-sdk/provider"
import { resolveConfig } from "../src/config.js"
import {
  renderPrompt,
  renderRelayPrompt,
  stripBanner,
  buildBanner,
  conversationFingerprint,
  conversationToolFingerprint,
  isTitleRequest,
  synthesizedTitle,
} from "../src/prompt.js"
import type { RelayConversationState } from "../src/prompt.js"

const config = resolveConfig({
  name: "human-relay",
  relay: { mode: "manual", instruction: "TEST INSTRUCTION" },
})

const tools: Array<LanguageModelV3FunctionTool> = [
  {
    type: "function",
    name: "read",
    description: "Read a file.",
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: { filePath: { type: "string", description: "Path to read." } },
    } as JSONSchema7,
  },
]

const opts = (overrides: Partial<LanguageModelV3CallOptions> = {}): LanguageModelV3CallOptions => ({
  prompt: [
    { role: "system", content: "You are a coding assistant." },
    { role: "user", content: [{ type: "text", text: "Read src/index.ts" }] },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "c1", toolName: "read", input: '{"filePath":"src/index.ts"}' },
      ],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "export const x = 1" } }],
    },
  ],
  tools,
  toolChoice: { type: "auto" },
  ...overrides,
})

test("renderPrompt includes instruction, tools, and history", () => {
  const { prompt } = renderPrompt(opts(), config)
  assert.ok(prompt.includes("TEST INSTRUCTION"))
  assert.ok(prompt.includes("# Available tools"))
  assert.ok(prompt.includes("read"))
  assert.ok(prompt.includes("filePath"))
  assert.ok(prompt.includes("# User"))
  assert.ok(prompt.includes("Read src/index.ts"))
  assert.ok(prompt.includes("# Assistant"))
  assert.ok(prompt.includes("<opencode:tool name=\"read\">"))
  assert.ok(prompt.includes("# Tool result"))
  assert.ok(prompt.includes("export const x = 1"))
})

test("renderPrompt with toolChoice none adds a note", () => {
  const { prompt } = renderPrompt(opts({ toolChoice: { type: "none" } }), config)
  assert.ok(prompt.includes("Tool use is disabled"))
})

test("renderPrompt with no messages returns only the instruction", () => {
  const { prompt } = renderPrompt({ prompt: [] }, config)
  assert.equal(prompt, "TEST INSTRUCTION")
})

test("stripBanner removes marker lines", () => {
  const text = "line one\n[human-relay] Waiting...\nline three"
  assert.equal(stripBanner(text, "[human-relay]"), "line one\nline three")
})

test("buildBanner differs by mode", () => {
  const manual = buildBanner(config, "manual")
  const clip = buildBanner(config, "clipboard")
  assert.ok(manual.includes("opencode-human-relay paste"))
  assert.ok(clip.includes("clipboard"))
})

const afterFirstHistory = (): LanguageModelV3Message[] => [
  ...(opts().prompt ?? []),
  {
    role: "assistant",
    content: [{ type: "text", text: "I'll read it." }],
  },
  {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "c2", toolName: "read", output: { type: "text", value: "export const x = 1" } },
    ],
  },
]

test("renderRelayPrompt: first relay is full, continuation is a delta", () => {
  const first = renderRelayPrompt(opts(), config)
  assert.equal(first.isContinuation, false)
  assert.ok(first.prompt.includes("TEST INSTRUCTION"))
  assert.ok(first.prompt.includes("# Conversation history"))
  assert.ok(first.prompt.includes("Read src/index.ts"))
  assert.ok(first.prompt.includes("<opencode:tool name=\"read\">"))

  const second = renderRelayPrompt({ ...opts(), prompt: afterFirstHistory() }, config, first.conversation)
  assert.equal(second.isContinuation, true)
  assert.ok(second.prompt.includes("### Continuation"))
  assert.ok(second.prompt.includes("export const x = 1"), "delta includes the new tool result")
  assert.ok(!second.prompt.includes("# Available tools"), "static block is not re-sent")
  assert.ok(!second.prompt.includes("Read src/index.ts"), "old user message is not re-sent")
  assert.ok(!second.prompt.includes("# Assistant"), "web model's own replies are not re-sent")
  assert.ok(!second.prompt.includes("opencode:tool"), "prior tool calls are not re-sent")
})

test("renderRelayPrompt: history that is not a prefix starts a fresh conversation", () => {
  const first = renderRelayPrompt(opts(), config)
  const other = renderRelayPrompt(
    { ...opts(), prompt: [{ role: "user", content: [{ type: "text", text: "Something else entirely" }] }] },
    config,
    first.conversation,
  )
  assert.equal(other.isContinuation, false)
  assert.ok(other.prompt.includes("# Conversation history"))
  assert.ok(other.prompt.includes("Something else entirely"))
})

test("renderRelayPrompt: a changed tool set starts a fresh conversation", () => {
  const first = renderRelayPrompt(opts(), config)
  const differentTools = renderRelayPrompt(
    {
      ...opts(),
      tools: [...tools, { type: "function", name: "write", inputSchema: { type: "object" } } as LanguageModelV3FunctionTool],
    },
    config,
    first.conversation,
  )
  assert.equal(differentTools.isContinuation, false)
  assert.ok(differentTools.prompt.includes("# Available tools"))
})

test("renderRelayPrompt: full mode always re-sends the whole prompt", () => {
  const first = renderRelayPrompt(opts(), config, undefined, "full")
  assert.equal(first.isContinuation, false)
  const second = renderRelayPrompt({ ...opts(), prompt: afterFirstHistory() }, config, first.conversation, "full")
  assert.equal(second.isContinuation, false)
  assert.ok(second.prompt.includes("# Available tools"))
  assert.ok(second.prompt.includes("export const x = 1"))
})

test("renderRelayPrompt: format reminder only when flagged, and is consumed", () => {
  const first = renderRelayPrompt(opts(), config)
  const flagged: RelayConversationState = { ...first.conversation, needsFormatReminder: true }

  const reminded = renderRelayPrompt({ ...opts(), prompt: afterFirstHistory() }, config, flagged)
  assert.equal(reminded.isContinuation, true)
  assert.ok(reminded.prompt.includes("# Format reminder"))
  assert.equal(reminded.conversation.needsFormatReminder, false, "reminder is consumed")

  const plain = renderRelayPrompt({ ...opts(), prompt: afterFirstHistory() }, config, first.conversation)
  assert.equal(plain.isContinuation, true)
  assert.ok(!plain.prompt.includes("# Format reminder"))
})

test("renderPrompt strips banner lines from assistant text in history", () => {
  const { prompt } = renderPrompt(
    {
      prompt: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "line one\n[human-relay] Waiting...\nreply" }] },
      ],
    },
    config,
  )
  assert.ok(prompt.includes("line one"))
  assert.ok(prompt.includes("reply"))
  assert.ok(!prompt.includes("Waiting..."))
})

test("conversation fingerprints are stable and distinct", () => {
  const a = renderRelayPrompt(opts(), config).conversation
  const b = renderRelayPrompt(opts(), config).conversation
  assert.equal(a.toolFingerprint, b.toolFingerprint)
  assert.notEqual(a.id, b.id, "each fresh conversation gets a new id")

  const fp1 = conversationFingerprint(opts().prompt ?? [], config)
  const fp2 = conversationFingerprint(opts().prompt ?? [], config)
  assert.equal(fp1, fp2)

  const different = [...tools, { type: "function", name: "write", inputSchema: { type: "object" } } as LanguageModelV3FunctionTool]
  assert.notEqual(conversationToolFingerprint(tools), conversationToolFingerprint(different))
  assert.equal(conversationToolFingerprint(tools), conversationToolFingerprint([...tools].reverse()))
})

test("isTitleRequest detects opencode's title-generation calls only", () => {
  const title = { prompt: [{ role: "user", content: [{ type: "text", text: "Generate a title for this conversation:\n" }] }] }
  assert.equal(isTitleRequest(title as LanguageModelV3CallOptions), true)

  const taskName = { prompt: [{ role: "user", content: "Generate a short 2-3 word name that describes this task:\n\nfix the bug" }] }
  assert.equal(isTitleRequest(taskName as LanguageModelV3CallOptions), true)

  assert.equal(isTitleRequest(opts()), false, "a real task prompt is not a title request")
  assert.equal(isTitleRequest({ prompt: [{ role: "user", content: "hi" }] } as LanguageModelV3CallOptions), false)
  assert.equal(isTitleRequest({ prompt: [{ role: "user", content: "Generate a title for this conversation: my code" }] } as LanguageModelV3CallOptions), false)
})

test("synthesizedTitle derives a short placeholder from the title payload", () => {
  const title = { prompt: [{ role: "user", content: "Generate a title for this conversation:\n\nhello there" }] } as LanguageModelV3CallOptions
  assert.equal(synthesizedTitle(title), "hello there")
  assert.equal(synthesizedTitle({ prompt: [{ role: "user", content: "Generate a title for this conversation:\n" }] } as LanguageModelV3CallOptions), "New session")
  assert.equal(synthesizedTitle({ prompt: [{ role: "user", content: "Generate a short 2-3 word name that describes this task:\n\nwrite tests" }] } as LanguageModelV3CallOptions), "write tests")
})
