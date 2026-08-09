# opencode-human-relay

Human-in-the-loop LLM provider for [opencode](https://opencode.ai). Use ChatGPT,
Claude, Gemini, DeepSeek — any web AI with a copy button — as your coding
backend. opencode keeps full agentic power: file editing, bash, MCP tools,
permission prompts, git, and memory.

Inspired by [Roo Code's Human Relay mode](https://github.com/RooVetGit/Roo-Code/issues/1267).

## How it works

```
┌────────────────────────────────────────────────────────────┐
│  opencode (agent loop)                                      │
│   └─ LLM.stream ─► HumanRelayModel (this package)          │
│        ├─ render prompt + tool schemas to plain text        │
│        ├─ copy prompt to clipboard ──────────────┐          │
│        └─ wait for reply ◄────── bridge (127.0.0.1)         │
└──────────────────────────────────────────────┬──────────────┘
                                               │ paste
┌──────────────────────────────────────────────▼──────────────┐
│  You, in ChatGPT / Claude / any web AI                       │
│   1. paste the prompt, send it                                │
│   2. click copy on the reply                                  │
│   3. run  opencode-human-relay paste   (or just copy it)      │
└──────────────────────────────────────────────────────────────┘
```

The pasted reply is parsed for `<opencode:tool>` blocks, which become real tool
calls in opencode's agent loop — the web model can read files, run commands,
edit code, and use your MCP servers, exactly like a native API model.

## Why

- **Free coding** — run the full opencode agent loop on whatever web model you
  already pay for (ChatGPT, Claude, Gemini) without any API key or usage meters.
- **No API keys** — nothing leaves your machine except the prompt you choose to
  paste.
- **Bring your best model** — use a frontier model unavailable via API in the
  terminal.
- **Compatibility** — Roo Code shipped Human Relay in v3.8.0 and removed it when
  it broke tool calling. This package is a clean-room port designed around the
  opencode agent loop from the start, so tool calls survive the copy/paste round
  trip.

## Install

Install the CLI (optional but recommended) and register the provider:

```bash
npm install -g opencode-human-relay
```

Add to your `opencode.json` (global at `~/.config/opencode/opencode.json`, or a
project `opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "human-relay": {
      "npm": "opencode-human-relay",
      "name": "Human Relay (copy/paste)",
      "models": {
        "human-relay": { "name": "Human Relay" }
      },
      "options": {
        "relay": {
          "mode": "clipboard"
        }
      }
    }
  }
}
```

Then restart opencode and pick the **Human Relay** model with `/models`.

opencode auto-installs the `opencode-human-relay` npm package into its runtime
on the next start. You do not need to run `npm install` inside opencode.

## Usage

1. Start opencode with the Human Relay model selected and ask it something.
2. The prompt is copied to your clipboard automatically (clipboard mode).
3. Open your web AI, paste the prompt, send it.
4. Click **Copy** on the reply, then run:

   ```bash
   opencode-human-relay paste
   ```

   The reply is detected automatically and fed back to opencode. If clipboard
   detection is enabled you can often skip the `paste` step — copying the reply
   is enough (it is picked up within ~1.5s).

5. If the reply contains tool calls, opencode executes them and continues the
   loop — paste the next prompt the same way.

### Conversation mode (default)

In `conversation` mode (the default) the web chat itself is the conversation
state. The first relay for a new task pastes the full prompt — instructions,
tools, and history. Later relays for the same web chat paste only a small
delta: the new tool results and user messages. Your web AI's own replies stay
in the chat and are never re-pasted, so context grows slowly no matter how many
steps opencode runs. Paste each delta into the **same** chat.

If a reply contains a tool block that could not be parsed, the next relay appends
a short format reminder — and only then. Set `relay.promptMode: "full"` to go
back to re-pasting the entire prompt on every relay.

### CLI

```
opencode-human-relay status                     Bridge status + pending requests
opencode-human-relay get                        Print the current prompt to stdout
opencode-human-relay copy                       Re-copy the current prompt to clipboard
opencode-human-relay paste [text...]            Submit the reply (stdin, --clipboard, or args)
opencode-human-relay cancel                     Cancel the current pending request
```

`paste` accepts the reply from, in priority order:

- `--clipboard` — read the reply from the clipboard
- a positional argument (quote multi-line text)
- piped stdin: `echo "$reply" | opencode-human-relay paste`
- an interactive Ctrl+D-terminated prompt

### Manual mode (no clipboard / headless)

If no clipboard tool is available (headless server, SSH session), set:

```jsonc
"options": { "relay": { "mode": "manual" } }
```

Nothing is copied; opencode prints `[human-relay] Waiting for the web model's
reply. Run: opencode-human-relay paste`. Fetch the prompt with
`opencode-human-relay get` and submit with `opencode-human-relay paste`.

## Configuration

### Provider options (`options.relay`)

| Key                | Default    | Description                                                        |
| ------------------ | ---------- | ------------------------------------------------------------------ |
| `mode`             | `clipboard`| `clipboard` or `manual`. Falls back to `manual` when no clipboard tool exists. |
| `port`             | `17899`    | Loopback port for the bridge. Auto-increments if busy.             |
| `clipboardPollMs`  | `1500`     | Clipboard poll interval (ms) in clipboard mode.                    |
| `autoCopy`         | `true`     | Copy the prompt to the clipboard automatically.                    |
| `stateDir`         | OS data dir| Where the bridge state file lives (the CLI reads it).              |
| `instruction`      | built-in   | Extra instructions injected into every prompt.                     |
| `promptMode`       | `conversation`| `conversation` sends the instructions+tools once per web chat and then only deltas; `full` re-sends everything on every relay. |
| `banner`           | `true`     | Emit a short `[human-relay]` waiting banner as assistant text.     |
| `bannerMarker`     | `[human-relay]`| Marker stripped from assistant history when re-prompting.      |

### Environment variables

Same keys, uppercased and prefixed, taking priority over `opencode.json`:
`HUMAN_RELAY_MODE`, `HUMAN_RELAY_PROMPT_MODE`, `HUMAN_RELAY_PORT`,
`HUMAN_RELAY_CLIPBOARD_POLL_MS`, `HUMAN_RELAY_STATE_DIR`,
`HUMAN_RELAY_AUTO_COPY`.

### Per-request overrides

You can override mode/autocopy/prompt mode per call through AI SDK provider
options:

```ts
providerOptions: {
  "opencode-human-relay": { mode: "manual" },
}
```

Nested `relay` overrides work too:

```ts
providerOptions: {
  "opencode-human-relay": { relay: { mode: "manual", promptMode: "full" } },
}
```

## How tool calls survive copy/paste

In `full` mode every prompt includes the full conversation history (roles
labeled `User` / `Assistant` / `Tool result`, with prior tool calls in the same
XML format) plus the available tools and their JSON parameter schemas. In
`conversation` mode that block is pasted once and later relays only add new
tool results / user messages. Either way, the web model is instructed to emit a
single, unambiguous block when a tool is needed:

```xml
<opencode:tool name="read">
{"filePath": "src/index.ts"}
</opencode:tool>
```

The reply is parsed back into tool calls. Blocks wrapped in markdown code fences
are tolerated, and unparseable blocks are routed to opencode's tool-repair path
so the agent can recover instead of crashing.

## Architecture

- `src/model.ts` — `LanguageModelV3` implementation (`doStream` / `doGenerate`).
- `src/prompt.ts` — renders prompts + tool schemas to plain text; conversation
  tracking (full prompt once, then deltas) with fingerprint helpers.
- `src/parse.ts` — parses `<opencode:tool>` blocks from replies.
- `src/relay.ts` — pending-request manager (FIFO) + clipboard watcher +
  conversation state.
- `src/bridge.ts` — loopback HTTP server exposing the relay to the CLI.
- `src/cli.ts` — `opencode-human-relay` CLI.
- `src/state.ts` — process-wide singletons.

The bridge binds to `127.0.0.1` only, and every relay endpoint requires a
random per-process token stored in a `0600` state file. No data is ever sent
over the network by this package — you copy/paste manually.

## Security

- The bridge listens on loopback only; requests without the state-file token are
  rejected.
- The token and state file are created with `0600` permissions.
- No API keys, no telemetry, no external network calls.

## Limitations

- Copy/paste is manual: throughput is bounded by how fast you can paste.
- Long or multi-step agent sessions involve several copy/paste round trips.
  In `conversation` mode each subsequent paste is a short delta that must go
  into the **same** web chat.
- File attachments are represented as placeholders — the web model can't see
  local file bytes, but it can read them through the `read` tool.
- The web model must follow the tool-block format for tool calls to work; very
  stubborn models degrade to plain-text answers, which opencode still handles.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node test runner via tsx
npm run build       # tsc -> dist/
```

## License

MIT
