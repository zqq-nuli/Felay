<div align="center">
  <img src="./packages/gui/src-tauri/icons/logo-%E9%80%8F%E6%98%8E.png" alt="Felay Logo" width="150"/>
  <h1>Felay</h1>
  <p><strong>Feishu (Lark) + Relay</strong></p>
  <p>Bridge local AI CLI tools to Feishu for bidirectional chat and output push.</p>

  English | [简体中文](./README.md)
</div>

---

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

## TODO

- [ ] **Interactive prompt mapping** — Map CLI TUI interactions (list selection, confirmation prompts) to Feishu card components (buttons, dropdowns)
- [ ] **Multi-level command support** — Handle cascading CLI menus (e.g., `/model` → model picker) as multi-step Feishu interactions

## Known Issues

**Windows ConPTY Bug**: ConPTY has a known defect ([microsoft/terminal#19674](https://github.com/microsoft/terminal/issues/19674)) where Enter keys may fail during multi-turn conversations. Felay mitigates this with automatic retry. macOS/Linux are not affected.

## License

Custom Source-Available License — Personal, non-commercial use only. See [LICENSE](LICENSE).
