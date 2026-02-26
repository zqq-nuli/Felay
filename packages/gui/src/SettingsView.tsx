import React, { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { Settings, Wifi, Network, Keyboard, Send, TerminalSquare, AlertCircle, CheckCircle2, RotateCcw, Save, FolderOpen, PackageOpen, Download, FileArchive, ExternalLink } from "lucide-react";
import { useLocale } from "./i18n";
import type { AppConfig } from "./types";

const springConfig = { type: "spring" as const, stiffness: 400, damping: 25 };

/** Compare semver tags: returns true if `a` > `b` (strips leading 'v' and trailing '-beta' etc.) */
function version_gt(a: string, b: string): boolean {
  const parse = (s: string) => s.replace(/^v/, "").split("-")[0].split(".").map(Number);
  const va = parse(a), vb = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((va[i] ?? 0) > (vb[i] ?? 0)) return true;
    if ((va[i] ?? 0) < (vb[i] ?? 0)) return false;
  }
  return false;
}

const defaultConfig: AppConfig = {
  bots: { interactive: [], push: [] },
  reconnect: { maxRetries: 3, initialInterval: 5, backoffMultiplier: 2 },
  push: { mergeWindow: 2000, maxMessageBytes: 30000 },
  input: { enterRetryCount: 2, enterRetryInterval: 500 },
};

function clampNum(raw: string, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export default function SettingsView({ daemonRunning }: { daemonRunning: boolean }) {
  const { t } = useLocale();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const [codexStatus, setCodexStatus] = useState<"loading" | "configured" | "missing" | "not_installed" | "setting_up" | "error">("loading");
  const [codexError, setCodexError] = useState("");
  const [codexScriptPath, setCodexScriptPath] = useState("");
  const [codexConfigPath, setCodexConfigPath] = useState("");

  const [claudeStatus, setClaudeStatus] = useState<"loading" | "configured" | "missing" | "not_installed" | "setting_up" | "error">("loading");
  const [claudeError, setClaudeError] = useState("");
  const [claudeScriptPath, setClaudeScriptPath] = useState("");
  const [claudeConfigPath, setClaudeConfigPath] = useState("");

  // Update check state (with ETag caching)
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "up_to_date" | "has_update" | "error">("idle");
  const [updateInfo, setUpdateInfo] = useState<{ currentVersion: string; latestVersion: string; releaseUrl: string; releaseNotes: string } | null>(null);
  const [updateError, setUpdateError] = useState("");
  const [appVersion] = useState(() => __APP_VERSION__);
  const [cachedEtag, setCachedEtag] = useState("");

  // Log export state
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<{ text: string; ok: boolean } | null>(null);

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

    // Restore cached update check result from localStorage
    try {
      const raw = localStorage.getItem("felay-update-cache");
      if (raw) {
        const cached = JSON.parse(raw) as { etag: string; hasUpdate: boolean; latestVersion: string; releaseUrl: string; releaseNotes: string };
        setCachedEtag(cached.etag);
        setUpdateInfo({ currentVersion: appVersion, latestVersion: cached.latestVersion, releaseUrl: cached.releaseUrl, releaseNotes: cached.releaseNotes });
        setUpdateStatus(cached.hasUpdate ? "has_update" : "up_to_date");
      }
    } catch { /* ignore corrupt cache */ }
  }, []);

  const checkCodexStatus = useCallback(async () => {
    if (!daemonRunning) {
      setCodexStatus("loading");
      return;
    }
    try {
      const result = await invoke<{ codexInstalled: boolean; notifyConfigured: boolean; currentNotify?: string; felayScriptPath: string; configFilePath: string } | null>("check_codex_config");
      if (!result) { setCodexStatus("loading"); return; }
      setCodexScriptPath(result.felayScriptPath);
      setCodexConfigPath(result.configFilePath);
      if (!result.codexInstalled) {
        setCodexStatus("not_installed");
      } else {
        setCodexStatus(result.notifyConfigured ? "configured" : "missing");
      }
    } catch {
      setCodexStatus("loading");
    }
  }, [daemonRunning]);

  const checkClaudeStatus = useCallback(async () => {
    if (!daemonRunning) {
      setClaudeStatus("loading");
      return;
    }
    try {
      const result = await invoke<{ claudeInstalled: boolean; hookConfigured: boolean; currentHookCommand?: string; felayScriptPath: string; configFilePath: string } | null>("check_claude_config");
      if (!result) { setClaudeStatus("loading"); return; }
      setClaudeScriptPath(result.felayScriptPath);
      setClaudeConfigPath(result.configFilePath);
      if (!result.claudeInstalled) {
        setClaudeStatus("not_installed");
      } else {
        setClaudeStatus(result.hookConfigured ? "configured" : "missing");
      }
    } catch {
      setClaudeStatus("loading");
    }
  }, [daemonRunning]);

  useEffect(() => {
    checkCodexStatus();
    checkClaudeStatus();
  }, [checkCodexStatus, checkClaudeStatus]);

  const handleCheckUpdate = async () => {
    setUpdateStatus("checking");
    setUpdateError("");
    try {
      const result = await invoke<{
        not_modified: boolean; etag: string;
        has_update: boolean; current_version: string;
        latest_version: string; release_url: string; release_notes: string;
      }>("check_update", { cachedEtag: cachedEtag || null });

      if (result.not_modified) {
        // 304 — cached data is still valid, just refresh status
        if (updateInfo) {
          setUpdateStatus(updateInfo.latestVersion ? (
            version_gt(updateInfo.latestVersion, appVersion) ? "has_update" : "up_to_date"
          ) : "up_to_date");
        } else {
          setUpdateStatus("up_to_date");
        }
        return;
      }

      // 200 — new data, update cache
      setCachedEtag(result.etag);
      const info = { currentVersion: result.current_version, latestVersion: result.latest_version, releaseUrl: result.release_url, releaseNotes: result.release_notes };
      setUpdateInfo(info);
      setUpdateStatus(result.has_update ? "has_update" : "up_to_date");

      // Persist to localStorage for next session
      localStorage.setItem("felay-update-cache", JSON.stringify({
        etag: result.etag,
        hasUpdate: result.has_update,
        latestVersion: result.latest_version,
        releaseUrl: result.release_url,
        releaseNotes: result.release_notes,
      }));
    } catch (e) {
      setUpdateError(String(e));
      setUpdateStatus("error");
    }
  };

  const handleExportLogs = async () => {
    setExporting(true);
    setExportMessage(null);
    try {
      const savedPath = await invoke<string>("collect_logs");
      setExportMessage({ text: `${t("settings.exportDone")} ${savedPath}`, ok: true });
      setTimeout(() => setExportMessage(null), 5000);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("cancelled") || msg.includes("User cancelled")) {
        setExportMessage({ text: t("settings.exportCancelled"), ok: true });
        setTimeout(() => setExportMessage(null), 3000);
      } else {
        setExportMessage({ text: `${t("settings.exportFailed")}: ${msg}`, ok: false });
        setTimeout(() => setExportMessage(null), 8000);
      }
    }
    setExporting(false);
  };

  const handleOpenUrl = async (url: string) => {
    try { await invoke("open_url", { url }); } catch { /* ignore */ }
  };

  if (!config) return <div className="flex justify-center py-20"><p className="text-gray-500">{t("settings.loading")}</p></div>;

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const resp = await invoke<{ ok: boolean; error?: string }>("save_config", { config });
      if (resp.ok) {
        setMessage({ text: t("settings.savedOk"), ok: true });
        setTimeout(() => setMessage(null), 3000);
      } else {
        setMessage({ text: t("settings.saveFailed") + ": " + (resp.error ?? t("common.unknown")), ok: false });
      }
    } catch (e) {
      setMessage({ text: t("settings.saveFailed") + ": " + String(e), ok: false });
    }
    setSaving(false);
  };

  const handleRestore = () => {
    setConfig({
      ...structuredClone(defaultConfig),
      bots: config.bots,
    });
    setMessage(null);
  };

  return (
    <div className="max-w-4xl mx-auto pb-24">
      <header className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">{t("settings.title")}</h1>
        {!daemonRunning && (
          <div className="mt-4 flex items-center gap-2 px-3 py-2 bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-200 rounded-lg border-[0.5px] border-yellow-200 dark:border-yellow-800 text-sm">
            <AlertCircle size={16} />
            <p>{t("settings.daemonStopped")}</p>
          </div>
        )}
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Network & Reconnect Section */}
        <SettingsCard title={t("settings.resilience")} icon={<Network className="text-blue-500" />}>
          <NumberInput
            label={t("settings.maxRetries")}
            value={config.reconnect.maxRetries}
            min={0} max={20}
            onChange={(val) => setConfig({ ...config, reconnect: { ...config.reconnect, maxRetries: val } })}
          />
          <NumberInput
            label={t("settings.initialInterval")}
            value={config.reconnect.initialInterval}
            min={1} max={300}
            onChange={(val) => setConfig({ ...config, reconnect: { ...config.reconnect, initialInterval: val } })}
          />
          <NumberInput
            label={t("settings.backoffMultiplier")}
            value={config.reconnect.backoffMultiplier}
            min={1} max={10}
            onChange={(val) => setConfig({ ...config, reconnect: { ...config.reconnect, backoffMultiplier: val } })}
          />
        </SettingsCard>

        {/* Push Configuration Section */}
        <SettingsCard title={t("settings.pushBehavior")} icon={<Send className="text-purple-500" />}>
          <NumberInput
            label={t("settings.mergeWindow")}
            value={config.push.mergeWindow}
            min={500} max={60000}
            onChange={(val) => setConfig({ ...config, push: { ...config.push, mergeWindow: val } })}
            hint={t("settings.mergeHint")}
          />
          <NumberInput
            label={t("settings.maxSize")}
            value={config.push.maxMessageBytes}
            min={1000} max={100000}
            onChange={(val) => setConfig({ ...config, push: { ...config.push, maxMessageBytes: val } })}
          />
        </SettingsCard>

        {/* Windows ConPTY Workaround */}
        {navigator.platform?.startsWith("Win") && (
          <SettingsCard title={t("settings.winInput")} icon={<Keyboard className="text-orange-500" />} className="md:col-span-2">
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 bg-gray-50 dark:bg-white/5 p-3 rounded-lg border-[0.5px] border-black/5 dark:border-white/10">
              {t("settings.winInputDesc")}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <NumberInput
                label={t("settings.enterRetry")}
                value={config.input?.enterRetryCount ?? 2}
                min={0} max={10}
                onChange={(val) => setConfig({ ...config, input: { enterRetryCount: val, enterRetryInterval: config.input?.enterRetryInterval ?? 500 } })}
              />
              <NumberInput
                label={t("settings.enterInterval")}
                value={config.input?.enterRetryInterval ?? 500}
                min={100} max={5000}
                onChange={(val) => setConfig({ ...config, input: { enterRetryCount: config.input?.enterRetryCount ?? 2, enterRetryInterval: val } })}
              />
            </div>
          </SettingsCard>
        )}
      </div>

      <div className="space-y-6">
        {/* Codex Integration */}
        <SettingsCard title={t("settings.codex")} icon={<TerminalSquare className="text-emerald-500" />} className="flex flex-col gap-4">
          <IntegrationStatus
            name={t("settings.codexHook")}
            status={codexStatus}
            onSetup={async () => {
              setCodexStatus("setting_up");
              try {
                const result = await invoke<{ ok: boolean; error?: string }>("setup_codex_config");
                if (result.ok) { setCodexStatus("configured"); }
                else { setCodexError(result.error ?? "Unknown Error"); setCodexStatus("error"); }
              } catch (e) {
                setCodexError(String(e)); setCodexStatus("error");
              }
            }}
            onRetry={checkCodexStatus}
            errorMsg={codexError}
            configPath={codexConfigPath || "~/.codex/config.toml"}
            scriptPath={codexScriptPath}
            onOpenConfig={async () => {
              try {
                const result = await invoke<{ ok: boolean; error?: string }>("open_codex_config_file");
                if (!result.ok) { setCodexError(result.error ?? "Failed to open"); setCodexStatus("error"); }
              } catch (e) { setCodexError(String(e)); setCodexStatus("error"); }
            }}
            manualCode={`notify = ["node", "${codexScriptPath}"]`}
            manualHint="Add before all [section]s in the config file:"
          />
        </SettingsCard>

        {/* Claude Code Integration */}
        <SettingsCard title={t("settings.claude")} icon={<TerminalSquare className="text-orange-600" />} className="flex flex-col gap-4">
          <IntegrationStatus
            name={t("settings.claudeHook")}
            status={claudeStatus}
            onSetup={async () => {
              setClaudeStatus("setting_up");
              try {
                const result = await invoke<{ ok: boolean; error?: string }>("setup_claude_config");
                if (result.ok) { setClaudeStatus("configured"); }
                else { setClaudeError(result.error ?? "Unknown Error"); setClaudeStatus("error"); }
              } catch (e) {
                setClaudeError(String(e)); setClaudeStatus("error");
              }
            }}
            onRetry={checkClaudeStatus}
            errorMsg={claudeError}
            configPath={claudeConfigPath || "~/.claude/settings.json"}
            scriptPath={claudeScriptPath}
            onOpenConfig={async () => {
              try {
                const result = await invoke<{ ok: boolean; error?: string }>("open_claude_config_file");
                if (!result.ok) { setClaudeError(result.error ?? "Failed to open"); setClaudeStatus("error"); }
              } catch (e) { setClaudeError(String(e)); setClaudeStatus("error"); }
            }}
            manualCode={`"hooks": { "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node ${claudeScriptPath}" }] }] }`}
            manualHint="Add hooks configuration in settings.json:"
          />
        </SettingsCard>
        {/* About & Updates */}
        <SettingsCard title={t("settings.about")} icon={<PackageOpen className="text-indigo-500" />} className="flex flex-col gap-4">
          {/* Version info */}
          <div className="flex flex-col gap-3 p-3 bg-gray-50 dark:bg-white/5 rounded-xl border-[0.5px] border-black/5 dark:border-white/10">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{t("settings.currentVersion")}</span>
              <span className="text-sm font-mono font-medium text-gray-800 dark:text-gray-200">
                v{appVersion}
              </span>
            </div>
            {updateInfo && (updateStatus === "has_update" || updateStatus === "up_to_date") && (
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{t("settings.latestVersion")}</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-mono font-medium text-gray-800 dark:text-gray-200">
                    {updateInfo.latestVersion}
                  </span>
                  {updateStatus === "has_update" && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border-[0.5px] bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800">
                      {t("settings.newVersion")}
                    </span>
                  )}
                </div>
              </div>
            )}
            {updateStatus === "up_to_date" && (
              <p className="text-xs text-green-600 dark:text-green-400 font-medium flex items-center gap-1">
                <CheckCircle2 size={14} /> {t("settings.upToDate")}
              </p>
            )}
            {updateStatus === "error" && (
              <p className="text-xs text-red-500 font-medium flex items-center gap-1">
                <AlertCircle size={14} /> {t("settings.checkFailed")}: {updateError}
              </p>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap items-center gap-3">
            <motion.button
              whileTap={{ scale: 0.95 }}
              onClick={handleCheckUpdate}
              disabled={updateStatus === "checking"}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-500 text-white rounded-xl text-sm font-medium hover:bg-indigo-600 transition-colors disabled:opacity-50 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)]"
            >
              <Download size={16} />
              {updateStatus === "checking" ? t("settings.checking") : t("settings.checkUpdate")}
            </motion.button>
            {updateStatus === "has_update" && updateInfo?.releaseUrl && (
              <motion.button
                whileTap={{ scale: 0.95 }}
                onClick={() => handleOpenUrl(updateInfo.releaseUrl)}
                className="flex items-center gap-2 px-4 py-2 bg-green-500 text-white rounded-xl text-sm font-medium hover:bg-green-600 transition-colors shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)]"
              >
                <ExternalLink size={16} /> {t("settings.download")}
              </motion.button>
            )}
          </div>

          {/* Divider */}
          <div className="border-t border-black/5 dark:border-white/10" />

          {/* Log export */}
          <div className="flex flex-col gap-2">
            <p className="text-xs text-gray-500 dark:text-gray-400">{t("settings.exportLogsHint")}</p>
            {exportMessage && (
              <div className="flex items-center gap-2 text-xs font-medium">
                {exportMessage.ok ? <CheckCircle2 size={14} className="text-green-500 shrink-0" /> : <AlertCircle size={14} className="text-red-500 shrink-0" />}
                <span className={exportMessage.ok ? "text-green-600 dark:text-green-400" : "text-red-500"} style={{ wordBreak: "break-all" }}>{exportMessage.text}</span>
              </div>
            )}
            <motion.button
              whileTap={{ scale: 0.95 }}
              onClick={handleExportLogs}
              disabled={exporting}
              className="flex items-center gap-2 px-4 py-2 bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-200 rounded-xl text-sm font-medium hover:bg-gray-200 dark:hover:bg-white/20 transition-colors disabled:opacity-50 self-start"
            >
              <FileArchive size={16} />
              {exporting ? t("settings.exporting") : t("settings.exportLogs")}
            </motion.button>
          </div>
        </SettingsCard>
      </div>

      {/* Floating Action Bar */}
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-4 p-2 bg-white/80 dark:bg-[#282828]/80 backdrop-blur-2xl rounded-2xl border-[0.5px] border-black/10 dark:border-white/10 shadow-[0_8px_32px_-8px_rgba(0,0,0,0.1),inset_0_1px_0_0_rgba(255,255,255,0.4)] dark:shadow-[0_8px_32px_-8px_rgba(0,0,0,0.4),inset_0_1px_0_0_rgba(255,255,255,0.05)] z-40">
        <div className="absolute inset-0 pointer-events-none opacity-[0.015] bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0IiBoZWlnaHQ9IjQiPjxyZWN0IHdpZHRoPSI0IiBoZWlnaHQ9IjQiIGZpbGw9IiNmZmYiIGZpbGwtb3BhY2l0eT0iMC4wMSIvPjxwYXRoIGQ9Ik0wIDBoNHY0SDBWMHptMSAxYTEgMSAwIDAgMCAwIDJoMmExIDEgMCAwIDAgMC0yaC0yeiIgZmlsbD0iIzAwMCIgZmlsbC1vcGFjaXR5PSIwLjA1Ii8+PC9zdmc+')] mix-blend-overlay rounded-2xl" />

        {message && (
          <div className="absolute -top-12 left-1/2 -translate-x-1/2 px-4 py-2 bg-white dark:bg-gray-800 rounded-lg shadow-lg border-[0.5px] border-black/5 dark:border-white/10 whitespace-nowrap text-sm font-medium flex items-center gap-2">
            {message.ok ? <CheckCircle2 size={16} className="text-green-500" /> : <AlertCircle size={16} className="text-red-500" />}
            <span className="text-gray-800 dark:text-gray-200">{message.text}</span>
          </div>
        )}

        <motion.button
          whileTap={{ scale: 0.96 }}
          onClick={handleRestore}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-gray-100 dark:bg-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-white/20 transition-colors"
        >
          <RotateCcw size={16} /> {t("settings.restoreDefaults")}
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.96 }}
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-6 py-2 rounded-xl text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)] transition-colors disabled:opacity-50"
        >
          <Save size={16} /> {saving ? t("settings.saving") : t("settings.saveSettings")}
        </motion.button>
      </div>
    </div>
  );
}

function SettingsCard({ title, icon, children, className = "" }: { title: string; icon: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`p-5 bg-white/50 dark:bg-[#1e1e1e]/50 backdrop-blur-md rounded-2xl border-[0.5px] border-black/5 dark:border-white/10 shadow-[0_4px_12px_-4px_rgba(0,0,0,0.05),inset_0_1px_0_0_rgba(255,255,255,0.4)] dark:shadow-[0_4px_12px_-4px_rgba(0,0,0,0.2),inset_0_1px_0_0_rgba(255,255,255,0.05)] ${className}`}>
      <div className="flex items-center gap-2 mb-4">
        {icon}
        <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-100">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function NumberInput({ label, value, min, max, onChange, hint }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; hint?: string }) {
  return (
    <div className="flex flex-col gap-1.5 mb-4">
      <label className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">{label}</label>
      <input
        type="number"
        min={min} max={max}
        value={value}
        onChange={(e) => onChange(clampNum(e.target.value, min, max, value))}
        className="w-full bg-white dark:bg-black/20 border-[0.5px] border-black/10 dark:border-white/10 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.2)] rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-4 focus:ring-blue-500/20 transition-all"
      />
      {hint && <p className="text-[11px] text-gray-500 mt-0.5">{hint}</p>}
    </div>
  );
}

function IntegrationStatus({
  name,
  status,
  onSetup,
  onRetry,
  errorMsg,
  configPath,
  scriptPath,
  onOpenConfig,
  manualCode,
  manualHint
}: any) {
  const { t } = useLocale();

  return (
    <>
      <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-white/5 rounded-xl border-[0.5px] border-black/5 dark:border-white/10">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">{name}</span>
        <div className="flex items-center gap-3">
          {status === "loading" && <StatusBadge text={t("settings.checking")} color="gray" />}
          {status === "configured" && <StatusBadge text={t("settings.configured")} color="green" />}
          {status === "not_installed" && <StatusBadge text={t("settings.notInstalled")} color="gray" />}
          {status === "setting_up" && <StatusBadge text={t("settings.settingUp")} color="blue" />}
          {status === "missing" && (
            <>
              <StatusBadge text={t("settings.missing")} color="yellow" />
              <motion.button whileTap={{ scale: 0.95 }} onClick={onSetup} className="px-3 py-1 bg-blue-500 text-white rounded-md text-xs font-medium hover:bg-blue-600 transition-colors">
                {t("settings.autoConfig")}
              </motion.button>
            </>
          )}
          {status === "error" && (
            <>
              <StatusBadge text={t("settings.error")} color="red" />
              <motion.button whileTap={{ scale: 0.95 }} onClick={onRetry} className="px-3 py-1 bg-gray-200 dark:bg-white/20 text-gray-800 dark:text-white rounded-md text-xs font-medium hover:bg-gray-300 dark:hover:bg-white/30 transition-colors">
                {t("settings.retry")}
              </motion.button>
            </>
          )}
        </div>
      </div>

      {status === "error" && errorMsg && <p className="text-xs text-red-500 font-medium">{errorMsg}</p>}

      {status !== "loading" && status !== "not_installed" && (
        <div className="flex flex-col gap-3 p-4 bg-gray-50/50 dark:bg-black/20 rounded-xl border-[0.5px] border-black/5 dark:border-white/10">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex flex-col">
              <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-0.5">{t("settings.configFile")}</span>
              <code className="text-xs text-gray-800 dark:text-gray-300 font-mono bg-white dark:bg-black/30 px-1.5 py-0.5 rounded border-[0.5px] border-black/5 dark:border-white/10 break-all">{configPath}</code>
            </div>
            <motion.button whileTap={{ scale: 0.95 }} onClick={onOpenConfig} className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-white dark:bg-white/10 border-[0.5px] border-black/10 dark:border-white/10 rounded-lg text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/20 transition-colors self-start sm:self-auto shrink-0">
              <FolderOpen size={14} /> {t("settings.open")}
            </motion.button>
          </div>

          <div className="flex flex-col">
            <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-0.5">{t("settings.hookScript")}</span>
            <code className="text-xs text-gray-800 dark:text-gray-300 font-mono bg-white dark:bg-black/30 px-1.5 py-0.5 rounded border-[0.5px] border-black/5 dark:border-white/10 break-all">{scriptPath || t("common.unknown")}</code>
          </div>

          {(status === "missing" || status === "error") && (
            <div className="mt-2 p-3 bg-yellow-50 dark:bg-yellow-900/10 border-[0.5px] border-yellow-200 dark:border-yellow-800/50 rounded-lg">
              <p className="text-xs text-yellow-800 dark:text-yellow-400 mb-1.5">{manualHint}</p>
              <code className="block text-[11px] font-mono text-gray-800 dark:text-gray-300 bg-white/50 dark:bg-black/20 p-2 rounded border-[0.5px] border-yellow-200/50 dark:border-yellow-800/30 whitespace-pre-wrap break-all">
                {manualCode}
              </code>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function StatusBadge({ text, color }: { text: string; color: "green" | "gray" | "yellow" | "blue" | "red" }) {
  const colors = {
    green: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800",
    gray: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400 border-gray-200 dark:border-gray-700",
    yellow: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800",
    blue: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800",
    red: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border-[0.5px] ${colors[color]}`}>
      {text}
    </span>
  );
}
