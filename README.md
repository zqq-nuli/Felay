<div align="center">
  <img src="./packages/gui/src-tauri/icons/logo-%E9%80%8F%E6%98%8E.png" alt="Felay Logo" width="150"/>
  <h1>Felay</h1>
  <p><strong>Feishu (Lark) + Relay</strong></p>
  <p>将本地 AI CLI 桥接到飞书，实现双向对话和输出推送。</p>

  [English](./README_en.md) | 简体中文
</div>

---

## Felay 是什么？

Felay 通过 `felay run <command>` 包装本地 AI CLI（Codex / Claude Code / Gemini CLI），在本地终端和飞书机器人之间建立双向桥接。你可以在飞书里给 AI 发消息、接收回复，同时本地终端照常可用。

## 核心功能

- **双向对话** — 飞书 WSClient 长连接，文字/图片/富文本消息双向互通
- **Webhook 推送** — 单向通知，支持消息合并与限流
- **API 代理捕获** — 在 CLI 和上游 API 间插入本地代理，旁路解析 SSE 流，获取结构化回复（默认模式）
- **PTY 兜底解析** — 从终端输出中提取回复，适用于所有 CLI（需 `--pty` 标志）
- **会话结束卡片** — 会话结束时自动发送富文本总结到飞书
- **高可用** — Daemon 崩溃不影响本地 PTY，重启后自动恢复桥接
- **加密存储** — 飞书密钥 AES-256-GCM 加密，磁盘上始终密文
- **桌面 GUI** — Tauri 应用，系统托盘 + 会话管理 + 机器人配置

## 兼容性

| 功能 | Codex | Claude Code | Gemini CLI |
|------|:-----:|:-----------:|:----------:|
| 飞书文字 → CLI | ✅ | ✅ | ✅ |
| 飞书图片 → CLI | ✅ | ✅ | ✅ |
| 富文本（图文） → CLI | ✅ | ✅ | ✅ |
| AI 回复 → 飞书 | ✅ API 代理 | ✅ API 代理 | ✅ PTY 解析 |
| Webhook 推送 | ✅ | ✅ | ✅ |
| 会话结束通知 | ✅ | ✅ | ✅ |

### 平台状态

| 平台 | Daemon / IPC | GUI | 代理 & PTY | 飞书消息 |
|------|:------------:|:---:|:----------:|:--------:|
| Windows | ✅ 已验证 | ✅ 已验证 | ✅ 已验证 | ✅ 已验证 |
| macOS | ❓ 待测试 | ❓ 待测试 | ❓ 待测试 | ❓ 待测试 |
| Linux | ❓ 待测试 | ❓ 待测试 | ❓ 待测试 | ❓ 待测试 |

## 架构

进程间通信使用 Named Pipe (Windows) 或 Unix Socket (macOS/Linux)，**不暴露任何 TCP 端口**。

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

## 安装

### 环境要求

- **Node.js** >= 18
- **pnpm** >= 10
- **Rust**（仅构建 GUI 需要）

### 方式一：Windows 安装包

从 [Releases](https://github.com/zqq-nuli/Felay/releases) 下载 `.exe` 安装程序。

### 方式二：源码构建

```bash
git clone https://github.com/zqq-nuli/Felay.git
cd Felay

# 一键安装：安装依赖 + 编译 + 全局注册 felay 命令
pnpm run setup
```

如果只需编译不注册全局命令：

```bash
pnpm install
pnpm run build        # 编译 shared → daemon → cli
```

构建 GUI 桌面应用：

```bash
pnpm run build:gui    # 需要 Rust 环境
```

## 快速开始

```bash
# 1. 启动后台 Daemon
node packages/daemon/dist/index.js

# 2. 启动 CLI 代理会话（默认 API 代理模式）
felay run claude      # 或 felay run codex / felay run gemini

# 3. 在飞书中与机器人对话，消息会转发到本地 CLI
```

查看 Daemon 状态：

```bash
felay daemon status
```

## 配置

配置文件：`~/.felay/config.json`

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `reconnect.maxRetries` | 飞书长连接断开后最大重试次数 | 3 |
| `push.mergeWindow` | 推送消息合并窗口（毫秒） | 2000 |
| `input.enterRetryCount` | Enter 自动补发次数（仅 Windows） | 2 |

飞书机器人的 App ID、App Secret、Webhook URL 等通过 GUI 界面配置，密钥加密后存储在 `~/.felay/config.json` 中。

## TODO

- [ ] **交互式选项映射** — 将 CLI 的 TUI 交互（列表选择、确认提示）映射为飞书卡片组件（按钮、下拉菜单）
- [ ] **多级命令支持** — 支持 CLI 工具的级联菜单（如 `/model` → 模型选择），映射为飞书端的多级交互

## 已知问题

**Windows ConPTY Bug**：ConPTY 存在已知缺陷（[microsoft/terminal#19674](https://github.com/microsoft/terminal/issues/19674)），多轮对话中 Enter 键可能失效。Felay 通过自动补发机制缓解。macOS/Linux 不受影响。

## 许可协议

Custom Source-Available License — 仅限个人非商业使用。详见 [LICENSE](LICENSE)。
