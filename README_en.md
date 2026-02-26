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

## Setup & Usage

### Prerequisites
- **Node.js** >= 18
- **pnpm** >= 10
- **Rust** (Required for building the GUI)

### Installation
1. **Windows Installer**: Download `.exe` from Releases.
2. **Build from Source**:
   ```bash
   pnpm install
   pnpm run build:all
   ```

### Quick Start
Start a proxy session:
```bash
felay run claude
```
Manage the Daemon manually:
```bash
felay daemon status
```

## Configuration

Settings are stored in `~/.felay/config.json`:

| Key | Description | Default |
|-----|-------------|---------|
| `reconnect.maxRetries` | Maximum retries for Feishu WebSocket | 3 |
| `push.mergeWindow` | Message merge window for push (ms) | 2000 |
| `input.enterRetryCount` | Enter auto-retry count (Windows only) | 2 |

## Planned Features (TODO)

We are planning to introduce the following features in upcoming releases to deepen terminal interaction capabilities and improve overall usability:

1. **Interactive Prompts & Selections:** When the underlying AI CLI triggers an interactive prompt that requires user selection from a list or confirmation, it cannot currently be operated directly from Feishu. We plan to map these complex terminal TUI interactions into Feishu interactive card components (e.g., buttons, dropdown menus) for seamless remote selection and feedback.
2. **Multi-level Command & Cascading Menu Support:** Current support is limited for CLI tools that utilize a multi-level command structure (e.g., typing `/model` followed by a secondary menu to select a specific model). We plan to introduce cascading menu interaction modes to fully support complex, multi-level terminal command workflows, significantly enhancing the flexibility of issuing complex directives from Feishu.

## Known Issues

**Windows ConPTY Bug**: Windows' ConPTY has a defect where `\r` may not translate to Enter during multi-turn chats. Felay mitigates this by auto-retrying Enter keys. macOS/Linux are not affected.

## License
Custom Source-Available License — For personal, non-commercial use only. See [LICENSE](LICENSE) for details.
