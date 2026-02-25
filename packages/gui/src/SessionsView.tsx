import React from 'react';
import { motion } from 'framer-motion';
import { Play, Square, Link2, Terminal, ChevronDown } from 'lucide-react';
import { invoke } from "@tauri-apps/api/core";
import { useLocale } from "./i18n";
import type { SessionItem, BotsData } from "./types";

const springConfig = { type: "spring" as const, stiffness: 400, damping: 25 };

export default function SessionsView({
  sessions,
  bots,
}: {
  sessions: SessionItem[];
  bots: BotsData;
}) {
  const { t } = useLocale();

  return (
    <div className="max-w-4xl mx-auto pb-10">
      <header className="flex justify-between items-end mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">{t("sessions.title")}</h1>
          <p className="text-sm text-gray-500 mt-1">{t("sessions.subtitle")}</p>
        </div>

        {/* Decorative Primary Push Button */}
        <motion.button
          whileTap={{ scale: 0.96 }}
          transition={springConfig}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-b from-blue-500 to-blue-600 text-white rounded-md shadow-sm border-[0.5px] border-black/20 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)] cursor-default opacity-80"
          title={t("sessions.terminalHint")}
        >
          <Terminal size={14} fill="currentColor" />
          <span className="text-sm font-medium">{t("sessions.terminalOnly")}</span>
        </motion.button>
      </header>

      {sessions.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-12 text-center border border-dashed border-gray-300 dark:border-gray-700 rounded-2xl">
          <Terminal className="w-12 h-12 text-gray-300 dark:text-gray-600 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">{t("sessions.empty.title")}</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t("sessions.empty.desc")}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sessions.map((session) => (
            <SessionCard key={session.session_id} session={session} bots={bots} />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionCard({ session, bots }: { session: SessionItem; bots: BotsData }) {
  const [showBindings, setShowBindings] = React.useState(false);
  const { t } = useLocale();

  const interactiveBotName = bots.interactive.find((b) => b.id === session.interactive_bot_id)?.name;
  const pushBotName = bots.push.find((b) => b.id === session.push_bot_id)?.name;

  const statusLabel =
    session.status === 'proxy_on' ? t("sessions.status.proxy_on")
    : session.status === 'ended' ? t("sessions.status.ended")
    : t("sessions.status.listening");

  return (
    <motion.div
      whileHover={{ scale: 1.02 }}
      transition={springConfig}
      className="group relative flex flex-col p-4 bg-white/50 dark:bg-[#1e1e1e]/50 backdrop-blur-md rounded-2xl border-[0.5px] border-black/5 dark:border-white/10 shadow-[0_4px_12px_-4px_rgba(0,0,0,0.05),inset_0_1px_0_0_rgba(255,255,255,0.4)] dark:shadow-[0_4px_12px_-4px_rgba(0,0,0,0.2),inset_0_1px_0_0_rgba(255,255,255,0.05)]"
    >
      <div className="flex justify-between items-start mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gray-100 dark:bg-white/5 rounded-lg border-[0.5px] border-black/5 dark:border-white/10 shadow-sm">
            <Terminal strokeWidth={1.5} className="w-5 h-5 text-gray-700 dark:text-gray-300" />
          </div>
          <div>
            <h3 className="text-sm font-semibold tracking-wide text-gray-900 dark:text-white truncate max-w-[120px]" title={session.cli}>
              {session.cli || t("common.unknown")}
            </h3>
            <p className="text-[11px] text-gray-500 truncate max-w-[140px]" title={session.cwd}>{session.cwd}</p>
          </div>
        </div>

        {/* Status indicator */}
        <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full border-[0.5px] shadow-sm ${
          session.status === 'proxy_on'
            ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
            : session.status === 'ended'
            ? 'bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700'
            : 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800'
        }`}>
          <div className={`w-2 h-2 rounded-full shadow-sm ${
            session.status === 'proxy_on'
              ? 'bg-green-500 shadow-green-500/50'
              : session.status === 'ended'
              ? 'bg-gray-400 shadow-gray-400/50'
              : 'bg-yellow-500 shadow-yellow-500/50'
          }`} />
          <span className={`text-[10px] font-medium uppercase tracking-wider ${
            session.status === 'proxy_on' ? 'text-green-700 dark:text-green-400'
            : session.status === 'ended' ? 'text-gray-600 dark:text-gray-400'
            : 'text-yellow-700 dark:text-yellow-400'
          }`}>
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="mt-auto flex flex-col gap-2">
        <motion.button
          whileTap={{ scale: 0.95 }}
          onClick={() => setShowBindings(!showBindings)}
          className="w-full flex items-center justify-center gap-2 py-1.5 bg-white dark:bg-white/10 rounded-md border-[0.5px] border-black/10 dark:border-white/10 shadow-sm text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/20 transition-colors"
        >
          <Link2 size={14} />
          {interactiveBotName || pushBotName ? t("sessions.bindingsActive") : t("sessions.bindBot")}
          <ChevronDown size={14} className={`transition-transform ${showBindings ? 'rotate-180' : ''}`} />
        </motion.button>
      </div>

      {showBindings && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="mt-3 pt-3 border-t border-black/5 dark:border-white/10 flex flex-col gap-3"
        >
          {/* Interactive Bot Binding */}
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">{t("sessions.interactiveBot")}</span>
            <div className="flex gap-2">
              <select
                className="flex-1 appearance-none bg-white dark:bg-black/20 border-[0.5px] border-black/10 dark:border-white/10 rounded-md px-2 py-1 text-xs text-gray-800 dark:text-gray-200 outline-none focus:ring-2 focus:ring-blue-500/50"
                value={session.interactive_bot_id || ""}
                onChange={async (e) => {
                  const val = e.target.value;
                  if (!val) {
                    await invoke("unbind_bot", { sessionId: session.session_id, botType: "interactive" });
                  } else {
                    await invoke("bind_bot", { sessionId: session.session_id, botType: "interactive", botId: val });
                  }
                }}
              >
                <option value="" className="bg-white dark:bg-[#1e1e1e] text-gray-900 dark:text-gray-100">{t("sessions.none")}</option>
                {bots.interactive.map(b => (
                  <option key={b.id} value={b.id} className="bg-white dark:bg-[#1e1e1e] text-gray-900 dark:text-gray-100">{b.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Push Bot Binding */}
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">{t("sessions.pushBot")}</span>
            <div className="flex gap-2">
              <select
                className="flex-1 appearance-none bg-white dark:bg-black/20 border-[0.5px] border-black/10 dark:border-white/10 rounded-md px-2 py-1 text-xs text-gray-800 dark:text-gray-200 outline-none focus:ring-2 focus:ring-blue-500/50"
                value={session.push_bot_id || ""}
                onChange={async (e) => {
                  const val = e.target.value;
                  if (!val) {
                    await invoke("unbind_bot", { sessionId: session.session_id, botType: "push" });
                  } else {
                    await invoke("bind_bot", { sessionId: session.session_id, botType: "push", botId: val });
                  }
                }}
              >
                <option value="" className="bg-white dark:bg-[#1e1e1e] text-gray-900 dark:text-gray-100">{t("sessions.none")}</option>
                {bots.push.map(b => (
                  <option key={b.id} value={b.id} className="bg-white dark:bg-[#1e1e1e] text-gray-900 dark:text-gray-100">{b.name}</option>
                ))}
              </select>
            </div>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}
