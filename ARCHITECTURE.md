# Feishu CLI Proxy Architecture

**Overview**
This system enables a local proxy to start and manage `codex` or `claude code` CLI sessions, then selectively bridge those sessions to Feishu bots. Users can keep working locally without disruption and only enable proxying or push notifications when needed.

**Tech Stack**

| Layer | Technology | Notes |
|-------|-----------|-------|
| CLI | TypeScript / Node.js + commander + node-pty | PTY host process: owns PTY, forwards output stream to Daemon |
| Daemon | TypeScript / Node.js | Lightweight coordinator: Feishu connections, message routing, session registry, storage (does NOT own PTY) |
| GUI | Tauri 2.x (Rust) + Web frontend (TypeScript) | Lightweight desktop app, system tray resident |
| IPC | Unix Socket (macOS) / Named Pipe (Windows) | No TCP port, no network exposure, local-only |
| Feishu Interactive Bot | Feishu Event Subscription (WebSocket long connection) | Daemon uses SDK WSClient, outbound only |
| Feishu Push Bot | Webhook POST | One-way outbound push, rate limited to 5 QPS / 100 QPM |
| Secret Storage | keytar | Windows Credential Vault / macOS Keychain |
| Build | Tauri (GUI) + esbuild (CLI/Daemon) | |
| Monorepo | pnpm workspace | Packages: cli / daemon / gui / shared |

**Key Constraints**
- Every proxyable session must be started via `feishu run ...`.
- PTY is owned by the CLI process, NOT the Daemon. Closing the terminal = session ends.
- Daemon listens on Unix Socket / Named Pipe only. No TCP port, no network exposure.
- All Feishu communication is outbound (WSClient + Webhook POST). No inbound port needed.
- Task completion summaries are sent only to the interactive (two-way) bot.
- Process output (stdout, tool calls, errors, warnings) is sent only to the push bot when enabled.
- A single push bot may be bound to multiple sessions (messages carry session identifiers).
- Daemon crash does not kill CLI sessions; only the Feishu bridge is lost.

**Architecture Diagram**
```
┌──────────────────────────────────┐
│         Tauri GUI (Rust)          │
│  ┌────────────┐  ┌────────────┐  │
│  │ Rust 后端   │  │ Web 前端    │  │
│  │ - Tray 管理 │  │ - Vue/React │  │
│  │ - 窗口管理  │  │ - 会话列表  │  │
│  │ - 系统通知  │  │ - 机器人配置│  │
│  └──────┬─────┘  └────────────┘  │
│         │ Unix Socket / Named Pipe│
└─────────┼────────────────────────┘
          ▼
┌──────────────────────────────────┐
│    Daemon (Node.js, coordinator)  │
│  ┌──────────┐  ┌───────────────┐ │
│  │ Session  │  │ Feishu Conn.  │ │
│  │ Registry │  │ - WSClient    │ │
│  ├──────────┤  │   (outbound)  │ │
│  │  Router  │  │ - Webhook     │ │
│  ├──────────┤  │   (outbound)  │ │
│  │Summarizer│  └───────────────┘ │
│  ├──────────┤  ┌───────────────┐ │
│  │ IPC Srv  │  │   Storage     │ │
│  │ (socket) │  │   (keytar)    │ │
│  └──────────┘  └───────────────┘ │
│  No TCP port. No network listen. │
└──────────────────────────────────┘
          ▲
          │ Unix Socket / Named Pipe
┌─────────┴────────────────────────┐
│    CLI (Node.js, PTY host)        │
│  feishu run claude ...            │
│  ┌─────────────────────────────┐ │
│  │ PTY (node-pty)              │ │
│  │  - owns child process       │ │
│  │  - local terminal I/O       │ │
│  │  - streams output to Daemon │ │
│  │  - receives Feishu input    │ │
│  └─────────────────────────────┘ │
│  close terminal = session ends   │
└──────────────────────────────────┘
```

**Daemon Lifecycle**
1. **Lazy start**: CLI or GUI auto-launches Daemon if not running. No manual start required.
2. **Service discovery**: Daemon writes lock file `~/.feishu-cli/daemon.json` on startup:
   ```json
   {
     "pid": 12345,
     "ipc": "~/.feishu-cli/daemon.sock",
     "started_at": "2026-02-21T10:00:00Z"
   }
   ```
   Windows uses Named Pipe path: `\\.\pipe\feishu-cli`.
3. **Duplicate prevention**: Before starting, check lock file PID. If alive → connect. If stale → clean up and restart.
4. **Graceful shutdown**: `feishu daemon stop` notifies connected CLIs, closes Feishu connections, deletes lock file.
5. **CLI subcommands**: `feishu daemon start | stop | status`.
6. **No auto-start on boot**. Launched on demand only.

**Core Components**

| Component | Process | Responsibility |
|-----------|---------|---------------|
| CLI | Node.js | Parse `feishu run <cli> [args...]`, spawn PTY, relay terminal I/O, stream output to Daemon |
| PTY | CLI | Create and own PTY child process via node-pty, handle local terminal interaction |
| Bridge | CLI | Maintain IPC connection to Daemon, forward PTY output, receive Feishu input |
| Daemon | Node.js | Long-running lightweight background coordinator |
| Session Registry | Daemon | Track active sessions registered by CLI processes |
| Feishu Connector | Daemon | Manage Feishu bot connections: WSClient long connection + Webhook push (all outbound) |
| Router | Daemon | Route messages between Feishu bots and CLI sessions |
| Summarizer | Daemon | Extract task summary from CLI output on session end |
| Storage | Daemon | Encrypted bot credentials via keytar (system keychain) |
| IPC Server | Daemon | Listen on Unix Socket / Named Pipe for CLI and GUI connections |
| GUI/Tray | Tauri (Rust) | System tray, window management, native notifications |
| Web Frontend | Tauri (TypeScript) | Session list UI, bot configuration, binding controls |

**Project Structure**
```
feishu-cli/
├── packages/
│   ├── shared/            # Shared types, constants, utilities (TypeScript)
│   ├── cli/               # CLI entry point (TypeScript + node-pty)
│   │   └── src/
│   │       ├── pty/           # PTY creation and management
│   │       ├── bridge/        # IPC connection to Daemon, output forwarding
│   │       └── terminal/      # Local terminal I/O relay
│   ├── daemon/            # Background coordinator service (TypeScript)
│   │   └── src/
│   │       ├── session/       # Session registry
│   │       ├── feishu/        # Feishu API wrapper (WSClient + Webhook)
│   │       ├── router/        # Message routing
│   │       ├── summarizer/    # Task summary extraction
│   │       ├── storage/       # Encrypted storage
│   │       └── server/        # IPC server (Unix Socket / Named Pipe)
│   └── gui/               # Tauri desktop app
│       ├── src-tauri/         # Rust backend (tray, window, notifications)
│       └── src/               # Web frontend (TypeScript + Vue/React)
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

**Session Lifecycle**
1. User runs `feishu run claude ...` in a terminal.
2. CLI checks `~/.feishu-cli/daemon.json`. If Daemon not running, auto-launches it.
3. CLI spawns PTY with the target command, begins local terminal I/O.
4. CLI connects to Daemon via IPC (Unix Socket / Named Pipe) and registers the session → state: `listening`.
5. User binds an interactive bot in GUI → state: `proxy_on`.
6. Optionally enables push bot → state includes `push_on`.
7. User closes terminal → CLI exits → PTY child exits → Daemon marks session `ended`.

**Session States**
- `listening`: session started and observable, no Feishu bridging
- `proxy_on`: interactive bot bound, two-way bridging active
- `push_on`: process output pushed to push bot
- `ended`: CLI process exited, PTY child terminated

**Interactive Bot Message Flow (reference: OpenClaw)**
1. Feishu user sends message → Daemon receives via WSClient.
2. Daemon immediately adds 👀 emoji reaction to acknowledge receipt.
3. Daemon forwards message text to CLI via IPC → CLI writes to PTY stdin.
4. CLI streams PTY output back to Daemon.
5. Daemon sends reply as interactive card message, removes 👀 reaction.
6. Only plain text is extracted from Feishu messages; images/@mentions/stickers are ignored.

**Push Bot Message Format & Throttling**
- Format: rich text (post) with CLI output in code blocks.
- Output is sanitized: ANSI escape codes, color sequences, cursor control stripped.
- Merge window: output batched every 2-3 seconds into a single message (Webhook limit: 5 QPS / 100 QPM).
- Single message truncated at ~30KB, keeping the tail (most recent output).
- Progress bars, cursor movements, and other noise filtered out.
- On rate limit error (code 11232), merge window automatically increases.

**Message Routing Rules**
- Feishu input → interactive bot → Daemon → CLI (IPC) → PTY stdin
- PTY stdout → CLI (IPC) → Daemon → push bot (if enabled)
- Task completion summary → Daemon → interactive bot only (card message)

**Binding Rules**
- Each session must bind exactly one interactive bot when proxying.
- Push bot is optional and independently enabled.
- A push bot may serve multiple sessions; messages include session ID for disambiguation.
- Disabling proxy does not stop the CLI process.

**Task Completion**
- Primary: detect via CLI IPC disconnect (CLI process exited, PTY child terminated).
- Secondary: Claude Code hooks for richer completion signals.
- Summary: reuse CLI's final output rather than invoking a separate model.

**Feishu Long Connection**
- Daemon uses Feishu SDK `WSClient` to establish WebSocket long connection (outbound only).
- Subscribes to `im.message.receive_v1` event.
- No public callback URL needed, outbound network access only.
- Event handlers must complete within 3 seconds (otherwise Feishu retries).
- Reconnection: auto-retry on disconnect, max retries configurable (default 3), exponential backoff (default 5s base, multiplier 2: 5s → 10s → 20s). After max retries exceeded, notify user via GUI + system notification.

**Resilience**
- **Daemon crash**: CLI sessions continue running locally unaffected. Only Feishu bridge is lost. When Daemon restarts, CLI processes can reconnect and re-register sessions to restore bridging.
- **Feishu disconnect**: auto-retry with configurable exponential backoff. User notified on permanent failure.
- **CLI disconnect from Daemon**: Daemon marks session as `ended`, cleans up Feishu bindings.

**IPC & Service Discovery**
- Daemon listens on Unix Socket (`~/.feishu-cli/daemon.sock`) or Named Pipe (`\\.\pipe\feishu-cli`).
- No TCP port used. No network exposure.
- All Feishu communication is outbound (WSClient + Webhook POST).
- Lock file `~/.feishu-cli/daemon.json` stores PID and IPC path for service discovery.
- CLI/GUI reads lock file → validates PID → connects or auto-launches Daemon.

**Configuration**
```json
// ~/.feishu-cli/config.json
{
  "reconnect": {
    "max_retries": 3,
    "interval_ms": 5000,
    "backoff_multiplier": 2
  },
  "push": {
    "merge_window_ms": 2000,
    "max_message_bytes": 30000
  }
}
```

**Data Model (Minimal)**
```json
{
  "bots": {
    "interactive": [
      { "id": "bot-1", "name": "interactive-A", "app_id": "...", "secret": "..." }
    ],
    "push": [
      { "id": "bot-9", "name": "push-A", "webhook": "..." }
    ]
  },
  "sessions": [
    {
      "id": "s-123",
      "title": "claude:project-foo",
      "state": "proxy_on",
      "interactive_bot_id": "bot-1",
      "push_bot_id": "bot-9",
      "push_enabled": true
    }
  ]
}
```

**User Flow**
- User starts a session with `feishu run claude ...`.
- Daemon auto-launches if not running.
- GUI shows the session in the listening list.
- User selects the session, binds an interactive bot, and optionally a push bot.
- User enables proxy and push as needed.
- Local CLI remains fully usable.
- Closing the terminal ends the session.

**Extensibility**
- Claude Code hooks can help detect task completion or enrich summaries.
- MCP events can add structured tool-call output for push messages.
