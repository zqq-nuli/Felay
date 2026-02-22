# Felay Development Tasks

持久性开发任务追踪。每个任务标注状态：`[ ]` 待做 / `[x]` 已完成 / `[~]` 进行中

---

## Claude Code Hooks 集成

### 背景

当前 Claude Code 使用 PTY 输出解析（xterm-headless 渲染 + extractResponseText）来提取 AI 回复，结果包含大量终端渲染噪声（thinking 动画、状态栏、ANSI 转义序列等），质量很差。

Codex 已通过 `notify` 钩子（`felay-notify.js`）实现了干净的回复捕获，Claude Code 也应采用类似方案。

### Claude Code Hooks vs Codex Notify 对比

| 维度 | Codex `notify` | Claude Code `Stop` hook |
|------|---------------|------------------------|
| 触发时机 | `agent-turn-complete` 事件 | 每次 AI 回复结束 |
| 数据传递方式 | JSON 作为命令行参数（argv） | JSON 通过 **stdin** 传入 |
| 回复内容获取 | 直接在 JSON 中：`last-assistant-message` | **不在 stdin JSON 中**，需要读取 `transcript_path` 文件（JSONL 格式），解析最后一条 `assistant` 消息 |
| 配置位置 | `~/.codex/config.toml`：`notify = ["node", "script.js"]` | `~/.claude/settings.json`：`{ "hooks": { "Stop": [{ "command": "..." }] } }` |
| 配置格式 | TOML | JSON |
| 额外字段 | `cwd`, `turn-id`, `thread-id` | `session_id`, `transcript_path`, `cwd` |

### 实现任务

- [ ] 创建 `scripts/felay-claude-hook.js` — Claude Code Stop hook 脚本
  - 从 stdin 读取 JSON（含 `transcript_path`, `session_id`, `cwd`）
  - 读取 transcript 文件，解析 JSONL 提取最后一条 assistant 消息
  - 通过 IPC 发送到 daemon（复用 `codex_notify` 消息类型，或新建 `claude_notify`）
- [ ] 在 daemon 中添加 `claude_notify` 消息处理（或复用 codex_notify 逻辑）
- [ ] 在 shared 中定义 `ClaudeNotifyEvent` 类型（如果不复用 codex_notify）
- [ ] 自动配置 Claude Code hooks：
  - 检测 `~/.claude/settings.json` 是否存在
  - 检查 Stop hook 是否已配置
  - 自动写入 hook 配置
- [ ] CLI `felay run claude` 时自动检测并配置 hook（类似 `ensureCodexNotifyHook()`）
- [ ] GUI SettingsView 添加 Claude Code 集成状态展示
- [ ] 当 hook 配置成功后，跳过 PTY 输出的 extractResponseText 处理（避免重复发送）
- [ ] 将 `felay-claude-hook.js` 加入构建流程（`build-binaries.mjs` + `tauri.conf.json` resources）

---

## 其他待办

- [ ] 清理 PTY 输出解析路径（对于已配置 hook 的 CLI，禁用 xterm 渲染解析）
- [ ] 统一 Codex/Claude 的 hook 管理 UI（SettingsView 中合并为"AI CLI 集成"分区）
