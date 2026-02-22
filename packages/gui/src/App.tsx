import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";

type TabKey = "sessions" | "robots" | "settings";
type SessionStatus = "listening" | "proxy_on" | "ended";

interface SessionItem {
  session_id: string;
  cli: string;
  cwd: string;
  status: SessionStatus;
  started_at: string;
  interactive_bot_id?: string;
  interactive_bot_connected?: boolean;
  push_bot_id?: string;
  push_enabled?: boolean;
}

interface BotWarning {
  botId: string;
  message: string;
}

interface GuiStatus {
  running: boolean;
  daemon_pid: number | null;
  active_sessions: number;
  sessions: SessionItem[];
  warnings: BotWarning[];
}

interface InteractiveBot {
  id: string;
  name: string;
  appId: string;
  appSecret: string;
  encryptKey?: string;
}

interface PushBot {
  id: string;
  name: string;
  webhook: string;
  secret?: string;
}

interface BotsData {
  interactive: InteractiveBot[];
  push: PushBot[];
}

interface AppConfig {
  bots: { interactive: InteractiveBot[]; push: PushBot[] };
  reconnect: { maxRetries: number; initialInterval: number; backoffMultiplier: number };
  push: { mergeWindow: number; maxMessageBytes: number };
}

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: "sessions", label: "会话" },
  { key: "robots", label: "机器人" },
  { key: "settings", label: "设置" },
];

const emptyStatus: GuiStatus = {
  running: false,
  daemon_pid: null,
  active_sessions: 0,
  sessions: [],
  warnings: [],
};

const emptyBots: BotsData = { interactive: [], push: [] };

function generateId(): string {
  return crypto.randomUUID();
}

function maskSecret(s: string): string {
  if (s.length <= 6) return "***";
  return s.slice(0, 3) + "***" + s.slice(-3);
}

const statusColors: Record<SessionStatus, string> = {
  proxy_on: "#52c41a",
  listening: "#faad14",
  ended: "#999",
};

/* ══════════════════════════════════ App ══════════════════════════════════ */

export function App() {
  const [tab, setTab] = useState<TabKey>("sessions");
  const [status, setStatus] = useState<GuiStatus>(emptyStatus);
  const [selected, setSelected] = useState("");
  const [bots, setBots] = useState<BotsData>(emptyBots);

  const loadBots = useCallback(async () => {
    try {
      const data = await invoke<BotsData>("list_bots");
      setBots(data);
    } catch {
      setBots(emptyBots);
    }
  }, []);

  useEffect(() => {
    let disposed = false;

    const load = async () => {
      try {
        const next = await invoke<GuiStatus>("read_daemon_status");
        if (!disposed) setStatus(next);
      } catch {
        if (!disposed) setStatus(emptyStatus);
      }
    };

    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    loadBots();
  }, [loadBots]);

  useEffect(() => {
    if (!selected && status.sessions[0]) {
      setSelected(status.sessions[0].session_id);
      return;
    }
    if (selected && !status.sessions.some((item) => item.session_id === selected)) {
      setSelected(status.sessions[0]?.session_id ?? "");
    }
  }, [selected, status.sessions]);

  const selectedSession = useMemo(
    () => status.sessions.find((s) => s.session_id === selected),
    [selected, status.sessions]
  );

  const connectedBotIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of status.sessions) {
      if (s.interactive_bot_id && s.interactive_bot_connected) {
        ids.add(s.interactive_bot_id);
      }
    }
    return ids;
  }, [status.sessions]);

  const activeSessionCount = useMemo(
    () => status.sessions.filter((s) => s.status !== "ended").length,
    [status.sessions]
  );

  return (
    <div className="window">
      <header className="titlebar">
        <strong>Feishu CLI Proxy</strong>
      </header>
      <div className="body">
        <aside className="sidebar">
          {tabs.map((item) => (
            <button
              key={item.key}
              className={item.key === tab ? "tab active" : "tab"}
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </aside>
        <main className="panel">
          {tab === "sessions" ? (
            <SessionsView
              sessions={status.sessions}
              selected={selectedSession?.session_id}
              onSelect={setSelected}
              bots={bots}
            />
          ) : tab === "robots" ? (
            <RobotsView
              daemonRunning={status.running}
              bots={bots}
              onBotsChanged={loadBots}
              connectedBotIds={connectedBotIds}
              sessions={status.sessions}
            />
          ) : (
            <SettingsView daemonRunning={status.running} />
          )}
        </main>
      </div>
      {status.warnings.length > 0 && (
        <div className="warning-bar">
          {status.warnings.map((w) => (
            <span key={w.botId}>{w.message}</span>
          ))}
        </div>
      )}
      <footer className="statusbar">
        <span>
          Daemon: {status.running ? "运行中" : "未运行"}
          {status.daemon_pid ? ` (PID ${status.daemon_pid})` : ""}
        </span>
        <span>会话: {activeSessionCount} 活跃</span>
      </footer>
    </div>
  );
}

/* ══════════════════════════════ SessionsView ═════════════════════════════ */

function SessionsView({
  sessions,
  selected,
  onSelect,
  bots,
}: {
  sessions: SessionItem[];
  selected?: string;
  onSelect: (id: string) => void;
  bots: BotsData;
}) {
  const current = sessions.find((s) => s.session_id === selected);

  return (
    <div className="split">
      <section className="list">
        <h3>会话列表</h3>
        {sessions.length === 0 ? <p>暂无会话</p> : null}
        {sessions.map((item) => (
          <button
            key={item.session_id}
            className={item.session_id === selected ? "session active" : "session"}
            onClick={() => onSelect(item.session_id)}
          >
            <div>
              <span style={{ color: statusColors[item.status], marginRight: 4 }}>●</span>
              {item.session_id}
            </div>
            <small>
              {item.cli} / {item.status}
            </small>
          </button>
        ))}
      </section>
      <section className="detail">
        <h3>会话详情</h3>
        {current ? (
          <SessionDetail session={current} bots={bots} />
        ) : (
          <p>在终端执行 feishu run claude ... 启动会话</p>
        )}
      </section>
    </div>
  );
}

function SessionDetail({
  session,
  bots,
}: {
  session: SessionItem;
  bots: BotsData;
}) {
  const [interactiveBotId, setInteractiveBotId] = useState(session.interactive_bot_id ?? "");
  const [pushBotId, setPushBotId] = useState(session.push_bot_id ?? "");

  useEffect(() => {
    setInteractiveBotId(session.interactive_bot_id ?? "");
    setPushBotId(session.push_bot_id ?? "");
  }, [session.interactive_bot_id, session.push_bot_id]);

  const interactiveBotName = bots.interactive.find((b) => b.id === session.interactive_bot_id)?.name;
  const pushBotName = bots.push.find((b) => b.id === session.push_bot_id)?.name;

  const handleBindInteractive = async () => {
    if (!interactiveBotId) return;
    try {
      await invoke("bind_bot", {
        sessionId: session.session_id,
        botType: "interactive",
        botId: interactiveBotId,
      });
    } catch (e) {
      console.error("bind interactive failed:", e);
    }
  };

  const handleUnbindInteractive = async () => {
    try {
      await invoke("unbind_bot", { sessionId: session.session_id, botType: "interactive" });
    } catch (e) {
      console.error("unbind interactive failed:", e);
    }
  };

  const handleBindPush = async () => {
    if (!pushBotId) return;
    try {
      await invoke("bind_bot", {
        sessionId: session.session_id,
        botType: "push",
        botId: pushBotId,
      });
    } catch (e) {
      console.error("bind push failed:", e);
    }
  };

  const handleUnbindPush = async () => {
    try {
      await invoke("unbind_bot", { sessionId: session.session_id, botType: "push" });
    } catch (e) {
      console.error("unbind push failed:", e);
    }
  };

  return (
    <>
      <p>状态: {session.status}</p>
      <p>命令: {session.cli}</p>
      <p>目录: {session.cwd}</p>
      <p>启动: {session.started_at}</p>

      <div className="binding-section">
        <label>
          双向机器人: {interactiveBotName ?? "(未绑定)"}
          {session.interactive_bot_id && (
            <span style={{ marginLeft: 8, color: session.interactive_bot_connected ? "#52c41a" : "#faad14" }}>
              {session.interactive_bot_connected ? "[已连接]" : "[未连接]"}
            </span>
          )}
          <div className="binding-row">
            <select value={interactiveBotId} onChange={(e) => setInteractiveBotId(e.target.value)}>
              <option value="">-- 选择 --</option>
              {bots.interactive.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <button onClick={handleBindInteractive}>绑定</button>
            <button className="btn-danger-text" onClick={handleUnbindInteractive}>
              解绑
            </button>
          </div>
        </label>
      </div>

      <div className="binding-section">
        <label>
          推送机器人: {pushBotName ?? "(未绑定)"}
          {session.push_enabled ? " [已启用]" : ""}
          <div className="binding-row">
            <select value={pushBotId} onChange={(e) => setPushBotId(e.target.value)}>
              <option value="">-- 选择 --</option>
              {bots.push.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <button onClick={handleBindPush}>绑定</button>
            <button className="btn-danger-text" onClick={handleUnbindPush}>
              解绑
            </button>
          </div>
        </label>
      </div>
    </>
  );
}

/* ══════════════════════════════ RobotsView ═══════════════════════════════ */

type BotDialogMode =
  | { kind: "closed" }
  | { kind: "add-interactive" }
  | { kind: "edit-interactive"; bot: InteractiveBot }
  | { kind: "add-push" }
  | { kind: "edit-push"; bot: PushBot };

function RobotsView({
  daemonRunning,
  bots,
  onBotsChanged,
  connectedBotIds,
  sessions,
}: {
  daemonRunning: boolean;
  bots: BotsData;
  onBotsChanged: () => void;
  connectedBotIds: Set<string>;
  sessions: SessionItem[];
}) {
  const [dialog, setDialog] = useState<BotDialogMode>({ kind: "closed" });
  const [deleteConfirm, setDeleteConfirm] = useState<{
    botType: "interactive" | "push";
    botId: string;
    name: string;
  } | null>(null);

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    try {
      await invoke("delete_bot", { botType: deleteConfirm.botType, botId: deleteConfirm.botId });
      setDeleteConfirm(null);
      onBotsChanged();
    } catch (e) {
      console.error("delete bot failed:", e);
    }
  };

  const handleSaved = () => {
    setDialog({ kind: "closed" });
    onBotsChanged();
  };

  return (
    <div className="stack">
      <h3>机器人配置</h3>
      <p>Daemon 状态: {daemonRunning ? "运行中" : "未运行"}</p>

      <h4>双向机器人（交互）</h4>
      {bots.interactive.length === 0 ? (
        <p className="muted">暂无配置</p>
      ) : (
        bots.interactive.map((bot) => (
          <div className="bot-card" key={bot.id}>
            <div className="bot-card-info">
              <strong>{bot.name}</strong>
              <span className="muted">App ID: {maskSecret(bot.appId)}</span>
              <span style={{ color: connectedBotIds.has(bot.id) ? "#52c41a" : "#999", fontSize: 12 }}>
                {connectedBotIds.has(bot.id) ? "已连接" : "未连接"}
              </span>
            </div>
            <div className="bot-card-actions">
              <button onClick={() => setDialog({ kind: "edit-interactive", bot })}>编辑</button>
              <button
                className="btn-danger"
                onClick={() =>
                  setDeleteConfirm({ botType: "interactive", botId: bot.id, name: bot.name })
                }
              >
                删除
              </button>
            </div>
          </div>
        ))
      )}

      <h4>推送机器人（Webhook）</h4>
      {bots.push.length === 0 ? (
        <p className="muted">暂无配置</p>
      ) : (
        bots.push.map((bot) => (
          <div className="bot-card" key={bot.id}>
            <div className="bot-card-info">
              <strong>{bot.name}</strong>
              <span className="muted">Webhook: {maskSecret(bot.webhook)}</span>
            </div>
            <div className="bot-card-actions">
              <button onClick={() => setDialog({ kind: "edit-push", bot })}>编辑</button>
              <button
                className="btn-danger"
                onClick={() =>
                  setDeleteConfirm({ botType: "push", botId: bot.id, name: bot.name })
                }
              >
                删除
              </button>
            </div>
          </div>
        ))
      )}

      <div className="actions">
        <button onClick={() => setDialog({ kind: "add-interactive" })}>+ 添加双向机器人</button>
        <button onClick={() => setDialog({ kind: "add-push" })}>+ 添加推送机器人</button>
      </div>

      {/* Add/Edit dialogs */}
      {(dialog.kind === "add-interactive" || dialog.kind === "edit-interactive") && (
        <InteractiveBotDialog
          bot={dialog.kind === "edit-interactive" ? dialog.bot : undefined}
          onClose={() => setDialog({ kind: "closed" })}
          onSaved={handleSaved}
        />
      )}
      {(dialog.kind === "add-push" || dialog.kind === "edit-push") && (
        <PushBotDialog
          bot={dialog.kind === "edit-push" ? dialog.bot : undefined}
          onClose={() => setDialog({ kind: "closed" })}
          onSaved={handleSaved}
        />
      )}

      {/* Delete confirmation */}
      {deleteConfirm && (() => {
        const boundCount = sessions.filter(
          (s) =>
            s.status !== "ended" &&
            (deleteConfirm.botType === "interactive"
              ? s.interactive_bot_id === deleteConfirm.botId
              : s.push_bot_id === deleteConfirm.botId)
        ).length;
        return (
          <div className="overlay" onClick={() => setDeleteConfirm(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>确认删除</h3>
              <p>确定要删除机器人 &ldquo;{deleteConfirm.name}&rdquo; 吗？此操作不可撤销。</p>
              {boundCount > 0 && (
                <p className="msg-err">
                  该机器人当前绑定了 {boundCount} 个活跃会话，删除后这些会话的代理将自动断开。
                </p>
              )}
              <div className="actions">
                <button onClick={() => setDeleteConfirm(null)}>取消</button>
                <button className="btn-danger" onClick={handleDelete}>
                  删除
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* ── Interactive bot dialog ── */

function InteractiveBotDialog({
  bot,
  onClose,
  onSaved,
}: {
  bot?: InteractiveBot;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(bot?.name ?? "");
  const [appId, setAppId] = useState(bot?.appId ?? "");
  const [appSecret, setAppSecret] = useState(bot?.appSecret ?? "");
  const [encryptKey, setEncryptKey] = useState(bot?.encryptKey ?? "");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [showAppSecret, setShowAppSecret] = useState(false);
  const [showEncryptKey, setShowEncryptKey] = useState(false);

  const isEdit = !!bot;

  const handleSave = async () => {
    if (!name.trim() || !appId.trim() || !appSecret.trim()) return;
    setSaving(true);
    try {
      const config: InteractiveBot = {
        id: bot?.id ?? generateId(),
        name: name.trim(),
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        encryptKey: encryptKey.trim() || undefined,
      };
      await invoke("save_bot", { botType: "interactive", config });
      onSaved();
    } catch (e) {
      console.error("save interactive bot failed:", e);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!bot) return;
    setTesting(true);
    setTestResult("");
    try {
      const resp = await invoke<{ ok: boolean; error?: string }>("test_bot", {
        botType: "interactive",
        botId: bot.id,
      });
      setTestResult(resp.ok ? "连接成功" : `连接失败: ${resp.error ?? "unknown"}`);
    } catch (e) {
      setTestResult("测试失败: " + String(e));
    }
    setTesting(false);
  };

  const readonlyStyle = { opacity: 0.6, backgroundColor: "#f5f5f5" };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{isEdit ? "编辑双向机器人" : "添加双向机器人"}</h3>
        <label>
          名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="我的机器人"
            readOnly={isEdit}
            style={isEdit ? readonlyStyle : undefined}
          />
        </label>
        <label>
          App ID
          <input
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder="cli_xxx"
            readOnly={isEdit}
            style={isEdit ? readonlyStyle : undefined}
          />
        </label>
        <label>
          App Secret
          <div className="password-field">
            <input
              type={showAppSecret ? "text" : "password"}
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder="***"
            />
            <button
              type="button"
              className="toggle-visibility"
              onClick={() => setShowAppSecret(!showAppSecret)}
              tabIndex={-1}
            >
              {showAppSecret ? "\u{1F648}" : "\u{1F441}"}
            </button>
          </div>
        </label>
        <label>
          Encrypt Key（可选）
          <div className="password-field">
            <input
              type={showEncryptKey ? "text" : "password"}
              value={encryptKey}
              onChange={(e) => setEncryptKey(e.target.value)}
              placeholder="可选"
            />
            <button
              type="button"
              className="toggle-visibility"
              onClick={() => setShowEncryptKey(!showEncryptKey)}
              tabIndex={-1}
            >
              {showEncryptKey ? "\u{1F648}" : "\u{1F441}"}
            </button>
          </div>
        </label>
        {isEdit && (
          <>
            <button onClick={handleTest} disabled={testing} style={{ marginTop: 8 }}>
              {testing ? "测试中..." : "测试连接"}
            </button>
            {testResult && (
              <p className={testResult.startsWith("连接成功") ? "msg-ok" : "msg-err"}>
                {testResult}
              </p>
            )}
          </>
        )}
        <div className="actions">
          <button onClick={onClose}>取消</button>
          <button onClick={handleSave} disabled={saving}>
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Push bot dialog ── */

function PushBotDialog({
  bot,
  onClose,
  onSaved,
}: {
  bot?: PushBot;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(bot?.name ?? "");
  const [webhook, setWebhook] = useState(bot?.webhook ?? "");
  const [secret, setSecret] = useState(bot?.secret ?? "");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [showSecret, setShowSecret] = useState(false);

  const isEdit = !!bot;

  const handleSave = async () => {
    if (!name.trim() || !webhook.trim()) return;
    setSaving(true);
    try {
      const config: PushBot = {
        id: bot?.id ?? generateId(),
        name: name.trim(),
        webhook: webhook.trim(),
        secret: secret.trim() || undefined,
      };
      await invoke("save_bot", { botType: "push", config });
      onSaved();
    } catch (e) {
      console.error("save push bot failed:", e);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!bot) return;
    setTesting(true);
    setTestResult("");
    try {
      const resp = await invoke<{ ok: boolean; error?: string }>("test_bot", {
        botType: "push",
        botId: bot.id,
      });
      setTestResult(resp.ok ? "发送成功" : `发送失败: ${resp.error ?? "unknown"}`);
    } catch (e) {
      setTestResult("测试失败: " + String(e));
    }
    setTesting(false);
  };

  const readonlyStyle = { opacity: 0.6, backgroundColor: "#f5f5f5" };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{isEdit ? "编辑推送机器人" : "添加推送机器人"}</h3>
        <label>
          名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="推送机器人"
            readOnly={isEdit}
            style={isEdit ? readonlyStyle : undefined}
          />
        </label>
        <label>
          Webhook 地址
          <input
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
            placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
            readOnly={isEdit}
            style={isEdit ? readonlyStyle : undefined}
          />
        </label>
        <label>
          签名密钥（可选）
          <div className="password-field">
            <input
              type={showSecret ? "text" : "password"}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="可选"
            />
            <button
              type="button"
              className="toggle-visibility"
              onClick={() => setShowSecret(!showSecret)}
              tabIndex={-1}
            >
              {showSecret ? "\u{1F648}" : "\u{1F441}"}
            </button>
          </div>
        </label>
        {isEdit && (
          <>
            <button onClick={handleTest} disabled={testing} style={{ marginTop: 8 }}>
              {testing ? "发送中..." : "发送测试消息"}
            </button>
            {testResult && (
              <p className={testResult.startsWith("发送成功") ? "msg-ok" : "msg-err"}>
                {testResult}
              </p>
            )}
          </>
        )}
        <div className="actions">
          <button onClick={onClose}>取消</button>
          <button onClick={handleSave} disabled={saving}>
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════ SettingsView ═════════════════════════════ */

const defaultConfig: AppConfig = {
  bots: { interactive: [], push: [] },
  reconnect: { maxRetries: 3, initialInterval: 5, backoffMultiplier: 2 },
  push: { mergeWindow: 2000, maxMessageBytes: 30000 },
};

/** Clamp a numeric input value to a safe range, returning fallback on NaN. */
function clampNum(raw: string, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function SettingsView({ daemonRunning }: { daemonRunning: boolean }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const data = await invoke<AppConfig | null>("get_config");
        if (data) {
          setConfig(data);
        } else {
          setConfig(structuredClone(defaultConfig));
        }
      } catch {
        setConfig(structuredClone(defaultConfig));
      }
    };
    load();
  }, []);

  if (!config) return <p>加载中...</p>;

  const handleSave = async () => {
    setSaving(true);
    setMessage("");
    try {
      const resp = await invoke<{ ok: boolean; error?: string }>("save_config", { config });
      if (resp.ok) {
        setMessage("保存成功");
      } else {
        setMessage("保存失败: " + (resp.error ?? "unknown"));
      }
    } catch (e) {
      setMessage("保存失败: " + String(e));
    }
    setSaving(false);
  };

  const handleRestore = () => {
    setConfig({
      ...structuredClone(defaultConfig),
      bots: config.bots, // Keep bots when restoring defaults
    });
    setMessage("");
  };

  return (
    <div className="stack">
      <h3>设置</h3>
      {!daemonRunning && <p className="todo">Daemon 未运行，配置修改将在 Daemon 启动后生效</p>}

      <label>
        重试次数
        <input
          type="number"
          min={0}
          max={20}
          value={config.reconnect.maxRetries}
          onChange={(e) =>
            setConfig({
              ...config,
              reconnect: { ...config.reconnect, maxRetries: clampNum(e.target.value, 0, 20, 3) },
            })
          }
        />
      </label>
      <label>
        初始重试间隔(秒)
        <input
          type="number"
          min={1}
          max={300}
          value={config.reconnect.initialInterval}
          onChange={(e) =>
            setConfig({
              ...config,
              reconnect: { ...config.reconnect, initialInterval: clampNum(e.target.value, 1, 300, 5) },
            })
          }
        />
      </label>
      <label>
        退避倍数
        <input
          type="number"
          min={1}
          max={10}
          value={config.reconnect.backoffMultiplier}
          onChange={(e) =>
            setConfig({
              ...config,
              reconnect: { ...config.reconnect, backoffMultiplier: clampNum(e.target.value, 1, 10, 2) },
            })
          }
        />
      </label>
      <label>
        合并窗口(毫秒)
        <input
          type="number"
          min={500}
          max={60000}
          value={config.push.mergeWindow}
          onChange={(e) =>
            setConfig({
              ...config,
              push: { ...config.push, mergeWindow: clampNum(e.target.value, 500, 60000, 2000) },
            })
          }
        />
      </label>
      <label>
        单条消息上限(字节)
        <input
          type="number"
          min={1000}
          max={100000}
          value={config.push.maxMessageBytes}
          onChange={(e) =>
            setConfig({
              ...config,
              push: { ...config.push, maxMessageBytes: clampNum(e.target.value, 1000, 100000, 30000) },
            })
          }
        />
      </label>

      {message && (
        <p className={message.startsWith("保存成功") ? "msg-ok" : "msg-err"}>{message}</p>
      )}

      <div className="actions">
        <button onClick={handleRestore}>恢复默认</button>
        <button onClick={handleSave} disabled={saving}>
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}
