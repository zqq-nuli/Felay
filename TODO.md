# Felay TODO

## Features

### GUI: session connection notification
- GUI running in tray should pop up a notification when a new CLI session connects to the Daemon
- Priority: Medium

### Default bot auto-binding (DONE)
- Add a "default bot" setting so new sessions are automatically bound without manual GUI interaction
- Priority: High

### Interactive bot reply via Codex notify hook (DONE)
- For Codex sessions, replies use the `notify` hook in `~/.codex/config.toml` instead of PTY output parsing
- Codex fires `agent-turn-complete` event → `felay-notify.js` → Daemon IPC → Feishu plain text reply
- `last-assistant-message` field provides clean AI response text directly, no xterm rendering needed
- Non-Codex CLIs still fall back to xterm headless rendering + extractResponseText
- Key files: `scripts/felay-notify.js`, `feishuManager.ts` (`handleCodexNotify`), `daemon/index.ts` (`codex_notify` handler)

### Bot setup guide in dialog
- When adding a bot in GUI, show instructions for:
  - Where to create the Feishu app (link to developer console)
  - Required permissions to enable
  - Step-by-step configuration order
- Reference: OpenClaw Feishu integration guide (https://github.com/AlexAnys/openclaw-feishu)
- Priority: Medium

### Bot connection test
- Add real test functionality for both interactive and push bots
- Interactive: establish a temporary WSClient to verify long connection works
- Push: send a test message via webhook to verify delivery
- Priority: High

### Feishu domain selection (CN vs International)
- Add a global setting to choose between Feishu (CN) and Lark (International)
- Affects `Lark.Domain.Feishu` vs `Lark.Domain.Lark` in SDK initialization
- Currently hardcoded to `Lark.Domain.Feishu`
- Priority: Medium

### GUI auto-start Daemon
- When GUI launches, automatically start the Daemon if not running
- Use the existing `start_daemon` Tauri command
- Priority: High

### Fix reaction emoji type
- Current: `THUMBSUP` (👍), should be the "typing/keyboard" emoji (敲键盘)
- Need to find the correct `emoji_type` value from Feishu API
- Reference: https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce
- Priority: Low

### Codex notify hook auto-configuration
- When user runs `felay run codex`, auto-check `~/.codex/config.toml` for `notify` setting
- If not configured, auto-inject `notify = ["node", "<felay-notify.js path>"]` into config.toml
  - Must ensure `notify` is placed before any `[table]` sections (TOML requirement)
  - In production (pkg build), script path should point to install directory
- Add GUI settings page: "Codex Integration" panel
  - Show current notify hook configuration status (configured / not configured)
  - One-click setup button
  - Verify notify hook is working (test connection)
- Priority: High

### Bug: Codex 多轮对话时飞书输入偶尔不触发发送（Windows ConPTY 已知 Bug）
- **现象：** 第一轮对话正常，后续轮次中 `ptyProcess.write("\r")` 偶尔无法触发 Codex 提交，Enter 被当作换行处理。手动键盘输入不受影响。
- **根因：** Windows ConPTY 的已知 bug — TUI 应用在切换控制台模式时会导致 ConPTY 的输入模式标志位损坏，`\r` 不再被正确翻译为 VK_RETURN 键事件。
- **当前缓解方案：** 逐字符模拟输入（绕过 PasteBurst 检测）+ 多次补发 `\r`（500ms / 1200ms 后各补发一次）。大幅降低了发生频率但无法 100% 消除。
- **已尝试无效的方案：** `\n`、`\r\n`、分离延迟写入（150ms/300ms）、Kitty 键盘协议 `\x1b[13u`、Win32 Input Mode `\x1b[13;28;13;1;0;1_`
- **相关 Issues：**
  - [microsoft/terminal#19674](https://github.com/microsoft/terminal/issues/19674) — ConPTY 控制台模式在长时间 TUI 会话中损坏（核心 bug）
  - [microsoft/terminal#17401](https://github.com/microsoft/terminal/discussions/17401) — raw 模式下 Enter 键无法传递给应用
  - [microsoft/terminal#6859](https://github.com/microsoft/terminal/issues/6859) — ConPTY ENABLE_VIRTUAL_TERMINAL_INPUT 状态不同步
  - [microsoft/terminal#13738](https://github.com/microsoft/terminal/issues/13738) — SetConsoleMode 无效标志导致模式永久污染
  - [openai/codex#11214](https://github.com/openai/codex/issues/11214) — Codex CLI Windows 上 Enter 键失效
  - [openai/codex#9370](https://github.com/openai/codex/issues/9370) — Kitty 键盘协议在 Windows ConPTY 上引发异常
  - [openai/codex#7441](https://github.com/openai/codex/issues/7441) — 第二轮起输入不被插入（终端状态未正确恢复）
  - [openai/codex#8635](https://github.com/openai/codex/issues/8635) — 第一条消息后无法继续输入
- **结论：** 所有 Node.js PTY 库在 Windows 上都使用 ConPTY，无替代方案。此 bug 仅影响 Windows，macOS/Linux 不受影响。需等待 Microsoft 修复 ConPTY 或 Codex 修复终端状态管理。
- Priority: High (已缓解，无法彻底解决)

### Hide ended sessions
- Add filter in session list to show/hide ended sessions
- Ended sessions currently stay visible for 30 minutes
- Priority: Low
