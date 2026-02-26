<div align="center">
  <img src="./packages/gui/src-tauri/icons/logo-%E9%80%8F%E6%98%8E.png" alt="Felay Logo" width="150"/>
  <h1>Felay</h1>
  <p><strong>Feishu (Lark) + Relay</strong></p>
  <p>Bridge local AI CLI tools to Feishu for bidirectional chat and output push.</p>

  English | [简体中文](./README.md)
</div>

---

<p align="center">
  <a href="#what-is-felay">About</a> · <a href="#features">Features</a> · <a href="#compatibility">Compatibility</a> · <a href="#architecture">Architecture</a> · <a href="#installation">Install</a> · <a href="#quick-start">Quick Start</a> · <a href="#configuration">Config</a> · <a href="#feishu-bot-setup">Feishu Setup</a> · <a href="#why-felay">Why Felay</a> · <a href="#license">License</a>
</p>

## What is Felay?

Felay wraps local AI CLIs (Codex / Claude Code / Gemini CLI) via `felay run <command>`, bridging your local terminal with a Feishu (Lark) bot. Send messages to the AI from Feishu, receive replies back — while your local terminal stays fully usable.

## Features

- **Bidirectional Chat** — Real-time text/image/rich-text messaging between Feishu and CLI via WebSocket
- **Webhook Push** — One-way notifications with message merging and rate limiting
- **API Proxy Capture** — Local proxy between CLI and upstream API, intercepting SSE streams for structured responses (default mode)
- **PTY Fallback** — Extracts replies from terminal output, works with any CLI (requires `--pty` flag)
- **Session Summary Cards** — Sends a rich-text summary to Feishu when a session ends
- **Resilient** — Daemon crashes don't affect local PTY; bridge auto-recovers on restart
- **Encrypted Storage** — Feishu secrets encrypted with AES-256-GCM at rest
- **Desktop GUI** — Tauri app with system tray, session management, and bot configuration

## Compatibility

| Feature | Codex | Claude Code | Gemini CLI |
|---------|:-----:|:-----------:|:----------:|
| Feishu Text → CLI | ✅ | ✅ | ✅ |
| Feishu Image → CLI | ✅ | ✅ | ✅ |
| Rich Text (Img+Text) → CLI | ✅ | ✅ | ✅ |
| AI Response → Feishu | ✅ API Proxy | ✅ API Proxy | ✅ PTY Parsing |
| Webhook Push | ✅ | ✅ | ✅ |
| Session End Notification | ✅ | ✅ | ✅ |

### Platform Status

| Platform | Daemon / IPC | GUI | Proxy & PTY | Feishu Chat |
|----------|:------------:|:---:|:-----------:|:-----------:|
| Windows | ✅ Verified | ✅ Verified | ✅ Verified | ✅ Verified |
| macOS | ❓ Untested | ❓ Untested | ❓ Untested | ❓ Untested |
| Linux | ❓ Untested | ❓ Untested | ❓ Untested | ❓ Untested |

## Architecture

All IPC uses Named Pipes (Windows) or Unix Sockets (macOS/Linux). **No TCP ports are exposed.**

```text
┌─────────────────────────────────┐
│        Tauri GUI (Rust)         │
│ System Tray · Sessions · Bots  │
└────────────┬────────────────────┘
             │ Named Pipe / Unix Socket
┌────────────▼────────────────────┐
│     Daemon (Node.js)            │
│ Registry · Config · Routing    │
└────────────▲────────────────────┘
             │ Named Pipe / Unix Socket
┌────────────┴────────────────────┐
│      CLI (Node.js + PTY)        │
│  felay run <command> [args]     │
└─────────────────────────────────┘
```

## Installation

### Prerequisites

- **Node.js** >= 18
- **pnpm** >= 10
- **Rust** (only required for building the GUI)

### Option 1: Windows Installer

Download the `.exe` installer from [Releases](https://github.com/zqq-nuli/Felay/releases).

### Option 2: Build from Source

```bash
git clone https://github.com/zqq-nuli/Felay.git
cd Felay

# One-step setup: install deps + build + register global felay command
pnpm run setup
```

To build without registering the global command:

```bash
pnpm install
pnpm run build        # Compiles shared → daemon → cli
```

To build the GUI desktop app:

```bash
pnpm run build:gui    # Requires Rust toolchain
```

## Quick Start

```bash
# 1. Start the background Daemon
node packages/daemon/dist/index.js

# 2. Start a CLI proxy session (API proxy mode by default)
felay run claude      # or: felay run codex / felay run gemini

# 3. Chat with the bot in Feishu — messages are relayed to your local CLI
```

Check Daemon status:

```bash
felay daemon status
```

## Configuration

Config file: `~/.felay/config.json`

| Key | Description | Default |
|-----|-------------|---------|
| `reconnect.maxRetries` | Max reconnection attempts for Feishu WebSocket | 3 |
| `push.mergeWindow` | Push message merge window (ms) | 2000 |
| `input.enterRetryCount` | Enter key auto-retry count (Windows only) | 2 |

Feishu bot credentials (App ID, App Secret, Webhook URL) are configured through the GUI and stored encrypted in `~/.felay/config.json`.

## Feishu Bot Setup

Felay uses two bots working together:

- **Bidirectional Bot** — Pushes final AI replies and receives your messages, enabling two-way conversation
- **Push Bot (Webhook)** — Pushes all messages including intermediate streaming output during processing

### Bidirectional Bot

### 1. Create an App

Go to [Feishu Open Platform](https://open.feishu.cn/app) and create a new enterprise app.

### 2. Add Bot Capability

In the app details → **App Capabilities** → add **Bot**.

### 3. Configure Permissions

Go to **Permissions Management**, search `im:` to filter, and add all IM-related permissions:

- App identity permissions (`tenant_access_token`)
- User identity permissions (`user_access_token`)

### 4. Publish the App

After configuring permissions, create and publish the first version.

### 5. Bind to Felay

Open the Felay GUI, bind the bot (enter App ID and App Secret), and click **Create Long Connection**.

### 6. Configure Event Callbacks

Go back to Feishu Open Platform, enter the app details:

**Event Callbacks** — Set request method to **Long Connection**, save, then add these events:
- `im.chat.access_event.bot_p2p_chat_entered_v1` (bot enters P2P chat)
- `im.message.message_read_v1` (message read)
- `im.message.receive_v1` (receive message)

**Callback Configuration** — Set request method to **Long Connection**, save, then add these callbacks:
- `card.action.trigger` (card interaction)
- `url.preview.get` (link preview)
- `profile.view.get` (profile view)

### 7. Start Using

Once configured, search for your bot name in Feishu and send a message to start chatting.

### Push Bot (Webhook)

The push bot forwards all messages to a group chat, including tool calls and intermediate streaming output:

1. Create a group chat in Feishu
2. Group settings → **Bots** → Add **Custom Bot**
3. Copy the generated Webhook URL
4. Paste the Webhook URL in the Felay GUI

## Why Felay?

We used to be tied down by dev tools, now it's AI CLIs — either way, you end up staring at a black terminal window all day.

AI is already pretty capable. A lot of the time you could just send a prompt and walk away. But you don't, because you need to watch the output and reply when it asks questions.

My health hasn't been great these past couple of years. I kept wanting to get out, experience life a bit, but there was always some dev task keeping me glued to my desk. The idea of remotely controlling my terminal had been in my head for a long time. Then I tried OpenClaw, and the thing that struck me most wasn't the product itself — it was the ability to plug into tools like Feishu and Telegram, so terminal work could happen from your phone. I finally committed to building it over the Chinese New Year break, and that became Felay. Recently Anthropic launched Claude Remote, which is a similar direction, but for now it only works in their own app and requires auth login.

Why not just call the API directly with streaming JSON, like projects such as vibe-kanban, and build a standalone UI? Because I want to know exactly what's happening on my machine. I don't want to hand things off to a black box and hope for the best. Felay keeps your local terminal fully intact — start it before you leave your desk, follow along on your phone while the AI keeps working, and when you sit back down, everything is right there in the terminal. You can pick up exactly where it left off.

## TODO

- [ ] **TODO list display** — AI CLIs create TODO lists during task execution; sync and display them in Feishu for real-time progress tracking
- [ ] **Interactive prompt mapping** — Map CLI TUI interactions (list selection, confirmation prompts) to Feishu card components (buttons, dropdowns)
- [ ] **Multi-level command support** — Handle cascading CLI menus (e.g., `/model` → model picker) as multi-step Feishu interactions

## Known Issues

**Windows ConPTY Bug**: ConPTY has a known defect ([microsoft/terminal#19674](https://github.com/microsoft/terminal/issues/19674)) where Enter keys may fail during multi-turn conversations. Felay mitigates this with automatic retry. macOS/Linux are not affected.

## License

Custom Source-Available License — Personal, non-commercial use only. See [LICENSE](LICENSE).
