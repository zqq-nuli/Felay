import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import AppShell from "./AppShell";
import SessionsView from "./SessionsView";
import RobotsView from "./RobotsView";
import SettingsView from "./SettingsView";
import { LocaleProvider } from "./i18n";
import type { TabKey, GuiStatus, BotsData } from "./types";

const emptyStatus: GuiStatus = {
  running: false,
  daemon_pid: null,
  active_sessions: 0,
  sessions: [],
  warnings: [],
};

const emptyBots: BotsData = { interactive: [], push: [] };

export function App() {
  const [tab, setTab] = useState<TabKey>("sessions");
  const [status, setStatus] = useState<GuiStatus>(emptyStatus);
  const [selected, setSelected] = useState("");
  const [bots, setBots] = useState<BotsData>(emptyBots);
  const [daemonStarting, setDaemonStarting] = useState(false);

  const loadBots = useCallback(async () => {
    try {
      const data = await invoke<BotsData>("list_bots");
      setBots(data);
    } catch {
      setBots(emptyBots);
    }
  }, []);

  // Auto-start daemon on first load if not running
  useEffect(() => {
    let cancelled = false;

    const tryAutoStart = async () => {
      try {
        const currentStatus = await invoke<GuiStatus>("read_daemon_status");
        if (currentStatus.running) return; // already running
      } catch {
        // ignore — daemon not reachable
      }

      if (cancelled) return;
      setDaemonStarting(true);
      try {
        await invoke("start_daemon");
      } catch (e) {
        console.warn("[gui] auto-start daemon failed:", e);
      }
      if (!cancelled) setDaemonStarting(false);
    };

    tryAutoStart();
    return () => {
      cancelled = true;
    };
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

  const connectedBotIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of status.sessions) {
      if (s.interactive_bot_id && s.interactive_bot_connected) {
        ids.add(s.interactive_bot_id);
      }
    }
    return ids;
  }, [status.sessions]);

  return (
    <LocaleProvider>
      <AppShell activeTab={tab} setActiveTab={setTab as any}>
        {tab === "sessions" ? (
          <SessionsView sessions={status.sessions} bots={bots} />
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

        {status.warnings.length > 0 && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-yellow-50 dark:bg-yellow-900/40 border border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-200 px-4 py-2 rounded-lg shadow-lg flex flex-col gap-1 text-xs backdrop-blur-md z-50">
            {status.warnings.map((w) => (
              <span key={w.botId} className="font-medium">{w.message}</span>
            ))}
          </div>
        )}
      </AppShell>
    </LocaleProvider>
  );
}
