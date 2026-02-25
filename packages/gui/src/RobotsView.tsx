import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { Plus, Edit2, Trash2, Eye, EyeOff, Bot, Server, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { useLocale } from "./i18n";
import type { BotsData, InteractiveBot, PushBot, SessionItem } from "./types";

const springConfig = { type: "spring" as const, stiffness: 400, damping: 25 };

function generateId(): string {
  return crypto.randomUUID();
}

function maskSecret(s: string): string {
  if (s.length <= 6) return "***";
  return s.slice(0, 3) + "***" + s.slice(-3);
}

type BotDialogMode =
  | { kind: "closed" }
  | { kind: "add-interactive" }
  | { kind: "edit-interactive"; bot: InteractiveBot }
  | { kind: "add-push" }
  | { kind: "edit-push"; bot: PushBot };

export default function RobotsView({
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
  const { t } = useLocale();
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
    <div className="max-w-4xl mx-auto pb-10">
      <header className="flex justify-between items-end mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">{t("robots.title")}</h1>
          <div className="flex items-center gap-2 mt-2">
            <div className={`w-2 h-2 rounded-full shadow-sm ${daemonRunning ? 'bg-green-500 shadow-green-500/50' : 'bg-red-500 shadow-red-500/50'}`} />
            <p className="text-sm text-gray-500 font-medium">{t("common.daemon")}: {daemonRunning ? t("robots.daemon.running") : t("robots.daemon.stopped")}</p>
          </div>
        </div>
      </header>

      <section className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <Bot size={20} className="text-blue-500" /> {t("robots.interactive")}
          </h2>
          <motion.button
            whileTap={{ scale: 0.96 }}
            transition={springConfig}
            onClick={() => setDialog({ kind: "add-interactive" })}
            className="flex items-center gap-1 px-3 py-1.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-lg hover:bg-blue-500/20 transition-colors text-sm font-medium"
          >
            <Plus size={16} /> {t("robots.add")}
          </motion.button>
        </div>

        {bots.interactive.length === 0 ? (
          <EmptyState message={t("robots.noInteractive")} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {bots.interactive.map((bot) => (
              <BotCard
                key={bot.id}
                title={bot.name}
                subtitle={`App ID: ${maskSecret(bot.appId)}`}
                isConnected={connectedBotIds.has(bot.id)}
                icon={<Bot size={24} className="text-gray-700 dark:text-gray-300" />}
                onEdit={() => setDialog({ kind: "edit-interactive", bot })}
                onDelete={() => setDeleteConfirm({ botType: "interactive", botId: bot.id, name: bot.name })}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <Server size={20} className="text-purple-500" /> {t("robots.push")}
          </h2>
          <motion.button
            whileTap={{ scale: 0.96 }}
            transition={springConfig}
            onClick={() => setDialog({ kind: "add-push" })}
            className="flex items-center gap-1 px-3 py-1.5 bg-purple-500/10 text-purple-600 dark:text-purple-400 rounded-lg hover:bg-purple-500/20 transition-colors text-sm font-medium"
          >
            <Plus size={16} /> {t("robots.add")}
          </motion.button>
        </div>

        {bots.push.length === 0 ? (
          <EmptyState message={t("robots.noPush")} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {bots.push.map((bot) => (
              <BotCard
                key={bot.id}
                title={bot.name}
                subtitle={`Webhook: ${maskSecret(bot.webhook)}`}
                icon={<Server size={24} className="text-gray-700 dark:text-gray-300" />}
                onEdit={() => setDialog({ kind: "edit-push", bot })}
                onDelete={() => setDeleteConfirm({ botType: "push", botId: bot.id, name: bot.name })}
              />
            ))}
          </div>
        )}
      </section>

      <AnimatePresence>
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

        {deleteConfirm && (
          <DeleteConfirmDialog
            deleteConfirm={deleteConfirm}
            sessions={sessions}
            onClose={() => setDeleteConfirm(null)}
            onConfirm={handleDelete}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center p-8 text-center border border-dashed border-gray-300 dark:border-gray-700 rounded-2xl bg-gray-50/50 dark:bg-white/5">
      <p className="text-sm text-gray-500 dark:text-gray-400">{message}</p>
    </div>
  );
}

function BotCard({
  title,
  subtitle,
  isConnected,
  icon,
  onEdit,
  onDelete,
}: {
  title: string;
  subtitle: string;
  isConnected?: boolean;
  icon: React.ReactNode;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useLocale();

  return (
    <motion.div
      whileHover={{ scale: 1.02 }}
      transition={springConfig}
      className="group relative flex flex-col p-4 bg-white/50 dark:bg-[#1e1e1e]/50 backdrop-blur-md rounded-2xl border-[0.5px] border-black/5 dark:border-white/10 shadow-[0_4px_12px_-4px_rgba(0,0,0,0.05),inset_0_1px_0_0_rgba(255,255,255,0.4)] dark:shadow-[0_4px_12px_-4px_rgba(0,0,0,0.2),inset_0_1px_0_0_rgba(255,255,255,0.05)]"
    >
      <div className="flex justify-between items-start mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gray-100 dark:bg-white/5 rounded-lg border-[0.5px] border-black/5 dark:border-white/10 shadow-sm">
            {icon}
          </div>
          <div>
            <h3 className="text-sm font-semibold tracking-wide text-gray-900 dark:text-white truncate max-w-[150px]">
              {title}
            </h3>
            <p className="text-[11px] text-gray-500 truncate max-w-[150px]">{subtitle}</p>
          </div>
        </div>

        {isConnected !== undefined && (
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full border-[0.5px] shadow-sm ${
            isConnected
              ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
              : 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700'
          }`}>
            <div className={`w-2 h-2 rounded-full shadow-sm ${
              isConnected ? 'bg-green-500 shadow-green-500/50' : 'bg-gray-400 shadow-gray-400/50'
            }`} />
            <span className={`text-[10px] font-medium uppercase tracking-wider ${
              isConnected ? 'text-green-700 dark:text-green-400' : 'text-gray-600 dark:text-gray-400'
            }`}>
              {isConnected ? t("robots.connected") : t("robots.disconnected")}
            </span>
          </div>
        )}
      </div>

      <div className="mt-auto flex gap-2">
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={onEdit}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-white dark:bg-white/10 rounded-md border-[0.5px] border-black/10 dark:border-white/10 shadow-sm text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/20 transition-colors"
        >
          <Edit2 size={14} /> {t("robots.edit")}
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={onDelete}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 bg-red-50 dark:bg-red-500/10 rounded-md border-[0.5px] border-red-200 dark:border-red-500/20 shadow-sm text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/20 transition-colors"
        >
          <Trash2 size={14} /> {t("robots.delete")}
        </motion.button>
      </div>
    </motion.div>
  );
}

function ModalContainer({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={springConfig}
        className="relative w-full max-w-md bg-white/90 dark:bg-[#282828]/90 backdrop-blur-2xl rounded-2xl border-[0.5px] border-black/10 dark:border-white/10 shadow-2xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.4)] dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] p-6 overflow-hidden"
      >
        <div className="absolute inset-0 pointer-events-none opacity-[0.015] bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0IiBoZWlnaHQ9IjQiPjxyZWN0IHdpZHRoPSI0IiBoZWlnaHQ9IjQiIGZpbGw9IiNmZmYiIGZpbGwtb3BhY2l0eT0iMC4wMSIvPjxwYXRoIGQ9Ik0wIDBoNHY0SDBWMHptMSAxYTEgMSAwIDAgMCAwIDJoMmExIDEgMCAwIDAgMC0yaC0yeiIgZmlsbD0iIzAwMCIgZmlsbC1vcGFjaXR5PSIwLjA1Ii8+PC9zdmc+')] mix-blend-overlay" />
        {children}
      </motion.div>
    </div>
  );
}

function TextInput({ label, value, onChange, placeholder, readOnly, type = "text" }: any) {
  const [show, setShow] = useState(false);
  const isPassword = type === "password";

  return (
    <div className="flex flex-col gap-1.5 mb-4">
      <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">{label}</label>
      <div className="relative">
        <input
          type={isPassword && !show ? "password" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          readOnly={readOnly}
          className={`w-full bg-white dark:bg-black/20 border-[0.5px] border-black/10 dark:border-white/10 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.2)] rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-4 focus:ring-blue-500/20 transition-all ${
            readOnly ? 'opacity-60 bg-gray-50 dark:bg-white/5 cursor-not-allowed' : ''
          }`}
        />
        {isPassword && (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            onClick={() => setShow(!show)}
          >
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
      </div>
    </div>
  );
}

function InteractiveBotDialog({ bot, onClose, onSaved }: { bot?: InteractiveBot; onClose: () => void; onSaved: () => void }) {
  const { t } = useLocale();
  const [name, setName] = useState(bot?.name ?? "");
  const [appId, setAppId] = useState(bot?.appId ?? "");
  const [appSecret, setAppSecret] = useState(bot?.appSecret ?? "");
  const [encryptKey, setEncryptKey] = useState(bot?.encryptKey ?? "");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

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
    setTestResult(null);
    try {
      const resp = await invoke<{ ok: boolean; error?: string }>("test_bot", { botType: "interactive", botId: bot.id });
      setTestResult({ ok: resp.ok, msg: resp.ok ? t("robots.connectionOk") : `Failed: ${resp.error ?? t("common.unknown")}` });
    } catch (e) {
      setTestResult({ ok: false, msg: "Test Failed: " + String(e) });
    }
    setTesting(false);
  };

  return (
    <ModalContainer onClose={onClose}>
      <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6">{isEdit ? t("robots.editInteractive") : t("robots.addInteractive")}</h3>

      <TextInput label={t("robots.name")} value={name} onChange={setName} placeholder="My Bot" readOnly={isEdit} />
      <TextInput label={t("robots.appId")} value={appId} onChange={setAppId} placeholder="cli_xxx" readOnly={isEdit} />
      <TextInput label={t("robots.appSecret")} value={appSecret} onChange={setAppSecret} placeholder="***" type="password" />
      <TextInput label={t("robots.encryptKey")} value={encryptKey} onChange={setEncryptKey} placeholder="Optional" type="password" />

      {isEdit && (
        <div className="mb-4">
          <motion.button
            whileTap={{ scale: 0.96 }}
            onClick={handleTest}
            disabled={testing}
            className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-white/10 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/20 transition-colors disabled:opacity-50"
          >
            {testing ? t("robots.testing") : t("robots.testConnection")}
          </motion.button>
          {testResult && (
            <p className={`mt-2 text-xs font-medium flex items-center gap-1 ${testResult.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {testResult.msg}
            </p>
          )}
        </div>
      )}

      <div className="flex gap-3 mt-8">
        <motion.button whileTap={{ scale: 0.96 }} onClick={onClose} className="flex-1 py-2 rounded-xl text-sm font-medium bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/20 transition-colors">
          {t("robots.cancel")}
        </motion.button>
        <motion.button whileTap={{ scale: 0.96 }} onClick={handleSave} disabled={saving} className="flex-1 py-2 rounded-xl text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)] transition-colors disabled:opacity-50">
          {saving ? t("robots.saving") : t("robots.save")}
        </motion.button>
      </div>
    </ModalContainer>
  );
}

function PushBotDialog({ bot, onClose, onSaved }: { bot?: PushBot; onClose: () => void; onSaved: () => void }) {
  const { t } = useLocale();
  const [name, setName] = useState(bot?.name ?? "");
  const [webhook, setWebhook] = useState(bot?.webhook ?? "");
  const [secret, setSecret] = useState(bot?.secret ?? "");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

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
    setTestResult(null);
    try {
      const resp = await invoke<{ ok: boolean; error?: string }>("test_bot", { botType: "push", botId: bot.id });
      setTestResult({ ok: resp.ok, msg: resp.ok ? t("robots.messageSent") : `Failed: ${resp.error ?? t("common.unknown")}` });
    } catch (e) {
      setTestResult({ ok: false, msg: "Test Failed: " + String(e) });
    }
    setTesting(false);
  };

  return (
    <ModalContainer onClose={onClose}>
      <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-6">{isEdit ? t("robots.editPush") : t("robots.addPush")}</h3>

      <TextInput label={t("robots.name")} value={name} onChange={setName} placeholder="Push Bot" readOnly={isEdit} />
      <TextInput label={t("robots.webhook")} value={webhook} onChange={setWebhook} placeholder="https://open.feishu.cn/..." readOnly={isEdit} />
      <TextInput label={t("robots.signatureSecret")} value={secret} onChange={setSecret} placeholder="Optional" type="password" />

      {isEdit && (
        <div className="mb-4">
          <motion.button
            whileTap={{ scale: 0.96 }}
            onClick={handleTest}
            disabled={testing}
            className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-white/10 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/20 transition-colors disabled:opacity-50"
          >
            {testing ? t("robots.sending") : t("robots.sendTest")}
          </motion.button>
          {testResult && (
            <p className={`mt-2 text-xs font-medium flex items-center gap-1 ${testResult.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />} {testResult.msg}
            </p>
          )}
        </div>
      )}

      <div className="flex gap-3 mt-8">
        <motion.button whileTap={{ scale: 0.96 }} onClick={onClose} className="flex-1 py-2 rounded-xl text-sm font-medium bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/20 transition-colors">
          {t("robots.cancel")}
        </motion.button>
        <motion.button whileTap={{ scale: 0.96 }} onClick={handleSave} disabled={saving} className="flex-1 py-2 rounded-xl text-sm font-medium bg-purple-500 text-white hover:bg-purple-600 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)] transition-colors disabled:opacity-50">
          {saving ? t("robots.saving") : t("robots.save")}
        </motion.button>
      </div>
    </ModalContainer>
  );
}

function DeleteConfirmDialog({
  deleteConfirm,
  sessions,
  onClose,
  onConfirm
}: {
  deleteConfirm: { botType: "interactive" | "push"; botId: string; name: string };
  sessions: SessionItem[];
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useLocale();
  const boundCount = sessions.filter(
    (s) => s.status !== "ended" && (deleteConfirm.botType === "interactive" ? s.interactive_bot_id === deleteConfirm.botId : s.push_bot_id === deleteConfirm.botId)
  ).length;

  return (
    <ModalContainer onClose={onClose}>
      <div className="flex flex-col items-center text-center">
        <div className="w-12 h-12 bg-red-100 dark:bg-red-500/20 rounded-full flex items-center justify-center mb-4">
          <AlertCircle size={24} className="text-red-600 dark:text-red-400" />
        </div>
        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">{t("robots.deleteTitle")}</h3>
        <p className="text-sm text-gray-600 dark:text-gray-300 mb-6">
          {t("robots.deleteConfirm")} <span className="font-semibold text-gray-900 dark:text-white">"{deleteConfirm.name}"</span>? {t("robots.deleteWarn")}
        </p>

        {boundCount > 0 && (
          <div className="bg-red-50 dark:bg-red-500/10 border-[0.5px] border-red-200 dark:border-red-500/20 rounded-lg p-3 mb-6">
            <p className="text-xs font-medium text-red-600 dark:text-red-400">
              {t("robots.deleteBound", { count: boundCount })}
            </p>
          </div>
        )}

        <div className="flex gap-3 w-full">
          <motion.button whileTap={{ scale: 0.96 }} onClick={onClose} className="flex-1 py-2 rounded-xl text-sm font-medium bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/20 transition-colors">
            {t("robots.cancel")}
          </motion.button>
          <motion.button whileTap={{ scale: 0.96 }} onClick={onConfirm} className="flex-1 py-2 rounded-xl text-sm font-medium bg-red-500 text-white hover:bg-red-600 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)] transition-colors">
            {t("robots.delete")}
          </motion.button>
        </div>
      </div>
    </ModalContainer>
  );
}
