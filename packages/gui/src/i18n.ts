import { createContext, useContext, useState, useCallback, ReactNode, createElement } from "react";

export type Locale = "zh" | "en";

const dict: Record<string, Record<Locale, string>> = {
  // AppShell sidebar
  "nav.title": { zh: "FELAY 代理", en: "FELAY PROXY" },
  "nav.sessions": { zh: "会话", en: "Sessions" },
  "nav.bots": { zh: "机器人", en: "Bots" },
  "nav.settings": { zh: "设置", en: "Settings" },

  // SessionsView
  "sessions.title": { zh: "活跃会话", en: "Active Sessions" },
  "sessions.subtitle": { zh: "管理本地 CLI 代理会话", en: "Manage your local CLI proxies." },
  "sessions.terminalOnly": { zh: "仅终端", en: "Terminal Only" },
  "sessions.terminalHint": { zh: "在终端中使用 'felay run <command>' 启动新会话", en: "Start a new session in your terminal using 'felay run <command>'" },
  "sessions.empty.title": { zh: "暂无活跃会话", en: "No Active Sessions" },
  "sessions.empty.desc": { zh: "在终端中运行 felay run claude 或 felay run codex 来启动一个代理会话。", en: "Run felay run claude or felay run codex in your terminal to start a proxy session." },
  "sessions.empty.cmd": { zh: "felay run claude", en: "felay run claude" },
  "sessions.status.proxy_on": { zh: "代理中", en: "Proxy On" },
  "sessions.status.listening": { zh: "监听中", en: "Listening" },
  "sessions.status.ended": { zh: "已结束", en: "Ended" },
  "sessions.bindings": { zh: "绑定", en: "Bindings" },
  "sessions.bindingsActive": { zh: "已绑定", en: "Bindings Active" },
  "sessions.bindBot": { zh: "绑定机器人", en: "Bind Bot" },
  "sessions.interactiveBot": { zh: "双向机器人", en: "Interactive Bot" },
  "sessions.pushBot": { zh: "推送机器人", en: "Push Bot" },
  "sessions.none": { zh: "-- 无 --", en: "-- None --" },

  // RobotsView
  "robots.title": { zh: "机器人", en: "Robots" },
  "robots.daemon.running": { zh: "运行中", en: "Running" },
  "robots.daemon.stopped": { zh: "已停止", en: "Stopped" },
  "robots.interactive": { zh: "双向机器人", en: "Interactive Bots" },
  "robots.push": { zh: "推送机器人（Webhook）", en: "Push Bots (Webhook)" },
  "robots.add": { zh: "添加", en: "Add" },
  "robots.edit": { zh: "编辑", en: "Edit" },
  "robots.delete": { zh: "删除", en: "Delete" },
  "robots.connected": { zh: "已连接", en: "Connected" },
  "robots.disconnected": { zh: "未连接", en: "Disconnected" },
  "robots.noInteractive": { zh: "暂无双向机器人。", en: "No interactive bots configured." },
  "robots.noPush": { zh: "暂无推送机器人。", en: "No push bots configured." },
  // Bot dialogs
  "robots.addInteractive": { zh: "添加双向机器人", en: "Add Interactive Bot" },
  "robots.editInteractive": { zh: "编辑双向机器人", en: "Edit Interactive Bot" },
  "robots.addPush": { zh: "添加推送机器人", en: "Add Push Bot" },
  "robots.editPush": { zh: "编辑推送机器人", en: "Edit Push Bot" },
  "robots.name": { zh: "名称", en: "Name" },
  "robots.appId": { zh: "App ID", en: "App ID" },
  "robots.appSecret": { zh: "App Secret", en: "App Secret" },
  "robots.encryptKey": { zh: "Encrypt Key（可选）", en: "Encrypt Key (Optional)" },
  "robots.webhook": { zh: "Webhook URL", en: "Webhook URL" },
  "robots.signatureSecret": { zh: "签名密钥（可选）", en: "Signature Secret (Optional)" },
  "robots.testConnection": { zh: "测试连接", en: "Test Connection" },
  "robots.testing": { zh: "测试中...", en: "Testing..." },
  "robots.connectionOk": { zh: "连接成功", en: "Connection Successful" },
  "robots.sendTest": { zh: "发送测试消息", en: "Send Test Message" },
  "robots.sending": { zh: "发送中...", en: "Sending..." },
  "robots.messageSent": { zh: "发送成功", en: "Message Sent" },
  "robots.cancel": { zh: "取消", en: "Cancel" },
  "robots.save": { zh: "保存", en: "Save" },
  "robots.saving": { zh: "保存中...", en: "Saving..." },
  // Delete dialog
  "robots.deleteTitle": { zh: "删除机器人", en: "Delete Bot" },
  "robots.deleteConfirm": { zh: "确定要删除", en: "Are you sure you want to delete" },
  "robots.deleteWarn": { zh: "此操作不可撤销。", en: "This action cannot be undone." },
  "robots.deleteBound": { zh: "该机器人当前绑定了 {count} 个活跃会话。删除后会自动解绑。", en: "This bot is currently bound to {count} active session(s). Deleting it will automatically unbind it from those sessions." },

  // SettingsView
  "settings.title": { zh: "设置", en: "Settings" },
  "settings.daemonStopped": { zh: "Daemon 未运行。配置更改将在 Daemon 启动后生效。", en: "Daemon is not running. Configuration changes will take effect after the daemon starts." },
  "settings.resilience": { zh: "连接韧性", en: "Connection Resilience" },
  "settings.maxRetries": { zh: "最大重试次数", en: "Max Retries" },
  "settings.initialInterval": { zh: "初始间隔（秒）", en: "Initial Interval (seconds)" },
  "settings.backoffMultiplier": { zh: "退避倍数", en: "Backoff Multiplier" },
  "settings.pushBehavior": { zh: "推送行为", en: "Push Behavior" },
  "settings.mergeWindow": { zh: "合并窗口（毫秒）", en: "Merge Window (ms)" },
  "settings.mergeHint": { zh: "发送推送消息前缓冲输出的时间。", en: "Time to buffer output before sending a single push message." },
  "settings.maxSize": { zh: "最大消息大小（字节）", en: "Max Message Size (bytes)" },
  "settings.winInput": { zh: "Windows 输入兼容", en: "Windows Input Compatibility" },
  "settings.winInputDesc": { zh: "由于 Windows ConPTY 已知 Bug，TUI 程序（如 Codex）多轮对话中可能丢失 Enter 键。此设置控制自动补发 Enter 次数。", en: "Due to known ConPTY bugs on Windows, TUI applications (like Codex) might miss the 'Enter' key in multi-turn conversations. This setting controls automatic Enter retries to mitigate the issue." },
  "settings.enterRetry": { zh: "Enter 补发次数", en: "Enter Retry Count" },
  "settings.enterInterval": { zh: "Enter 补发间隔（毫秒）", en: "Enter Retry Interval (ms)" },
  "settings.codex": { zh: "Codex 集成", en: "Codex Integration" },
  "settings.codexHook": { zh: "Codex Notify Hook", en: "Codex Notify Hook" },
  "settings.claude": { zh: "Claude Code 集成", en: "Claude Code Integration" },
  "settings.claudeHook": { zh: "Claude Stop Hook", en: "Claude Stop Hook" },
  "settings.checking": { zh: "检查中...", en: "Checking..." },
  "settings.configured": { zh: "已配置", en: "Configured" },
  "settings.notInstalled": { zh: "未安装", en: "Not Installed" },
  "settings.settingUp": { zh: "配置中...", en: "Setting Up..." },
  "settings.missing": { zh: "未配置", en: "Missing" },
  "settings.error": { zh: "错误", en: "Error" },
  "settings.autoConfig": { zh: "自动配置", en: "Auto Config" },
  "settings.retry": { zh: "重试", en: "Retry" },
  "settings.configFile": { zh: "配置文件", en: "Config File" },
  "settings.hookScript": { zh: "Hook 脚本", en: "Hook Script" },
  "settings.open": { zh: "打开", en: "Open" },
  "settings.restoreDefaults": { zh: "恢复默认", en: "Restore Defaults" },
  "settings.saveSettings": { zh: "保存设置", en: "Save Settings" },
  "settings.savedOk": { zh: "设置已保存", en: "Settings saved successfully" },
  "settings.saveFailed": { zh: "保存失败", en: "Save failed" },
  "settings.loading": { zh: "加载中...", en: "Loading settings..." },

  // Common
  "common.daemon": { zh: "Daemon", en: "Daemon" },
  "common.unknown": { zh: "未知", en: "Unknown" },
};

interface LocaleContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const LocaleContext = createContext<LocaleContextValue>(null!);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    return (localStorage.getItem("felay-locale") as Locale) || "zh";
  });

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    localStorage.setItem("felay-locale", l);
  }, []);

  const t = useCallback((key: string, params?: Record<string, string | number>) => {
    let text = dict[key]?.[locale] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, String(v));
      }
    }
    return text;
  }, [locale]);

  return createElement(LocaleContext.Provider, { value: { locale, setLocale, t } }, children);
}

export function useLocale() {
  return useContext(LocaleContext);
}
