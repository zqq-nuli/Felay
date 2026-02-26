<div align="center">
  <img src="./packages/gui/src-tauri/icons/logo-%E9%80%8F%E6%98%8E.png" alt="Felay Logo" width="150"/>
  <h1>Felay</h1>
  <p><strong>Feishu (Lark) + Relay</strong></p>
  <p>将本地 AI CLI 桥接到飞书，实现双向对话和输出推送。</p>

  [English](./README_en.md) | 简体中文
</div>

---

<p align="center">
  <a href="#felay-是什么">简介</a> · <a href="#核心功能">功能</a> · <a href="#兼容性">兼容性</a> · <a href="#架构">架构</a> · <a href="#安装">安装</a> · <a href="#快速开始">快速开始</a> · <a href="#配置">配置</a> · <a href="#飞书机器人配置">飞书配置</a> · <a href="#为什么做-felay">初衷</a> · <a href="#许可协议">许可</a>
</p>

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

## 飞书机器人配置

Felay 使用两种机器人配合工作：

- **双向机器人** — 用于推送 AI 最终回复和接收你发送的消息，支持双向对话
- **推送机器人（Webhook）** — 用于推送全部消息，包括中间过程的流式输出

### 双向机器人

### 1. 创建应用

打开 [飞书开放平台](https://open.feishu.cn/app)，点击创建企业自建应用。

### 2. 添加机器人能力

进入应用详情 → **应用能力** → 添加 **机器人**。

### 3. 配置权限

进入 **权限管理**，搜索 `im:` 快速筛选，添加以下所有 IM 相关权限：

- 应用身份权限（`tenant_access_token`）
- 用户身份权限（`user_access_token`）

### 4. 发布应用

完成权限配置后，创建并发布第一个版本。

### 5. 绑定到 Felay

打开 Felay GUI 程序，绑定机器人（填入 App ID 和 App Secret），点击 **创建长连接**。

### 6. 配置事件回调

回到飞书开放平台，进入应用详情：

**事件回调** — 请求方式选择 **长连接**，保存后添加以下事件：
- `im.chat.access_event.bot_p2p_chat_entered_v1`（机器人进入单聊）
- `im.message.message_read_v1`（消息已读）
- `im.message.receive_v1`（接收消息）

**回调配置** — 请求方式选择 **长连接**，保存后添加以下回调：
- `card.action.trigger`（卡片交互）
- `url.preview.get`（链接预览）
- `profile.view.get`（个人信息查看）

### 7. 开始使用

配置完成后，在飞书中搜索你的机器人名称，发送消息即可开始对话。

### 推送机器人（Webhook）

推送机器人用于向群组推送全部消息，包括工具调用、中间流式输出等过程信息：

1. 在飞书中创建一个群聊
2. 群设置 → **机器人** → 添加 **自定义机器人**
3. 复制生成的 Webhook 地址
4. 在 Felay GUI 中填入该 Webhook 地址

## 为什么做 Felay？

以前被各种开发工具绑着，现在换成了 AI CLI，结果还是一样 — 对着黑漆漆的终端窗口坐一整天。

既然 AI 已经很强了，很多时候发完指令完全可以不用盯着。但你还是走不开，因为得看输出、得回它的提问。

我这两年身体不太好，老想着出去走走、体验一下生活，但总是因为各种开发任务被控制在电脑前。能不能远程控制电脑上的终端干活，这个想法在我脑子里已经很久了。后来体验了 OpenClaw，给我最惊喜的不是它本身的功能，而是它能接入飞书、Telegram 这些工具 — 终端里的事情，在手机上也能做。趁着过年终于下定决心开始写，就有了 Felay。最近 Anthropic 也发布了 Claude Remote，方向类似，但目前只能在自家 App 里用，且需要授权登录。

为什么不像社区里的 vibe-kanban 之类的项目那样，用流式 JSON 直接对接 API，做一个独立的界面？因为我对自己的电脑和代码有比较强的掌控欲，我想清楚地知道终端窗口里正在发生什么，而不是在一个相对黑盒的环境下做不确定的事情。Felay 的做法是保留完整的本地终端 — 你离开电脑前启动它，AI 继续跑，手机上能跟进；你回到电脑前，终端里的一切都还在，可以无缝接上刚才 CLI 做了什么。

## TODO

- [ ] **TODO 列表显示** — AI CLI 执行任务时会创建 TODO List，将其同步显示到飞书端，实时了解任务进度
- [ ] **交互式选项映射** — 将 CLI 的 TUI 交互（列表选择、确认提示）映射为飞书卡片组件（按钮、下拉菜单）
- [ ] **多级命令支持** — 支持 CLI 工具的级联菜单（如 `/model` → 模型选择），映射为飞书端的多级交互

## 已知问题

**Windows ConPTY Bug**：ConPTY 存在已知缺陷（[microsoft/terminal#19674](https://github.com/microsoft/terminal/issues/19674)），多轮对话中 Enter 键可能失效。Felay 通过自动补发机制缓解。macOS/Linux 不受影响。

## 许可协议

Custom Source-Available License — 仅限个人非商业使用。详见 [LICENSE](LICENSE)。
