<div align="center">
  <img src="./packages/gui/src-tauri/icons/logo-%E9%80%8F%E6%98%8E.png" alt="Felay Logo" width="150"/>
  <h1>Felay</h1>
  <p><strong>Feishu (Lark) + Relay</strong></p>
  <p>Bridge local AI CLI tools with Feishu bots for bidirectional chat and output streaming.</p>

  [English](#english) | [简体中文](#简体中文)
</div>

---

<h2 id="english">🇬🇧 English</h2>

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

---

<h2 id="简体中文">🇨🇳 简体中文</h2>

## Felay 是什么？

**Felay** 是一个本地代理工具，旨在通过 `felay run ...` 包装并启动本地 AI CLI 会话（如 Codex, Gemini CLI, Claude Code），将本地终端与飞书（Lark）机器人无缝桥接。它支持通过飞书进行双向交互对话，以及向飞书群组单向推送终端输出，同时保持本地终端会话的完全可用性。

## 核心功能

- **双向交互**：通过飞书 WSClient 长连接实现本地 CLI 与飞书双向实时对话。
- **推送机器人**：Webhook 单向通知，支持智能的输出合并与限流处理。
- **任务总结卡片**：会话结束时，自动向飞书发送包含最终执行结果的富文本卡片。
- **高可用重连**：后台 Daemon 崩溃不会影响本地 PTY 进程，重启后自动恢复桥接。
- **极简安全**：飞书机器人密钥采用 AES-256-GCM 加密，磁盘上始终密文存储。
- **可视化管理**：基于 Tauri 的桌面 GUI，支持系统托盘、会话绑定、机器人管理与配置调整。
- **健康监测**：WSClient 断连自动检测与警告通知机制。

## 兼容性与支持

Felay 设计为通用 CLI 代理，目前重点支持以下三个 AI CLI 工具：

| 功能 | Codex | Claude Code | Gemini CLI |
|------|:-----:|:-----------:|:----------:|
| 飞书发送文字 → CLI 输入 | ✅ | ✅ | ✅ |
| 飞书发送图片 → CLI 输入 | ✅ | ✅ | ✅ |
| 富文本（图文） → CLI | ✅ | ✅ | ✅ |
| AI 响应 → 飞书回复 | ✅ API 代理 | ✅ API 代理 | ✅ PTY 解析 |
| Webhook 输出推送 | ✅ | ✅ | ✅ |
| 会话结束卡片通知 | ✅ | ✅ | ✅ |
| Markdown → 飞书富文本 | ✅ | ✅ | ✅ |

> **AI 响应获取机制：**
> - **API 代理（默认）：** 在 CLI 和上游 API 之间插入本地 HTTP 代理，透明转发流量并旁路解析 SSE 流，获取结构化响应（质量最高）。
> - **PTY 解析（兜底）：** 通过虚拟终端渲染与文本提取，直接从 PTY 输出中解析响应（适用于所有 CLI 工具）。

### 平台测试状态

| 平台 | Daemon / IPC | GUI (Tauri) | 代理与 PTY | 飞书消息收发 |
|------|:------------:|:-----------:|:----------:|:------------:|
| Windows | ✅ 已验证 | ✅ 已验证 | ✅ 已验证 | ✅ 已验证 |
| macOS | ❓ 待测试 | ❓ 待测试 | ❓ 待测试 | ❓ 待测试 |
| Linux | ❓ 待测试 | ❓ 待测试 | ❓ 待测试 | ❓ 待测试 |

## 架构设计

进程间通信完全采用 Named Pipe (Windows) 或 Unix Socket (macOS/Linux)，**不暴露任何网络 TCP 端口**，保障本地系统安全。

```text
┌─────────────────────────────────┐
│        Tauri GUI (Rust)         │
│  系统托盘 · 会话管理 · 机器人配置   │
└────────────┬────────────────────┘
             │ Named Pipe / Unix Socket
┌────────────▼────────────────────┐
│     Daemon (Node.js)            │
│  会话注册 · 配置管理 · 消息路由    │
└────────────▲────────────────────┘
             │ Named Pipe / Unix Socket
┌────────────┴────────────────────┐
│      CLI (Node.js + PTY)        │
│  felay run <command> [args]     │
└─────────────────────────────────┘
```

## 环境要求
- **Node.js** >= 18
- **pnpm** >= 10
- **Rust** (仅构建 GUI 需要)

## 安装指南

### Windows 安装程序（推荐）
下载 `Felay_x.x.x_x64-setup.exe` 安装程序，双击安装。
- GUI 将从系统托盘启动。
- 自动注册全局 `felay` 命令行指令。

### 从源码构建
```bash
git clone https://github.com/zqq-nuli/Felay.git
cd Felay
pnpm install
pnpm run build:all    # 编译 TS + 打包独立二进制文件
pnpm run build:gui    # 构建 NSIS 桌面安装程序
```

### 开发者安装（仅 CLI）
```bash
pnpm run setup        # 安装依赖、编译并全局链接 felay 命令
felay --help
```

## 使用方式

启动代理会话，只需在原命令前加上 `felay run`：

```bash
felay run claude                        # 默认 API 代理模式
felay run codex                         # 默认 API 代理模式
felay run --pty claude --project my-app # 强制使用 PTY 兜底模式
```

后台 Daemon 的手动管理：
```bash
felay daemon start
felay daemon status
felay daemon stop
```

## 许可协议
Custom Source-Available License — 仅限个人非商业使用。详见 [LICENSE](LICENSE)。