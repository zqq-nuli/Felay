export type TabKey = "sessions" | "robots" | "settings";
export type SessionStatus = "listening" | "proxy_on" | "ended";

export interface SessionItem {
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

export interface BotWarning {
  botId: string;
  message: string;
}

export interface GuiStatus {
  running: boolean;
  daemon_pid: number | null;
  active_sessions: number;
  sessions: SessionItem[];
  warnings: BotWarning[];
}

export interface InteractiveBot {
  id: string;
  name: string;
  appId: string;
  appSecret: string;
  encryptKey?: string;
}

export interface PushBot {
  id: string;
  name: string;
  webhook: string;
  secret?: string;
}

export interface BotsData {
  interactive: InteractiveBot[];
  push: PushBot[];
}

export interface AppConfig {
  bots: { interactive: InteractiveBot[]; push: PushBot[] };
  reconnect: { maxRetries: number; initialInterval: number; backoffMultiplier: number };
  push: { mergeWindow: number; maxMessageBytes: number };
  input?: { enterRetryCount: number; enterRetryInterval: number };
}
