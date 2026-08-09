import { test } from "node:test"
import assert from "node:assert/strict"
import { RelayManager, isAcceptableReply } from "../src/relay.js"
import type { RelayConversationState } from "../src/prompt.js"

test("resolve oldest is FIFO", async () => {
  const m = new RelayManager()
  const a = m.create("prompt-a", "manual")
  const b = m.create("prompt-b", "manual")
  assert.equal(m.count, 2)
  assert.equal(m.oldest?.prompt, "prompt-a")

  const id = m.resolveOldest("reply-to-a")
  assert.equal(id, a.id)
  assert.equal(await a.promise, "reply-to-a")
  assert.equal(m.count, 1)
  assert.equal(m.oldest?.prompt, "prompt-b")
})

test("resolve by id targets the right relay", async () => {
  const m = new RelayManager()
  const a = m.create("prompt-a", "manual")
  const b = m.create("prompt-b", "manual")
  assert.equal(m.resolve(b.id, "reply-b"), true)
  assert.equal(await b.promise, "reply-b")
  assert.equal(m.resolve(a.id, "reply-a"), true)
  assert.equal(await a.promise, "reply-a")
})

test("resolve on unknown id returns false", () => {
  const m = new RelayManager()
  assert.equal(m.resolve("nope", "x"), false)
  assert.equal(m.resolveOldest("x"), undefined)
})

test("cancel rejects the promise", async () => {
  const m = new RelayManager()
  const a = m.create("prompt-a", "manual")
  assert.equal(m.cancel(a.id, "cancelled"), true)
  await assert.rejects(a.promise, /cancelled/)
  assert.equal(m.count, 0)
})

test("cancelAll clears every relay", async () => {
  const m = new RelayManager()
  const a = m.create("prompt-a", "manual")
  const b = m.create("prompt-b", "manual")
  m.cancelAll("shutdown")
  await assert.rejects(a.promise, /shutdown/)
  await assert.rejects(b.promise, /shutdown/)
  assert.equal(m.count, 0)
})

test("list returns pending relays in order", () => {
  const m = new RelayManager()
  m.create("prompt-a", "manual")
  m.create("prompt-b", "manual")
  const list = m.list()
  assert.deepEqual(
    list.map((x) => x.prompt),
    ["prompt-a", "prompt-b"],
  )
})

test("prompts are stored trimmed", () => {
  const m = new RelayManager()
  m.create("  prompt-a\n\n", "manual")
  assert.equal(m.oldest?.prompt, "prompt-a")
})

test("create a prompt whose own text is copied back is not accepted as a reply", () => {
  const prompt = "# User\nhello\n\n<opencode:tool name=\"read\">\n{\"filePath\": \"src/index.ts\"}\n</opencode:tool>\n"
  // Regression: the clipboard returns the prompt minus its trailing newline.
  assert.equal(
    isAcceptableReply(prompt.slice(0, -1), [prompt], ""),
    false,
  )
})

test("a real reply is accepted even when it has surrounding whitespace", () => {
  assert.equal(isAcceptableReply("  hello-from-web\n\n", ["some prompt"], ""), true)
})

test("the last accepted reply is not accepted twice", () => {
  assert.equal(isAcceptableReply("hello", ["prompt"], "hello"), false)
})

test("a fresh identical copy is accepted (repeated short answers like hi)", () => {
  assert.equal(isAcceptableReply("hi", ["prompt"], "hi", false), true)
})

test("a stale identical reply is rejected while the clipboard is unchanged", () => {
  assert.equal(isAcceptableReply("hi", ["prompt"], "hi", true), false)
})

test("empty content is never accepted", () => {
  assert.equal(isAcceptableReply("   ", ["prompt"], ""), false)
})

test("create accepts a full input object and records fingerprint/isContinuation", () => {
  const m = new RelayManager()
  const r = m.create({
    prompt: "delta prompt",
    mode: "manual",
    fingerprint: "abc123",
    conversationId: "conv-1",
    isContinuation: true,
  })
  assert.equal(r.id.length > 0, true)
  assert.equal(m.oldest?.fingerprint, "abc123")
  assert.equal(m.oldest?.isContinuation, true)
  assert.equal(m.oldest?.prompt, "delta prompt")
})

test("activeConversation and markFormatFailure track the latest conversation", () => {
  const m = new RelayManager()
  assert.equal(m.activeConversation, undefined)

  const state: RelayConversationState = {
    id: "conv-2",
    toolFingerprint: "tf",
    fingerprint: "fp",
    staticBlock: "static",
    history: ["m1"],
    needsFormatReminder: false,
  }
  m.rememberConversation(state)
  assert.equal(m.activeConversation?.id, "conv-2")

  m.markFormatFailure("conv-2")
  assert.equal(m.activeConversation?.needsFormatReminder, true)

  const newer: RelayConversationState = { ...state, id: "conv-3", needsFormatReminder: false }
  m.rememberConversation(newer)
  assert.equal(m.activeConversation?.id, "conv-3")
  assert.equal(m.activeConversation?.needsFormatReminder, false, "flags do not leak across conversations")

  m.markFormatFailure("unknown-id")
  assert.equal(m.activeConversation?.needsFormatReminder, false)
})
