# Felay

本地代理工具，通过 `felay run ...` 启动 CLI 会话，将本地终端与飞书机器人桥接——支持双向交互对话和过程输出推送。

> **Felay** = **Fe**(ishu) + Re**lay** — 飞书中继

## 架构

```
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

| 层 | 技术 | 职责 |
|---|---|---|
| CLI | TypeScript, commander, node-pty | 持有 PTY 子进程，转发 I/O |
| Daemon | TypeScript, Zod | 后台协调服务，管理会话和配置 |
| GUI | Tauri 2.x (Rust) + React | 桌面端界面，系统托盘常驻 |
| Shared | TypeScript | 共享类型、IPC 消息定义 |

所有进程间通信使用 Named Pipe (Windows) 或 Unix Socket (macOS/Linux)，不监听任何网络端口。

## 项目结构

```
felay/
├── packages/
│   ├── shared/             # 共享类型与 IPC 消息定义
│   │   └── src/index.ts
│   ├── cli/                # CLI 入口
│   │   └── src/
│   │       ├── index.ts          # 命令解析 (felay run / daemon)
│   │       ├── daemonClient.ts   # Daemon IPC 客户端
│   │       └── daemonLifecycle.ts# 自动启动 Daemon
│   ├── daemon/             # 后台守护服务
│   │   └── src/
│   │       ├── index.ts          # IPC 服务器 + 消息路由
│   │       ├── ipc.ts            # IPC 路径
│   │       ├── sessionRegistry.ts# 会话注册表
│   │       ├── configManager.ts  # 配置持久化
│   │       ├── feishuManager.ts  # 飞书 SDK 交互
│   │       ├── outputBuffer.ts   # 输出缓冲（交互/推送/摘要）
│   │       ├── secretStore.ts    # AES-256-GCM 密钥加密
│   │       └── sanitizer.ts      # ANSI 清洗 + 噪音过滤
│   └── gui/                # Tauri 桌面应用
│       ├── src-tauri/
│       │   └── src/main.rs       # Rust 后端 (Tauri commands + 系统托盘)
│       └── src/
│           ├── App.tsx           # React 前端组件
│           ├── styles.css        # 样式
│           └── main.tsx          # 入口
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

## 核心功能

- **双向机器人**：通过飞书 WSClient 长连接实现 CLI ↔ 飞书双向对话
- **推送机器人**：Webhook 单向通知，支持合并窗口与限流处理
- **任务结束总结**：会话退出时发送包含最后输出的飞书卡片
- **CLI 断线重连**：Daemon 崩溃不影响本地 PTY，重启后自动恢复桥接
- **密钥加密存储**：AES-256-GCM 加密机器人密钥，磁盘上始终密文
- **GUI 管理界面**：会话绑定、机器人增删改查、密码可见切换、动态托盘菜单
- **健康监测**：WSClient 断连检测与警告通知

## CLI 兼容性

Felay 设计为通用 CLI 代理，目前重点支持以下三个 AI CLI 工具：

### 功能支持

| 功能 | Codex | Gemini CLI | Claude Code |
|------|:-----:|:----------:|:-----------:|
| 飞书发送文字 → CLI 输入 | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| AI 响应 → 飞书富文本回复 | :white_check_mark: Notify Hook | :white_check_mark: PTY 解析 | :white_check_mark: PTY 解析 |
| 推送机器人（Webhook 输出推送） | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| 会话结束卡片通知 | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| Markdown → 飞书 Post 富文本渲染 | :white_check_mark: | :white_check_mark: | :white_check_mark: |

> **AI 响应获取方式：**
> - **Notify Hook**（Codex 专用）：通过 Codex 的 `notify` 钩子直接获取 AI 原始回复文本，无需解析终端输出，响应更干净准确
> - **PTY 解析**（通用方案）：通过虚拟终端渲染 + 文本提取从 PTY 输出中解析 AI 响应，适用于所有 CLI

### 平台测试状态

| 平台 | Codex | Gemini CLI | Claude Code |
|------|:-----:|:----------:|:-----------:|
| Windows | :white_check_mark: 已测试 | :grey_question: 待测试 | :grey_question: 待测试 |
| macOS | :grey_question: 待测试 | :grey_question: 待测试 | :grey_question: 待测试 |
| Linux | :grey_question: 待测试 | :grey_question: 待测试 | :grey_question: 待测试 |

### 使用示例

```bash
felay run codex          # 包装 Codex
felay run gemini         # 包装 Gemini CLI
felay run claude         # 包装 Claude Code
```

### 已知问题

| 问题 | 影响范围 | 严重程度 | 状态 |
|------|---------|---------|------|
| 多轮对话 Enter 键偶尔失效 | 仅 Windows，所有 CLI | 中 | 已缓解 |

**Windows ConPTY Bug：** Windows 的 ConPTY 存在已知 Bug（[microsoft/terminal#19674](https://github.com/microsoft/terminal/issues/19674)），TUI 程序在多轮对话中切换控制台模式后，`\r` 可能不再被正确翻译为 Enter 键事件。Felay 通过逐字符模拟输入 + 自动补发 Enter 来缓解此问题，补发次数和间隔可在 GUI 设置中调整。**macOS / Linux 不受此问题影响。**

## 前置要求

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/) >= 10
- [Rust](https://www.rust-lang.org/tools/install) (构建 GUI 需要)

## 安装

### Windows 安装程序（推荐）

下载 `Felay_x.x.x_x64-setup.exe` 安装程序，双击安装即可。

安装后：
- GUI 从开始菜单或系统托盘启动
- CLI 命令 `felay` 全局可用（自动注册 PATH）
- 卸载在 **设置 → 应用 → 已安装的应用** 中完成

### 从源码构建

> 需要 Node.js >= 18、pnpm >= 10、[Rust](https://www.rust-lang.org/tools/install)

```bash
git clone https://github.com/zqq-nuli/Felay.git
cd Felay
pnpm install
pnpm run build:all    # 编译 TS + 打包独立 exe
pnpm run build:gui    # 构建 NSIS 安装程序（含 GUI + CLI + Daemon）
# 安装包输出在 packages/gui/src-tauri/target/release/bundle/nsis/
```

### 开发者安装（仅 CLI）

```bash
pnpm run setup    # 安装依赖 + 编译 + 全局注册 felay 命令（需要 Node.js）
felay --help
```

## 开发

```bash
# 启动 Daemon + CLI（开发模式）
pnpm dev

# 仅启动 Daemon
pnpm dev:daemon

# 仅启动 CLI
pnpm dev:cli

# 启动 GUI（会同时启动前端 dev server 和 Tauri）
pnpm dev:gui
```

## 类型检查

```bash
pnpm typecheck
```

## 测试

详见 [TESTING.md](./TESTING.md) 中的手动测试指南，覆盖所有核心功能场景。

## 使用方式

### 1. 启动会话

在终端中运行：

```bash
felay run <command> [args...]
```

示例：

```bash
felay run echo hello
felay run claude --project my-project
```

CLI 会自动拉起 Daemon（如果未运行），通过 PTY 启动子进程并注册会话。

### 2. 管理 Daemon

```bash
felay daemon start    # 手动启动
felay daemon status   # 查看状态
felay daemon stop     # 优雅关闭
```

### 3. GUI 操作

启动 GUI 后可在界面中：

- **会话页** — 查看活跃会话列表，为会话绑定/解绑双向机器人和推送机器人
- **机器人页** — 添加、编辑、删除双向机器人（App ID + Secret）和推送机器人（Webhook）
- **设置页** — 修改重连策略和推送参数，保存到配置文件

## 配置

配置文件位于 `~/.felay/config.json`，首次启动 Daemon 时自动创建：

```json
{
  "bots": {
    "interactive": [],
    "push": []
  },
  "reconnect": {
    "maxRetries": 3,
    "initialInterval": 5,
    "backoffMultiplier": 2
  },
  "push": {
    "mergeWindow": 2000,
    "maxMessageBytes": 30000
  },
  "input": {
    "enterRetryCount": 2,
    "enterRetryInterval": 500
  }
}
```

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `reconnect.maxRetries` | 飞书长连接断开后最大重试次数 | 3 |
| `reconnect.initialInterval` | 初始重试间隔（秒） | 5 |
| `reconnect.backoffMultiplier` | 指数退避倍数 | 2 |
| `push.mergeWindow` | 推送消息合并窗口（毫秒） | 2000 |
| `push.maxMessageBytes` | 单条推送消息上限（字节） | 30000 |
| `input.enterRetryCount` | Enter 自动补发次数（仅 Windows） | 2 |
| `input.enterRetryInterval` | Enter 补发间隔（毫秒，仅 Windows） | 500 |

## 数据文件

| 文件 | 用途 |
|------|------|
| `~/.felay/daemon.json` | Daemon 锁文件（PID + IPC 地址） |
| `~/.felay/config.json` | 机器人配置 + 应用设置（密钥已加密） |
| `~/.felay/.master-key` | AES-256-GCM 主密钥（权限受限） |

## IPC 协议

Daemon 使用 JSON-line 协议通信（每条消息一行 JSON + `\n`）。

| 消息类型 | 方向 | 说明 |
|----------|------|------|
| `register_session` | CLI → Daemon | 注册新会话 |
| `pty_output` | CLI → Daemon | PTY 输出转发 |
| `session_ended` | CLI → Daemon | 会话结束 |
| `feishu_input` | Daemon → CLI | 飞书用户输入转发到 PTY |
| `status_request/response` | Any → Daemon | 查询状态 |
| `stop_request/response` | Any → Daemon | 停止 Daemon |
| `list_bots_request/response` | GUI → Daemon | 列出所有机器人 |
| `save_bot_request/response` | GUI → Daemon | 新增/编辑机器人 |
| `delete_bot_request/response` | GUI → Daemon | 删除机器人 |
| `bind_bot_request` / `unbind_bot_request` | GUI → Daemon | 绑定/解绑机器人 |
| `test_bot_request/response` | GUI → Daemon | 测试机器人连接 |
| `get_config_request/response` | GUI → Daemon | 读取配置 |
| `save_config_request/response` | GUI → Daemon | 保存配置 |

## 会话状态

| 状态 | 含义 |
|------|------|
| `listening` | 会话已注册，等待绑定机器人 |
| `proxy_on` | 双向机器人已绑定，代理活跃 |
| `ended` | CLI 进程已退出 |

## 里程碑

- [x] **M1** — CLI + PTY + Daemon IPC + 会话注册
- [x] **M2** — 机器人配置 CRUD + 会话绑定 + 设置持久化
- [x] **M3** — 飞书双向对话与过程推送
- [x] **M4** — 任务结束总结、CLI 断线重连、密钥加密、健康监测

## 许可

Custom Source-Available License — 仅限个人非商业使用。详见 [LICENSE](LICENSE)。
