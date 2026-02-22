# Felay Project Context

## Project Overview

Felay (Feishu + Relay) 是飞书 CLI 代理工具，通过本地 Daemon 进程将 AI CLI（Codex/Gemini CLI/Claude Code）桥接到飞书，实现双向对话和输出推送。

## Architecture

```
GUI (Tauri/React) ──┐
                    ├── Named Pipe / Unix Socket ── Daemon (Node.js) ── Named Pipe ── CLI (node-pty) ── AI CLI
Feishu API ─────────┘
```

所有进程间通信使用 JSON-line 协议（每条消息一行 JSON + `\n`），传输层为 Named Pipe (Windows) 或 Unix Socket (macOS/Linux)。

## Monorepo Structure

| Package | Path | Role |
|---------|------|------|
| `@felay/shared` | `packages/shared/` | 共享 TypeScript 类型和 IPC 消息定义 |
| `@felay/daemon` | `packages/daemon/` | 后台常驻进程，管理飞书连接和消息路由 |
| `@felay/cli` | `packages/cli/` | CLI 入口，PTY 包装器 |
| `@felay/gui` | `packages/gui/` | Tauri 桌面应用（Rust + React） |

## Build & Dev Commands

```bash
pnpm install              # 安装依赖
pnpm run build            # 编译所有包（shared → daemon → cli）
pnpm run dev              # 开发模式（daemon + cli 并行）
pnpm run dev:gui          # GUI 开发模式（先构建 shared，再启动 Tauri）
pnpm run build:gui        # 构建 NSIS 安装程序
pnpm run setup            # 安装 + 编译 + 全局注册 felay 命令
```

**构建顺序很重要**：shared 必须先构建，因为 daemon 和 cli 依赖其编译输出。

## Key Development Patterns

### IPC Message 定义（shared/src/index.ts）

使用 discriminated union 模式，每个消息有 `type` 字面量字段：

```typescript
export interface SomeRequest {
  type: "some_request";
  payload: { ... };
}
export interface SomeResponse {
  type: "some_response";
  payload: { ok: boolean; error?: string };
}
```

新增消息时需要：
1. 在 shared 中定义 Request/Response 接口
2. 添加到 `DaemonMessage` / `DaemonReply` union 类型
3. 在 daemon 的 index.ts 中添加 Zod schema + handler
4. 如果 GUI 需要调用，在 Tauri main.rs 中添加 command

### Zod 验证（daemon/src/index.ts）

每个 IPC 消息有对应的 Zod schema，在 `handleMessage()` 中逐个 `safeParse`：

```typescript
const mySchema = z.object({
  type: z.literal("my_request"),
  payload: z.object({ ... }),
});

// In handleMessage():
const result = mySchema.safeParse(parsed);
if (result.success) {
  // handle typed data
}
```

### Tauri 命令（gui/src-tauri/src/main.rs）

Rust 侧通过 Named Pipe/Unix Socket 连接 daemon，发送 JSON-line 请求：

```rust
#[tauri::command]
fn my_command() -> Value {
  let ipc_path = get_ipc_path()?;
  let req = r#"{"type":"my_request"}"#;
  ipc_request(&ipc_path, req)
}
```

前端调用：`invoke<ReturnType>("my_command")`

### 飞书消息发送

- **IM API**（双向机器人）：`msg_type: "post"`，使用 `markdownToPost()` 转换
- **Webhook**（推送机器人）：`msg_type: "post"`，使用 `markdownToPostBasic()` 转换（仅 text/a 标签）
- **卡片消息**：`msg_type: "interactive"`，用于会话结束通知等结构化消息

### Codex 专用回复路径

Codex 通过 `notify` 钩子（`scripts/felay-notify.js`）直接将 AI 回复发送到 daemon，无需 PTY 输出解析。其他 CLI 使用 xterm-headless 渲染 + extractResponseText 从 PTY 输出中提取回复。

## Known Issues & Workarounds

### Windows ConPTY Enter 键 Bug

**问题**：Windows ConPTY 存在已知 Bug（microsoft/terminal#19674），TUI 程序多轮对话中 `\r` 可能不被翻译为 Enter 键事件。

**当前方案**：逐字符模拟输入（绕过 PasteBurst 检测）+ 可配置的 Enter 补发机制。参数在 `AppConfig.input` 中配置：
- `enterRetryCount`：补发次数（默认 2）
- `enterRetryInterval`：补发间隔 ms（默认 500）

**仅影响 Windows**，macOS/Linux 不受影响。

### Tauri Dev 启动方式

**正确的开发启动流程**：
1. 先启动 daemon：`node packages/daemon/dist/index.js` 或 `pnpm run dev:daemon`
2. 再启动 GUI：`pnpm run dev:gui`（会自动启动 Vite + Tauri 窗口）
3. CLI 按需启动：`felay run claude` / `felay run codex` 等

**禁止**从项目根目录直接 `cargo tauri dev`（详见 ERRORS.md）。

### Daemon Pipe EADDRINUSE

旧 daemon 未退出时新 daemon 启动报 `EADDRINUSE`。通过 `~/.felay/daemon.json` 中的 PID 定向 kill，**禁止 `killall node`**（详见 ERRORS.md）。

### Lark SDK appType 类型缺失

`@larksuiteoapi/node-sdk` 的 WSClient 构造函数类型声明缺少 `appType` 字段，但运行时存在。使用 `@ts-expect-error` 注释绕过（feishuManager.ts）。

## Configuration

- **配置文件**：`~/.felay/config.json`（密钥 AES-256-GCM 加密存储）
- **锁文件**：`~/.felay/daemon.json`（daemon PID + IPC 地址）
- **主密钥**：`~/.felay/.master-key`

## Testing

无自动化测试。手动测试流程：
1. 启动 daemon：`node packages/daemon/dist/index.js`（或 `pnpm dev:daemon`）
2. 运行 CLI：`felay run codex`（或其他 AI CLI）
3. 在飞书中发送消息验证双向通信
4. 检查 daemon 控制台日志
