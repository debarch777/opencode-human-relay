# opencode-human-relay

[![npm version](https://img.shields.io/npm/v/opencode-human-relay?logo=npm)](https://www.npmjs.com/package/opencode-human-relay)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![CI](https://img.shields.io/github/actions/workflow/status/debarch777/opencode-human-relay/ci.yml?branch=main&logo=github)](https://github.com/debarch777/opencode-human-relay/actions)

Human-in-the-loop LLM provider for [opencode](https://opencode.ai). Use ChatGPT,
Claude, Gemini, DeepSeek — any web AI with a copy button — as your coding
backend. opencode keeps full agentic power: file editing, bash, MCP tools,
permission prompts, git, and memory.

Inspired by [Roo Code's Human Relay mode](https://github.com/RooVetGit/Roo-Code/issues/1267).

## Requirements

- **Node.js ≥ 18** (Node 20, 22, and 24 are tested in CI)
- **opencode ≥ 1.17** ([install](https://opencode.ai/docs/))
- **A web AI with a copy button** — ChatGPT, Claude, Gemini, DeepSeek, ...
- Clipboard support for the auto-paste flow:
  - Linux/Wayland: `wl-clipboard` (`wl-paste` / `wl-copy`)
  - Linux/X11: `xclip` or `xsel`
  - macOS: built-in `pbpaste` / `pbcopy`
  - Windows: built-in PowerShell clipboard
  - No clipboard tool? Use [manual mode](#manual-mode-no-clipboard--headless).

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

The provider installs itself through opencode — you don't manage anything
inside opencode. Just register it in your config and opencode will auto-install
the npm package on its next start. The global CLI is optional (you only need it
for the manual `paste`/`get` flow; in clipboard mode copying the reply is enough).

### 1. Register the provider

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

### 2. Pick the model

Restart opencode (or run `/models` in the TUI) and select **Human Relay**.

opencode auto-installs the `opencode-human-relay` package into its runtime on
the next start — no manual `npm install` inside opencode.

### 3. (Optional) Install the CLI globally

Only needed for manual mode, scripting, or debugging:

```bash
npm install -g opencode-human-relay
```

You can also install directly from GitHub:

```bash
npm install -g github:debarch777/opencode-human-relay
```

Verify it works:

```bash
opencode-human-relay --help
```

> **Tip:** if you built the CLI from a local checkout, link it instead:
> `npm install -g /path/to/opencode-human-relay`.

## Usage

**Quick start:** ask opencode something → prompt is copied to your clipboard →
paste it into your web AI → click **Copy** on the reply → it is detected
automatically within ~1.5s and fed back to opencode. Repeat for every step.

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

## Troubleshooting

**Nothing happens when I copy the reply.** Check `opencode-human-relay status`
to see the pending request and the bridge. If the bridge is unreachable, the
opencode session that owns the relay is not running — start it first. In
clipboard mode the copy must land on the **same** machine/desktop session that
runs opencode (SSH or a different Wayland/X11 seat won't share the clipboard).

**The prompt isn't copied automatically.** You're probably on a system without a
detected clipboard tool, or `relay.autoCopy` is `false`. Run
`opencode-human-relay get` to print the prompt manually, or switch to
[manual mode](#manual-mode-no-clipboard--headless).

**The web AI answers with plain text and no tool call.** Some models are
reluctant to emit the `<opencode:tool>` block. Re-read the "How tool calls
survive copy/paste" section and mention the format to the model, or try a
different web AI.

**Repeated short answers like "hi" get ignored.** A reply that is identical to
the last accepted one is only accepted when the clipboard actually changed
(a fresh copy). Make a fresh copy (select + copy again) — it will be accepted.

**The session title says "New session".** Background title-generation calls are
skipped on purpose so they never consume your real reply. The title is cosmetic
and can be renamed.

**Multi-step agent runs need many paste rounds.** That's expected. In
`conversation` mode each paste is a short delta — make sure you paste into the
**same** web chat. To see full context every time, set
`relay.promptMode: "full"`.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node test runner via tsx
npm run build       # tsc -> dist/
```

## License

MIT
