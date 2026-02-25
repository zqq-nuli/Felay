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

### 回复捕获路径

有三种模式捕获 AI CLI 的回复，优先级从高到低：

1. **API 代理模式**（`felay run --proxy claude` / `felay run --proxy codex`）：在 CLI 和上游 API 之间插入本地 HTTP 代理，透明转发流量并旁路解析 SSE 流。获取结构化 API 响应，质量最高。
2. **Hook 模式**：Codex 通过 `notify` 钩子（`scripts/felay-notify.js`）、Claude Code 通过 `Stop` 钩子（`scripts/felay-claude-notify.js`）直接将 AI 回复发送到 daemon。
3. **PTY 输出解析**：xterm-headless 渲染 + extractResponseText 从终端输出中提取回复。质量最低，仅作为兜底。

### API 代理模式

代理模式为 Claude Code 和 Codex 提供独立的实现，共用代理基础设施但 SSE 解析和拦截机制完全隔离。

#### Claude Code（`felay run --proxy claude`）

```
CLI (Node.js) ──fetch──► http://127.0.0.1:PORT ──转发──► https://api.anthropic.com
                              │ (tee: 旁路解析 SSE)
                              ▼
                      AnthropicAssembler → api_proxy_event → daemon → 飞书
```

**拦截机制**：Claude Code 是 Node.js 进程，通过 `NODE_OPTIONS=--require proxy-hook.cjs` 注入，monkey-patch `globalThis.fetch` 和 `http/https.request`，将发往上游的请求重定向到本地代理。

**上游解析**：依次检查 `ANTHROPIC_BASE_URL` 环境变量 → `~/.claude/settings.json` 中的 env 配置 → 默认 `https://api.anthropic.com`。

**SSE 解析**：`AnthropicAssembler` 处理 Anthropic Messages API 事件流（`message_start` → `content_block_delta` → `message_stop`）。

**过滤规则**（daemon 侧，`[claude]` 标签）：

| 条件 | 处理 |
|------|------|
| `model` 包含 `haiku` | 丢弃（Claude Code 内部辅助请求：预热、文件路径提取等） |
| 请求体含 `SUGGESTION MODE` | 丢弃（Claude Code 的输入建议功能，非真实回复） |
| 主模型 + `stop_reason=tool_use` | 仅推送机器人（格式化显示工具名 + 关键参数） |
| 主模型 + `stop_reason=end_turn` | 双向机器人（真实回复） + 推送机器人 |

#### Codex（`felay run --proxy codex`）

```
CLI (Rust 原生二进制) ──HTTP_PROXY──► http://127.0.0.1:PORT ──转发──► upstream
                                          │ (tee: 旁路解析 SSE)
                                          ▼
                                  ResponsesApiAssembler → api_proxy_event → daemon → 飞书
```

**拦截机制**：Codex CLI 是 Rust 编译的原生二进制（`codex.exe`），Node.js hook 无效。通过设置 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量拦截所有 HTTP 请求（Rust `reqwest` 库默认尊重这些变量）。

**上游解析**：读取 `~/.codex/config.toml` 中活跃 `model_provider` 的 `base_url`（如 `http://192.168.1.20:8081`），而非默认的 `https://api.openai.com`。

**SSE 解析**：`ResponsesApiAssembler` 处理 OpenAI Responses API 事件流（`response.created` → `response.output_text.delta` / `response.function_call_arguments.delta` → `response.completed`），与 Chat Completions API（`OpenAIAssembler`）完全不同。代理根据请求路径（`/responses`）自动选择 assembler。

**容错**：上游返回 `stream_read_error` 时，如果已有累积文本，仍然发送部分内容（而非丢弃）。

**过滤规则**（daemon 侧，`[codex]` 标签）：无特殊过滤。所有 `end_turn` 回复发送到双向+推送机器人，`tool_use` 仅发送到推送机器人。

#### 共用部分

- **`SseParser`**：通用 SSE 解析器，两者共用
- **`AssembledMessage`** 类型：统一的组装输出格式（`provider`/`model`/`stopReason`/`textContent`/`toolUseBlocks`）
- **消息路由**（daemon 侧）：`end_turn` → 双向+推送，`tool_use` → 仅推送。工具格式化提取 `command`/`file_path`/`pattern`/`query`/`workdir` 等字段，兼容两套工具体系。
- **Hook 与代理共存**：proxy 模式下，`codex_notify` / `claude_notify` hook 事件会被跳过（`skipping hook notify for proxy session`），避免重复发送。

### 飞书消息接收

daemon 支持三种飞书消息类型：

- **`text`**：纯文字消息，直接注入 PTY 输入
- **`image`**：纯图片消息，下载到 `~/.felay/images/<sessionId>/` 后通过 `feishu_input.images` 发送给 CLI
- **`post`**（富文本）：图片+文字组合消息，先下载图片发给 CLI，再发送文字。post 内容格式为 `{title, content: [[{tag, text/image_key}]]}` 或带 locale 包裹的 `{zh_cn: {title, content}}`

**要求**：飞书机器人需开通 `im:resource` 权限（开发者后台 → 权限管理）。

**清理**：session 结束时自动删除 `~/.felay/images/<sessionId>/` 目录；daemon 启动时清理残留的 `~/.felay/images/` 目录。

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
1. 构建：`pnpm run build`
2. 启动 daemon：`node packages/daemon/dist/index.js`（或 `pnpm dev:daemon`）
3. 运行 CLI：`felay run claude` / `felay run --proxy claude`（或其他 AI CLI）
4. 在飞书中发送文字消息验证双向通信
5. 在飞书中发送图片+文字组合消息（post 类型），验证图片和文字都被正确转发
6. 在飞书中发送纯图片 → 再发文字，验证图片被附加到 CLI 输入
7. **Claude 代理模式验证**：`felay run --proxy claude`
   - 确认 haiku 请求被跳过（日志 `[claude] skipping haiku request`）
   - 确认 suggestion 请求被跳过（日志 `[claude] skipping suggestion`）
   - 确认 tool_use 仅发送到推送机器人
   - 确认 end_turn 发送到双向机器人（干净的 AI 回复，无终端噪声）
8. **Codex 代理模式验证**：`felay run --proxy codex`
   - 确认代理读取了 `~/.codex/config.toml` 中的 `base_url`（日志 `resolved upstream from ~/.codex/config.toml`）
   - 确认 HTTP_PROXY 拦截生效（`proxy-debug.log` 中出现 `REQUEST: POST http://...`）
   - 确认 tool_use（如 `shell_command`）仅发送到推送机器人
   - 确认文本回复发送到双向机器人
   - 确认上游 `stream_read_error` 时部分文本仍被发送
9. 检查 daemon 控制台日志

### 调试重启流程

**重要**：每次修改 daemon 或 shared 代码后，必须重新构建并重启 daemon。Claude Code 在完成代码修改和 `pnpm run build` 后，应自动执行重启流程（杀旧进程 + 启动新进程），无需用户手动操作。

```bash
pnpm run build                                    # 重新编译
node -e "                                          # 杀掉旧 daemon
  const fs=require('fs'),path=require('path'),os=require('os');
  const lock=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.felay','daemon.json'),'utf8'));
  process.kill(lock.pid);
"
node packages/daemon/dist/index.js > daemon-log.txt 2>&1 &   # 后台启动新 daemon
```

CLI 侧需要退出旧的 `felay run claude` 并重新启动。
