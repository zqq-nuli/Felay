export type SessionStatus = "listening" | "proxy_on" | "ended";

/* ── Bot configuration types ── */

export interface InteractiveBotConfig {
  id: string;
  name: string;
  appId: string;
  appSecret: string;
  encryptKey?: string;
}

export interface PushBotConfig {
  id: string;
  name: string;
  webhook: string;
  secret?: string;
}

export interface ReconnectSettings {
  maxRetries: number;
  initialInterval: number;
  backoffMultiplier: number;
}

export interface PushSettings {
  mergeWindow: number;
  maxMessageBytes: number;
}

export interface AppConfig {
  bots: {
    interactive: InteractiveBotConfig[];
    push: PushBotConfig[];
  };
  reconnect: ReconnectSettings;
  push: PushSettings;
}

export const defaultAppConfig: AppConfig = {
  bots: { interactive: [], push: [] },
  reconnect: { maxRetries: 3, initialInterval: 5, backoffMultiplier: 2 },
  push: { mergeWindow: 2000, maxMessageBytes: 30000 },
};

export interface SessionRegistration {
  type: "register_session";
  payload: {
    sessionId: string;
    cli: string;
    args: string[];
    cwd: string;
    pid: number;
    startedAt: string;
  };
}

export interface PtyOutputEvent {
  type: "pty_output";
  payload: {
    sessionId: string;
    chunk: string;
    stream: "stdout" | "stderr";
    at: string;
  };
}

export interface FeishuInputEvent {
  type: "feishu_input";
  payload: {
    sessionId: string;
    text: string;
    at: string;
  };
}

export interface StatusRequest {
  type: "status_request";
}

export interface StopRequest {
  type: "stop_request";
}

export interface StatusResponse {
  type: "status_response";
  payload: {
    daemonPid: number;
    activeSessions: number;
    sessions: Array<{
      sessionId: string;
      cli: string;
      cwd: string;
      status: SessionStatus;
      startedAt: string;
      interactiveBotId?: string;
      interactiveBotConnected?: boolean;
      pushBotId?: string;
      pushEnabled?: boolean;
    }>;
    warnings?: Array<{ botId: string; message: string }>;
  };
}

export interface StopResponse {
  type: "stop_response";
  payload: {
    ok: boolean;
  };
}

export interface SessionEndedEvent {
  type: "session_ended";
  payload: {
    sessionId: string;
    at: string;
  };
}

/* ── Bot CRUD messages ── */

export interface ListBotsRequest {
  type: "list_bots_request";
}

export interface ListBotsResponse {
  type: "list_bots_response";
  payload: {
    interactive: InteractiveBotConfig[];
    push: PushBotConfig[];
  };
}

export type BotType = "interactive" | "push";

export interface SaveBotRequest {
  type: "save_bot_request";
  payload: {
    botType: BotType;
    interactive?: InteractiveBotConfig;
    push?: PushBotConfig;
  };
}

export interface SaveBotResponse {
  type: "save_bot_response";
  payload: { ok: boolean; error?: string };
}

export interface DeleteBotRequest {
  type: "delete_bot_request";
  payload: { botType: BotType; botId: string };
}

export interface DeleteBotResponse {
  type: "delete_bot_response";
  payload: { ok: boolean; error?: string };
}

/* ── Session-bot binding messages ── */

export interface BindBotRequest {
  type: "bind_bot_request";
  payload: {
    sessionId: string;
    botType: BotType;
    botId: string;
  };
}

export interface UnbindBotRequest {
  type: "unbind_bot_request";
  payload: {
    sessionId: string;
    botType: BotType;
  };
}

export interface BindBotResponse {
  type: "bind_bot_response";
  payload: { ok: boolean; error?: string };
}

/* ── Test bot messages ── */

export interface TestBotRequest {
  type: "test_bot_request";
  payload: {
    botType: BotType;
    botId: string;
  };
}

export interface TestBotResponse {
  type: "test_bot_response";
  payload: {
    ok: boolean;
    error?: string;
    botName?: string;
  };
}

/* ── Config messages ── */

export interface GetConfigRequest {
  type: "get_config_request";
}

export interface GetConfigResponse {
  type: "get_config_response";
  payload: AppConfig;
}

export interface SaveConfigRequest {
  type: "save_config_request";
  payload: AppConfig;
}

export interface SaveConfigResponse {
  type: "save_config_response";
  payload: { ok: boolean; error?: string };
}

export type DaemonMessage =
  | SessionRegistration
  | PtyOutputEvent
  | FeishuInputEvent
  | StatusRequest
  | StopRequest
  | SessionEndedEvent
  | ListBotsRequest
  | SaveBotRequest
  | DeleteBotRequest
  | BindBotRequest
  | UnbindBotRequest
  | TestBotRequest
  | GetConfigRequest
  | SaveConfigRequest;

export type DaemonReply =
  | StatusResponse
  | StopResponse
  | ListBotsResponse
  | SaveBotResponse
  | DeleteBotResponse
  | BindBotResponse
  | TestBotResponse
  | GetConfigResponse
  | SaveConfigResponse;

export interface DaemonLockFile {
  pid: number;
  ipc: string;
  started_at: string;
}

export function toJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function parseJsonLine(line: string): unknown {
  return JSON.parse(line);
}
