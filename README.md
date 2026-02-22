# Feishu CLI Proxy

本地代理工具，通过 `feishu run ...` 启动 CLI 会话，将本地终端与飞书机器人桥接——支持双向交互对话和过程输出推送。

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
│  feishu run <command> [args]    │
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
feishu-cli/
├── packages/
│   ├── shared/             # 共享类型与 IPC 消息定义
│   │   └── src/index.ts
│   ├── cli/                # CLI 入口
│   │   └── src/
│   │       ├── index.ts          # 命令解析 (feishu run / daemon)
│   │       ├── daemonClient.ts   # Daemon IPC 客户端
│   │       └── daemonLifecycle.ts# 自动启动 Daemon
│   ├── daemon/             # 后台守护服务
│   │   └── src/
│   │       ├── index.ts          # IPC 服务器 + 消息路由
│   │       ├── ipc.ts            # IPC 路径
│   │       ├── sessionRegistry.ts# 会话注册表
│   │       └── configManager.ts  # 配置持久化
│   └── gui/                # Tauri 桌面应用
│       ├── src-tauri/
│       │   └── src/main.rs       # Rust 后端 (Tauri commands + 系统托盘)
│       └── src/
│           ├── App.tsx           # React 前端组件
│           ├── styles.css        # 样式
│           └── main.tsx          # 入口
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── ARCHITECTURE.md
├── PRD.md
└── package.json
```

## 前置要求

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/) >= 10
- [Rust](https://www.rust-lang.org/tools/install) (构建 GUI 需要)

## 安装

```bash
pnpm install
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

## 使用方式

### 1. 启动会话

在终端中运行：

```bash
feishu run <command> [args...]
```

示例：

```bash
feishu run echo hello
feishu run claude --project my-project
```

CLI 会自动拉起 Daemon（如果未运行），通过 PTY 启动子进程并注册会话。

### 2. 管理 Daemon

```bash
feishu daemon start    # 手动启动
feishu daemon status   # 查看状态
feishu daemon stop     # 优雅关闭
```

### 3. GUI 操作

启动 GUI 后可在界面中：

- **会话页** — 查看活跃会话列表，为会话绑定/解绑双向机器人和推送机器人
- **机器人页** — 添加、编辑、删除双向机器人（App ID + Secret）和推送机器人（Webhook）
- **设置页** — 修改重连策略和推送参数，保存到配置文件

## 配置

配置文件位于 `~/.feishu-cli/config.json`，首次启动 Daemon 时自动创建：

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

## 数据文件

| 文件 | 用途 |
|------|------|
| `~/.feishu-cli/daemon.json` | Daemon 锁文件（PID + IPC 地址） |
| `~/.feishu-cli/config.json` | 机器人配置 + 应用设置 |

## IPC 协议

Daemon 使用 JSON-line 协议通信（每条消息一行 JSON + `\n`）。

**M1 消息**（已实现）：

| 消息类型 | 方向 | 说明 |
|----------|------|------|
| `register_session` | CLI → Daemon | 注册新会话 |
| `pty_output` | CLI → Daemon | PTY 输出转发 |
| `session_ended` | CLI → Daemon | 会话结束 |
| `status_request/response` | Any → Daemon | 查询状态 |
| `stop_request/response` | Any → Daemon | 停止 Daemon |

**M2 消息**（已实现）：

| 消息类型 | 方向 | 说明 |
|----------|------|------|
| `list_bots_request/response` | GUI → Daemon | 列出所有机器人 |
| `save_bot_request/response` | GUI → Daemon | 新增/编辑机器人（upsert） |
| `delete_bot_request/response` | GUI → Daemon | 删除机器人 |
| `bind_bot_request` / `bind_bot_response` | GUI → Daemon | 绑定机器人到会话 |
| `unbind_bot_request` / `bind_bot_response` | GUI → Daemon | 解绑机器人 |
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
- [ ] **M3** — 飞书双向对话与过程推送
- [ ] **M4** — 任务结束总结与稳定性优化

## 许可

MIT
