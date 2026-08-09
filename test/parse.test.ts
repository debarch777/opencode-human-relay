import { test } from "node:test"
import assert from "node:assert/strict"
import { parseToolCalls, extractJSONObject, stripCodeFence } from "../src/parse.js"

test("parses a single tool block", () => {
  const calls = parseToolCalls('<opencode:tool name="read">\n{"filePath": "src/index.ts"}\n</opencode:tool>')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.toolName, "read")
  assert.deepEqual(JSON.parse(calls[0]!.input), { filePath: "src/index.ts" })
  assert.ok(calls[0]!.toolCallId.length > 0)
})

test("parses multiple tool blocks with prose", () => {
  const text = [
    "Here you go:",
    '<opencode:tool name="read">{"filePath":"src/a.ts"}</opencode:tool>',
    "wait that was wrong",
    '<opencode:tool name="read">{"filePath":"src/b.ts"}</opencode:tool>',
  ].join("\n")
  const calls = parseToolCalls(text)
  assert.equal(calls.length, 2)
  assert.deepEqual(JSON.parse(calls[0]!.input), { filePath: "src/a.ts" })
  assert.deepEqual(JSON.parse(calls[1]!.input), { filePath: "src/b.ts" })
})

test("tolerates markdown code fences around blocks", () => {
  const text = "```xml\n<opencode:tool name=\"read\">\n{\"filePath\": \"x.ts\"}\n</opencode:tool>\n```"
  const calls = parseToolCalls(text)
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(calls[0]!.input), { filePath: "x.ts" })
})

test("extracts a balanced JSON object from prose", () => {
  const extracted = extractJSONObject('The answer is {"a": {"b": 1}} thanks')
  assert.equal(extracted, '{"a": {"b": 1}}')
})

test("extractJSONObject handles braces inside strings", () => {
  const extracted = extractJSONObject('{"a": "} ", "b": {"c": [1, {"]": 2}]}}')
  assert.ok(extracted)
  assert.deepEqual(JSON.parse(extracted), { a: "} ", b: { c: [1, { "]": 2 }] } })
})

test("unparseable input becomes an error tool call", () => {
  const calls = parseToolCalls('<opencode:tool name="read">not json at all</opencode:tool>')
  assert.equal(calls.length, 1)
  const parsed = JSON.parse(calls[0]!.input) as { error?: string }
  assert.equal(parsed.error, "unparseable tool input")
})

test("decodes double-encoded JSON input", () => {
  const calls = parseToolCalls('<opencode:tool name="read">"{\\"filePath\\":\\"x.ts\\"}"</opencode:tool>')
  assert.equal(calls.length, 1)
  assert.deepEqual(JSON.parse(calls[0]!.input), { filePath: "x.ts" })
})

test("stripCodeFence handles xml/json fences", () => {
  assert.equal(stripCodeFence("```json\n{ }\n```"), "{ }")
  assert.equal(stripCodeFence("```xml\n<tag/>\n```"), "<tag/>")
  assert.equal(stripCodeFence("plain"), "plain")
})

test("returns no calls when there are no blocks", () => {
  assert.deepEqual(parseToolCalls("just a normal reply"), [])
})
