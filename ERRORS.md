# Felay Common Errors

开发和运行中遇到的常见错误及解决方法。

---

## Daemon 相关

### EADDRINUSE: `\\.\pipe\felay`

**错误信息**：
```
Error: listen EADDRINUSE: address already in use \\.\pipe\felay
```

**原因**：上一次 daemon 进程没有正确退出，Named Pipe 仍被占用。

**解决方法**：
1. 读取 `~/.felay/daemon.json` 获取旧 daemon PID
2. 只 kill 该 PID：`taskkill /PID <pid> /F`（Windows）或 `kill <pid>`（Linux/macOS）
3. **禁止** `taskkill /IM node.exe /F` 或 `killall node` —— 会杀死 Claude Code 等其他 Node 进程
4. 如果 PID 已失效，删除锁文件后重试：`rm ~/.felay/daemon.json`

---

## Tauri Dev 相关

### `beforeDevCommand` 执行错误的脚本

**错误信息**：
```
@felay/cli@0.1.0 dev: `tsx src/index.ts`
Exit status 1 (cli 缺少参数退出)
```

**原因**：从项目根目录运行 `cargo tauri dev`，导致 `beforeDevCommand`（`pnpm dev`）解析到根 `package.json` 的 dev 脚本（同时启动 daemon + cli），而 cli 无参数立即退出。

**解决方法**：
- 使用 `pnpm run dev:gui` 从项目根目录启动（它会 `cd packages/gui/src-tauri && cargo tauri dev`）
- 这样 `pnpm dev` 会解析到 `packages/gui/package.json` 的 `"dev": "vite"`

**禁止**：
- 从项目根目录直接 `cargo tauri dev`
- 手动单独启动 Vite 再用 `--no-dev-server` 启动 Tauri

### Port 14200 already in use

**错误信息**：
```
Error: Port 14200 is already in use
```

**原因**：之前启动的 Vite 进程未正确关闭。

**解决方法**：
```bash
# 查找占用端口的进程
netstat -ano | grep 14200
# 只 kill 该进程
taskkill /PID <pid> /F
```

---

## 构建相关

### cargo 不在 PATH 中（bash 环境）

**错误信息**：
```
cargo: command not found
```

**原因**：Windows 上 bash（Git Bash / MSYS2）不自动继承 `~/.cargo/bin`。

**解决方法**：
```bash
export PATH="$PATH:/c/Users/<username>/.cargo/bin"
```

---

## Claude Code 集成相关

### Claude Code transcript 格式注意

Claude Code 的 transcript JSONL 文件格式与标准 ChatML 不同：
- **不是** `{ "role": "assistant", "content": "..." }`
- **而是** `{ "type": "assistant", "message": { "role": "assistant", "content": [{ "type": "text", "text": "..." }] }, ... }`

Hook 脚本必须用 `entry.type === "assistant"` + `entry.message.content` 来提取文本。

### 必须通过 `felay run claude` 启动

**现象**：配置了 hook 但飞书仍无回复。

**原因**：直接运行 `claude` 而非 `felay run claude`，daemon 中没有注册的 session，`claude_notify` 的 cwd 匹配不到任何 session。

**解决方法**：始终使用 `felay run claude` 启动，这样 CLI 会在 daemon 中注册 session 并自动绑定默认机器人。

### Hook 配置后需要重启 CLI

**现象**：通过 GUI 或 CLI 自动配置了 hook（Codex notify / Claude Stop hook），但飞书仍收到乱码/PTY 原始输出。

**原因**：AI CLI（Claude Code / Codex）在启动时读取配置文件，运行中不会重新加载。已在运行的会话不会感知到新的 hook 配置。

**解决方法**：退出当前 CLI 会话，重新启动（`felay run claude` / `felay run codex`）。新会话会自动使用已配置的 hook。

### PTY 输出包含终端渲染噪声

**现象**：发送到飞书的 Claude Code 回复包含 "Swooping... (thinking)"、状态栏、进度条等终端 UI 元素。

**原因**：当前使用 PTY 输出解析方式，无法完全过滤终端 TUI 渲染内容。

**解决方法**：改用 Claude Code 官方 Stop hook 机制，从 transcript 文件中获取干净的 assistant 消息（参见 TASKS.md）。

---

## ConPTY 兼容性相关

### `felay diagnose` 在 Windows 10 上挂起

**现象**：运行 `felay diagnose` 后无输出，进程卡死需要 Ctrl+C。

**原因**：`diagnose` 命令包含 PTY 自检（通过 node-pty 的 ConPTY 启动 `echo` 命令），Windows 10 22H2（build 19045）的 ConPTY 存在已知 Bug（node-pty #640、#471），导致 pty.spawn 后进程冻结。

**影响版本**：Windows 10（build < 22000）。Windows 11 不受影响。

**状态**：已知问题，待修复。计划在 diagnose 中检测 Win10 并跳过 PTY 自检，或改用 `child_process.spawn` 做自检。

**临时解决方法**：在 Win10 上不使用 `felay diagnose`，可通过 `felay --version` 验证安装是否正常。

### `felay run` TUI 冻结（Windows 10）

**现象**：`felay run codex` 或 `felay run claude` 启动后，TUI 不渲染，终端无输出。

**原因**：同上，ConPTY 在 Win10 上的 Bug。node-pty 1.1.0 已移除 winpty 后端，`useConpty: false` 不再有效。

**解决方法**：v0.1.26 起自动检测 Win10 并启用 Direct 模式（`child_process.spawn({ stdio: 'inherit' })`），绕过 ConPTY。也可手动指定 `felay run --direct codex`。
