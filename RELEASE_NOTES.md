## Felay v0.1.26-alpha

> 封闭内测版本，仅供内部测试使用。

### 主要变更

**Windows 10 兼容性修复（Direct 模式）**

Windows 10 22H2（build 19045）存在已知的 ConPTY Bug（node-pty #640、#471），导致 TUI 程序（如 Codex、Claude Code）通过 node-pty 启动后界面冻结或无法渲染。

本版本新增 **Direct 模式**：在 Windows 10 上自动跳过 node-pty，改用 `child_process.spawn({ stdio: 'inherit' })` 直接启动 CLI，TUI 在用户终端中原生渲染，彻底绕过 ConPTY 问题。

- **自动检测**：检测到 Windows 10（build < 22000）时自动启用 Direct 模式
- **手动覆盖**：`felay run --direct codex` 可在任意系统上强制使用 Direct 模式
- **代理模式兼容**：Direct 模式下 API 代理仍正常工作（输出通过代理捕获，不依赖 PTY）
- **限制**：Direct 模式下飞书消息无法注入到 CLI 输入（feishu_input 不可用），仅影响双向消息接收

**其他修复**

- 回退 v0.1.25 引入的 `useConptyDll: true` 配置（该配置在 Win10 上导致更严重的冻结）
- `felay diagnose` 诊断输出新增 `isWin10` 字段和 direct 模式状态
- 修复 `felay diagnose` PTY 自检在 Win10 上可能挂起的问题

### 系统要求

- Windows 10/11 x64
- Node.js 20+（仅开发环境）

### 安装

下载 `Felay_0.1.26_x64-setup.exe` 并运行。
