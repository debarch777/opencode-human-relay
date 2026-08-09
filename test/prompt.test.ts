import { test } from "node:test"
import assert from "node:assert/strict"
import type { JSONSchema7, LanguageModelV3CallOptions, LanguageModelV3FunctionTool } from "@ai-sdk/provider"
import { resolveConfig } from "../src/config.js"
import { renderPrompt, stripBanner, buildBanner } from "../src/prompt.js"

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
