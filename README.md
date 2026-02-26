<div align="center">
  <img src="./packages/gui/src-tauri/icons/logo-%E9%80%8F%E6%98%8E.png" alt="Felay Logo" width="150"/>
  <h1>Felay</h1>
  <p><strong>Feishu (Lark) + Relay</strong></p>
  <p>包装本地 AI CLI 工具，与飞书机器人桥接，实现双向对话与输出推送。</p>

  [English](./README_en.md) | 简体中文
</div>

---

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

进程间通信完全采用 Named Pipe (Windows) 或 Unix Socket (macOS/Linux)，**不暴露任何网络 TCP 端口**。

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

## 安装与使用

### 环境要求
- **Node.js** >= 18
- **pnpm** >= 10
- **Rust** (仅构建 GUI 需要)

### 安装指南
1. **Windows 安装程序**：从 Releases 下载 `.exe` 安装包。
2. **源码构建**：
   ```bash
   pnpm install
   pnpm run build:all
   ```

### 快速开始
启动代理会话：
```bash
felay run claude
```
手动管理后台服务：
```bash
felay daemon status
```

## 配置说明

配置文件位于 `~/.felay/config.json`：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `reconnect.maxRetries` | 飞书长连接断开后最大重试次数 | 3 |
| `push.mergeWindow` | 推送消息合并窗口（毫秒） | 2000 |
| `input.enterRetryCount` | Enter 自动补发次数（仅 Windows） | 2 |

## 待开发功能 (TODO)

我们计划在后续版本中引入以下特性，进一步补全与终端交互的深度，提升整体易用性：

1. **交互式选项与提问确认**：当底层 AI CLI 触发需要用户进行列表选择或确认的交互式提问时，目前无法在飞书端直接操作。未来计划将此类复杂的终端 TUI 交互映射为飞书卡片的交互组件（如按钮、下拉菜单），实现无缝的远程选择与反馈。
2. **多级命令与级联菜单支持**：针对部分 CLI 工具内置的多级命令体系（例如输入 `/model` 后展开的二级模型选择菜单），当前支持仍有局限。我们计划引入级联菜单的交互模式，完整支持复杂的二级或多级终端命令链路，大幅提升在飞书端下发复杂指令的灵活性。

## 已知问题

**Windows ConPTY Bug**：Windows 的 ConPTY 存在已知缺陷，可能导致多轮对话中 Enter 键失效。Felay 已通过自动补发机制缓解此问题。macOS/Linux 不受此影响。

## 许可协议
Custom Source-Available License — 仅限个人非商业使用。详见 [LICENSE](LICENSE)。
