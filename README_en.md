<div align="center">
  <img src="./packages/gui/src-tauri/icons/logo-%E9%80%8F%E6%98%8E.png" alt="Felay Logo" width="150"/>
  <h1>Felay</h1>
  <p><strong>Feishu (Lark) + Relay</strong></p>
  <p>Bridge local AI CLI tools with Feishu bots for bidirectional chat and output streaming.</p>

  English | [简体中文](./README.md)
</div>

---

## What is Felay?

**Felay** is a local proxy tool that bridges local AI CLI sessions (such as Codex, Gemini CLI, and Claude Code) with Feishu (Lark) bots. It allows developers to interact with their local AI CLI tools via Feishu messages (bidirectional chat) and push process output to a Feishu channel (one-way webhook push), all while keeping the local terminal session fully active and usable.

## Key Features

- **Bidirectional Chat:** Real-time bidirectional dialogue between CLI and Feishu via WebSockets.
- **Webhook Push:** One-way notification push for process outputs, featuring intelligent message merging and rate limiting.
- **Session Summaries:** Automatically sends a rich Feishu card containing the final output upon session completion.
- **Resilient Connectivity:** Disconnecting the daemon won't crash your local PTY. Auto-reconnection restores the bridge seamlessly.
- **Secure Credential Storage:** Feishu bot secrets are encrypted using AES-256-GCM and stored securely on your local disk.
- **GUI Management:** A Tauri-based desktop app providing a system tray, session bindings, bot management, and visual configurations.
- **Health Monitoring:** Continuous connection checks and automated warning notifications for WebSocket drops.

## Compatibility & Support

Felay is designed as a universal CLI proxy, currently optimized for three major AI CLI tools:

| Feature | Codex | Claude Code | Gemini CLI |
|---------|:-----:|:-----------:|:----------:|
| Feishu Text → CLI Input | ✅ | ✅ | ✅ |
| Feishu Image → CLI Input | ✅ | ✅ | ✅ |
| Rich Text (Img+Text) → CLI | ✅ | ✅ | ✅ |
| AI Response → Feishu Reply | ✅ API Proxy | ✅ API Proxy | ✅ PTY Parsing |
| Webhook Output Push | ✅ | ✅ | ✅ |
| Session End Notifications | ✅ | ✅ | ✅ |
| Markdown → Feishu Rich Text | ✅ | ✅ | ✅ |

> **AI Response Interception:**
> - **API Proxy (Default):** Intercepts API calls (Codex / Claude Code) via a local HTTP proxy to capture structural responses natively.
> - **PTY Parsing (Fallback):** Extracts responses directly from terminal output using virtual terminal rendering, available for any CLI.

### Platform Status

| Platform | Daemon / IPC | GUI (Tauri) | Proxy & PTY | Feishu Chat (Text & Image) |
|----------|:------------:|:-----------:|:-----------:|:--------------------------:|
| Windows | ✅ Verified | ✅ Verified | ✅ Verified | ✅ Verified |
| macOS | ❓ Untested | ❓ Untested | ❓ Untested | ❓ Untested |
| Linux | ❓ Untested | ❓ Untested | ❓ Untested | ❓ Untested |

## Architecture

Felay operates strictly via local inter-process communication (Named Pipes on Windows, Unix Sockets on macOS/Linux) with **no exposed TCP ports**.

```text
┌─────────────────────────────────┐
│        Tauri GUI (Rust)         │
│ System Tray · Session & Bots UI │
└────────────┬────────────────────┘
             │ Named Pipe / Unix Socket
┌────────────▼────────────────────┐
│     Daemon (Node.js)            │
│ Registry · Config · Routing     │
└────────────▲────────────────────┘
             │ Named Pipe / Unix Socket
┌────────────┴────────────────────┐
│      CLI (Node.js + PTY)        │
│  felay run <command> [args]     │
└─────────────────────────────────┘
```

## Prerequisites
- **Node.js** >= 18
- **pnpm** >= 10
- **Rust** (Required for building the GUI)

## Installation

### Windows Installer (Recommended)
Download the `Felay_x.x.x_x64-setup.exe` installer from the releases page and install it.
- Starts the GUI from the Start Menu or System Tray.
- Registers the `felay` CLI command globally.

### Build from Source
```bash
git clone https://github.com/zqq-nuli/Felay.git
cd Felay
pnpm install
pnpm run build:all    # Compile TS + build standalone binaries
pnpm run build:gui    # Build NSIS installer
```

### Developer Setup (CLI Only)
```bash
pnpm run setup        # Install dependencies and link the CLI globally
felay --help
```

## Usage

Start a session by wrapping your standard AI CLI command:

```bash
felay run claude                        # Default API Proxy mode
felay run codex                         # Default API Proxy mode
felay run --pty claude --project my-app # Forced PTY fallback mode
```

Manage the Daemon manually:
```bash
felay daemon start
felay daemon status
felay daemon stop
```

## License
Custom Source-Available License — For personal, non-commercial use only. See [LICENSE](LICENSE) for details.