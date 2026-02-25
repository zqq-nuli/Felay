import React from 'react';
import { motion } from 'framer-motion';
import { TerminalSquare, Bot, Settings, Globe } from 'lucide-react';
import clsx from 'clsx';
import { useLocale } from './i18n';

// Apple Spring physics config
const springConfig = { type: "spring" as const, stiffness: 300, damping: 30 };

type TabKey = "sessions" | "robots" | "settings";

export default function AppShell({ 
  children,
  activeTab,
  setActiveTab
}: { 
  children: React.ReactNode;
  activeTab: TabKey;
  setActiveTab: (tab: TabKey) => void;
}) {
  const { locale, setLocale, t } = useLocale();

  const navItems: { id: TabKey; label: string; icon: any }[] = [
    { id: 'sessions', label: t("nav.sessions"), icon: TerminalSquare },
    { id: 'robots', label: t("nav.bots"), icon: Bot },
    { id: 'settings', label: t("nav.settings"), icon: Settings },
  ];

  return (
    <div className="flex h-screen w-full overflow-hidden bg-transparent antialiased text-[#1c1c1e] dark:text-[#f5f5f7] font-sans">
      {/* Forced noise texture to prevent color banding and add physical texture */}
      <div className="pointer-events-none fixed inset-0 z-50 opacity-[0.015] mix-blend-overlay" 
           style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.65%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E")' }}>
      </div>

      {/* Sidebar - Thin Material */}
      <aside className="relative flex w-60 flex-col bg-gray-100/60 dark:bg-[#1e1e1e]/60 backdrop-blur-2xl saturate-150 border-r border-black/5 dark:border-white/10 pt-12 pb-4 px-3">
        {/* macOS Traffic Lights (Decorative, actual window controls usually managed by OS/Tauri) */}
        <div className="absolute top-4 left-4 flex gap-[8px] group">
          <div className="w-3 h-3 rounded-full bg-[#FF5F56] border-[0.5px] border-black/10 dark:border-black/20" />
          <div className="w-3 h-3 rounded-full bg-[#FFBD2E] border-[0.5px] border-black/10 dark:border-black/20" />
          <div className="w-3 h-3 rounded-full bg-[#27C93F] border-[0.5px] border-black/10 dark:border-black/20" />
        </div>

        {/* Sidebar Navigation */}
        <nav className="flex-1 space-y-1 mt-6">
          <div className="px-2 text-xs font-semibold text-gray-400 dark:text-gray-500 mb-2 tracking-wide">{t("nav.title")}</div>
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={clsx(
                "relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors duration-200",
                activeTab === item.id 
                  ? "text-white dark:text-white" 
                  : "text-gray-700 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5"
              )}
            >
              {activeTab === item.id && (
                <motion.div
                  layoutId="sidebar-active-bubble"
                  className="absolute inset-0 rounded-md bg-blue-500 shadow-sm"
                  transition={springConfig}
                  style={{ zIndex: -1 }}
                />
              )}
              <item.icon strokeWidth={1.5} className="w-[18px] h-[18px]" />
              <span className="font-medium tracking-wide">{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="mt-auto px-2 pt-4 border-t border-black/5 dark:border-white/10">
          <button
            onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
            className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-sm text-gray-500 dark:text-gray-400 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            <Globe strokeWidth={1.5} className="w-[18px] h-[18px]" />
            <span className="font-medium">{locale === "zh" ? "中文" : "English"}</span>
          </button>
        </div>
      </aside>

      {/* Main Window - Thick Material */}
      <main className="relative flex-1 bg-white/80 dark:bg-[#282828]/70 backdrop-blur-3xl shadow-[inset_0_1px_0_0_rgba(255,255,255,0.4)] dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] overflow-y-auto">
        <div className="h-full p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
