// Node.js/axios 不受 Clash 分流规则控制，需要显式设置 NO_PROXY 绕过系统代理
process.env.NO_PROXY = "open.feishu.cn,*.feishu.cn,*.larksuite.com";

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import {
  toJsonLine,
  type StatusResponse,
  type StopResponse,
  type ListBotsResponse,
  type SaveBotResponse,
  type DeleteBotResponse,
  type BindBotResponse,
  type TestBotResponse,
  type GetConfigResponse,
  type SaveConfigResponse,
  type SetDefaultBotResponse,
  type GetDefaultsResponse,
  type CodexNotifyEvent,
  type CheckCodexConfigResponse,
  type SetupCodexConfigResponse,
  type ClaudeNotifyEvent,
  type CheckClaudeConfigResponse,
  type SetupClaudeConfigResponse,
  type DaemonLockFile,
} from "@felay/shared";
import { getIpcPath } from "./ipc.js";
import { SessionRegistry } from "./sessionRegistry.js";
import { ConfigManager } from "./configManager.js";
import { OutputBuffer } from "./outputBuffer.js";
import { FeishuManager } from "./feishuManager.js";
import { checkCodexConfig, setupCodexConfig } from "./codexConfig.js";
import { checkClaudeConfig, setupClaudeConfig } from "./claudeConfig.js";

/* ── Zod schemas ── */

const registerSchema = z.object({
  type: z.literal("register_session"),
  payload: z.object({
    sessionId: z.string(),
    cli: z.string(),
    args: z.array(z.string()),
    cwd: z.string(),
    pid: z.number(),
    startedAt: z.string(),
  }),
});

const ptyOutputSchema = z.object({
  type: z.literal("pty_output"),
  payload: z.object({
    sessionId: z.string(),
    chunk: z.string(),
    stream: z.enum(["stdout", "stderr"]),
    at: z.string(),
  }),
});

const endedSchema = z.object({
  type: z.literal("session_ended"),
  payload: z.object({
    sessionId: z.string(),
    at: z.string(),
  }),
});

const statusSchema = z.object({ type: z.literal("status_request") });
const stopSchema = z.object({ type: z.literal("stop_request") });

const listBotsSchema = z.object({ type: z.literal("list_bots_request") });

const saveBotSchema = z.object({
  type: z.literal("save_bot_request"),
  payload: z.object({
    botType: z.enum(["interactive", "push"]),
    interactive: z
      .object({
        id: z.string(),
        name: z.string(),
        appId: z.string(),
        appSecret: z.string(),
        encryptKey: z.string().optional(),
      })
      .optional(),
    push: z
      .object({
        id: z.string(),
        name: z.string(),
        webhook: z.string(),
        secret: z.string().optional(),
      })
      .optional(),
  }),
});

const deleteBotSchema = z.object({
  type: z.literal("delete_bot_request"),
  payload: z.object({
    botType: z.enum(["interactive", "push"]),
    botId: z.string(),
  }),
});

const bindBotSchema = z.object({
  type: z.literal("bind_bot_request"),
  payload: z.object({
    sessionId: z.string(),
    botType: z.enum(["interactive", "push"]),
    botId: z.string(),
  }),
});

const unbindBotSchema = z.object({
  type: z.literal("unbind_bot_request"),
  payload: z.object({
    sessionId: z.string(),
    botType: z.enum(["interactive", "push"]),
  }),
});

const testBotSchema = z.object({
  type: z.literal("test_bot_request"),
  payload: z.object({
    botType: z.enum(["interactive", "push"]),
    botId: z.string(),
  }),
});

const getConfigSchema = z.object({ type: z.literal("get_config_request") });

const saveConfigSchema = z.object({
  type: z.literal("save_config_request"),
  payload: z.object({
    bots: z.object({
      interactive: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          appId: z.string(),
          appSecret: z.string(),
          encryptKey: z.string().optional(),
        })
      ),
      push: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          webhook: z.string(),
          secret: z.string().optional(),
        })
      ),
    }),
    reconnect: z.object({
      maxRetries: z.number(),
      initialInterval: z.number(),
      backoffMultiplier: z.number(),
    }),
    push: z.object({
      mergeWindow: z.number(),
      maxMessageBytes: z.number(),
    }),
    defaults: z.object({
      defaultInteractiveBotId: z.string().optional(),
      defaultPushBotId: z.string().optional(),
    }).optional(),
    input: z.object({
      enterRetryCount: z.number(),
      enterRetryInterval: z.number(),
    }).optional(),
  }),
});

const setDefaultBotSchema = z.object({
  type: z.literal("set_default_bot_request"),
  payload: z.object({
    botType: z.enum(["interactive", "push"]),
    botId: z.string().nullable(),
  }),
});

const getDefaultsSchema = z.object({ type: z.literal("get_defaults_request") });

const codexNotifySchema = z.object({
  type: z.literal("codex_notify"),
  payload: z.object({
    cwd: z.string(),
    message: z.string(),
    turnId: z.string(),
    threadId: z.string(),
  }),
});

const checkCodexConfigSchema = z.object({ type: z.literal("check_codex_config_request") });
const setupCodexConfigSchema = z.object({ type: z.literal("setup_codex_config_request") });

const claudeNotifySchema = z.object({
  type: z.literal("claude_notify"),
  payload: z.object({
    cwd: z.string(),
    message: z.string(),
    sessionId: z.string(),
  }),
});

const checkClaudeConfigSchema = z.object({ type: z.literal("check_claude_config_request") });
const setupClaudeConfigSchema = z.object({ type: z.literal("setup_claude_config_request") });

/* ── Helpers ── */

function isCodexSession(cli: string): boolean {
  const base = cli.replace(/\\/g, "/").split("/").pop() || "";
  const name = base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  return name === "codex";
}

function isClaudeSession(cli: string): boolean {
  const base = cli.replace(/\\/g, "/").split("/").pop() || "";
  const name = base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  return name === "claude";
}

/** Sessions using hook-based notify (bypass PTY output parsing). */
function isHookSession(cli: string): boolean {
  return isCodexSession(cli) || isClaudeSession(cli);
}

function getStateDir(): string {
  return path.join(os.homedir(), ".felay");
}

function getLockFilePath(): string {
  return path.join(getStateDir(), "daemon.json");
}

async function ensureSocketDir(ipcPath: string): Promise<void> {
  if (process.platform === "win32") return;
  await fs.promises.mkdir(path.dirname(ipcPath), { recursive: true });
  try {
    await fs.promises.unlink(ipcPath);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
}

async function writeLockFile(ipcPath: string): Promise<void> {
  await fs.promises.mkdir(getStateDir(), { recursive: true });
  const lock: DaemonLockFile = {
    pid: process.pid,
    ipc: ipcPath,
    started_at: new Date().toISOString(),
  };
  await fs.promises.writeFile(getLockFilePath(), JSON.stringify(lock, null, 2), "utf8");
}

async function removeLockFile(): Promise<void> {
  const lockPath = getLockFilePath();
  if (fs.existsSync(lockPath)) {
    await fs.promises.unlink(lockPath);
  }
}

async function cleanup(server: net.Server, ipcPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  if (process.platform !== "win32" && fs.existsSync(ipcPath)) {
    await fs.promises.unlink(ipcPath);
  }
  await removeLockFile();
}

/* ── Main ── */

async function main(): Promise<void> {
  const registry = new SessionRegistry();
  const configManager = new ConfigManager();
  await configManager.load();

  const ipcPath = getIpcPath();
  await ensureSocketDir(ipcPath);

  /* ── M3: Session→Socket mapping ── */
  const socketMap = new Map<string, net.Socket>();

  /* ── M3: OutputBuffer + FeishuManager ── */
  const pushSettings = configManager.getConfig().push;

  // Forward-declare feishuManager so OutputBuffer callbacks can reference it
  let feishuManager: FeishuManager;

  const outputBuffer = new OutputBuffer({
    interactiveSilenceMs: 5000,
    pushMergeWindowMs: pushSettings.mergeWindow,
    maxMessageBytes: pushSettings.maxMessageBytes,
    onInteractiveReply: (sessionId, fullOutput) => {
      void feishuManager.sendInteractiveReply(sessionId, fullOutput);
    },
    onPushFlush: (sessionId, mergedOutput) => {
      void feishuManager.sendPushMessage(sessionId, mergedOutput);
    },
  });

  feishuManager = new FeishuManager(registry, configManager, socketMap, outputBuffer);

  let stopping = false;

  const server = net.createServer((socket) => {
    let buffer = "";
    /** sessionIds registered on this socket (for cleanup on disconnect) */
    const socketSessions = new Set<string>();

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        void handleMessage(
          parsed,
          socket,
          registry,
          configManager,
          feishuManager,
          outputBuffer,
          socketMap,
          socketSessions,
          () => {
            if (!stopping) {
              stopping = true;
              setTimeout(async () => {
                feishuManager.shutdown();
                await cleanup(server, ipcPath);
                process.exit(0);
              }, 50);
            }
          }
        );
      }
    });

    socket.on("close", () => {
      for (const sid of socketSessions) {
        socketMap.delete(sid);
      }
      socketSessions.clear();
    });

    socket.on("error", () => {
      for (const sid of socketSessions) {
        socketMap.delete(sid);
      }
      socketSessions.clear();
    });
  });

  server.listen(ipcPath, async () => {
    await writeLockFile(ipcPath);
    console.log(`[felay:daemon] listening on ${ipcPath}`);
  });

  // Prune ended sessions every 5 minutes to prevent unbounded memory growth
  setInterval(() => {
    registry.pruneEnded();
  }, 5 * 60 * 1000);

  const signalHandler = async () => {
    if (stopping) return;
    stopping = true;
    feishuManager.shutdown();
    await cleanup(server, ipcPath);
    process.exit(0);
  };

  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);
}

async function handleMessage(
  parsed: unknown,
  socket: net.Socket,
  registry: SessionRegistry,
  configManager: ConfigManager,
  feishuManager: FeishuManager,
  outputBuffer: OutputBuffer,
  socketMap: Map<string, net.Socket>,
  socketSessions: Set<string>,
  requestStop: () => void
): Promise<void> {
  /* ── M1 messages ── */

  const register = registerSchema.safeParse(parsed);
  if (register.success) {
    const sid = register.data.payload.sessionId;
    const existingSession = registry.get(sid);
    const isNewSession = !existingSession || existingSession.status === "ended";

    registry.register({
      sessionId: sid,
      cli: register.data.payload.cli,
      cwd: register.data.payload.cwd,
      status: "listening",
      startedAt: register.data.payload.startedAt,
    });
    // M3: track session→socket mapping
    socketMap.set(sid, socket);
    socketSessions.add(sid);

    // Auto-bind default bots for newly registered sessions
    if (isNewSession) {
      const defaults = configManager.getDefaults();
      if (defaults.defaultInteractiveBotId) {
        const bound = registry.bindInteractiveBot(sid, defaults.defaultInteractiveBotId);
        if (bound) {
          void feishuManager.startInteractiveBot(defaults.defaultInteractiveBotId);
          console.log(`[felay] auto-bound interactive bot ${defaults.defaultInteractiveBotId} to session ${sid}`);
        }
      }
      if (defaults.defaultPushBotId) {
        const bound = registry.bindPushBot(sid, defaults.defaultPushBotId);
        if (bound) {
          console.log(`[felay] auto-bound push bot ${defaults.defaultPushBotId} to session ${sid}`);
        }
      }
    }
    return;
  }

  const ptyOutput = ptyOutputSchema.safeParse(parsed);
  if (ptyOutput.success) {
    const { sessionId, chunk } = ptyOutput.data.payload;
    registry.touchProxy(sessionId);

    // Always feed summary buffer (for task summary on session end)
    outputBuffer.appendSummaryChunk(sessionId, chunk);

    // M3: feed output to buffers (skip hook-based sessions — they send clean text via notify)
    const session = registry.get(sessionId);
    if (session?.interactiveBotId && !isHookSession(session.cli)) {
      outputBuffer.appendChunk(sessionId, chunk);
    }
    if (session?.pushBotId && session.pushEnabled && !isHookSession(session.cli)) {
      outputBuffer.appendPushChunk(sessionId, chunk);
    }
    return;
  }

  const ended = endedSchema.safeParse(parsed);
  if (ended.success) {
    const sid = ended.data.payload.sessionId;
    registry.end(sid);
    // M3: notify FeishuManager + cleanup socket
    void feishuManager.onSessionEnded(sid);
    socketMap.delete(sid);
    socketSessions.delete(sid);
    return;
  }

  const status = statusSchema.safeParse(parsed);
  if (status.success) {
    const payload: StatusResponse = {
      type: "status_response",
      payload: {
        daemonPid: process.pid,
        activeSessions: registry.activeCount(),
        sessions: registry.list().map((session) => ({
          sessionId: session.sessionId,
          cli: session.cli,
          cwd: session.cwd,
          status: session.status,
          startedAt: session.startedAt,
          interactiveBotId: session.interactiveBotId,
          interactiveBotConnected: session.interactiveBotId
            ? feishuManager.isBotConnected(session.interactiveBotId)
            : undefined,
          pushBotId: session.pushBotId,
          pushEnabled: session.pushEnabled,
        })),
        warnings: feishuManager.getBotWarnings(),
      },
    };
    socket.write(toJsonLine(payload));
    return;
  }

  const stop = stopSchema.safeParse(parsed);
  if (stop.success) {
    const payload: StopResponse = {
      type: "stop_response",
      payload: { ok: true },
    };
    socket.write(toJsonLine(payload));
    requestStop();
    return;
  }

  /* ── M2: Bot CRUD ── */

  const listBots = listBotsSchema.safeParse(parsed);
  if (listBots.success) {
    const bots = configManager.getBots();
    const payload: ListBotsResponse = {
      type: "list_bots_response",
      payload: bots,
    };
    socket.write(toJsonLine(payload));
    return;
  }

  const saveBot = saveBotSchema.safeParse(parsed);
  if (saveBot.success) {
    try {
      const { botType, interactive, push } = saveBot.data.payload;
      if (botType === "interactive" && interactive) {
        await configManager.saveBotInteractive(interactive);
      } else if (botType === "push" && push) {
        await configManager.saveBotPush(push);
      } else {
        const payload: SaveBotResponse = {
          type: "save_bot_response",
          payload: { ok: false, error: "missing bot config for given type" },
        };
        socket.write(toJsonLine(payload));
        return;
      }
      const payload: SaveBotResponse = {
        type: "save_bot_response",
        payload: { ok: true },
      };
      socket.write(toJsonLine(payload));
    } catch (err) {
      const payload: SaveBotResponse = {
        type: "save_bot_response",
        payload: { ok: false, error: String(err) },
      };
      socket.write(toJsonLine(payload));
    }
    return;
  }

  const deleteBot = deleteBotSchema.safeParse(parsed);
  if (deleteBot.success) {
    try {
      const deleted = await configManager.deleteBot(
        deleteBot.data.payload.botType,
        deleteBot.data.payload.botId
      );
      const payload: DeleteBotResponse = {
        type: "delete_bot_response",
        payload: { ok: deleted, error: deleted ? undefined : "bot not found" },
      };
      socket.write(toJsonLine(payload));
    } catch (err) {
      const payload: DeleteBotResponse = {
        type: "delete_bot_response",
        payload: { ok: false, error: String(err) },
      };
      socket.write(toJsonLine(payload));
    }
    return;
  }

  /* ── M2 + M3: Session-bot binding ── */

  const bindBot = bindBotSchema.safeParse(parsed);
  if (bindBot.success) {
    const { sessionId, botType, botId } = bindBot.data.payload;
    let ok: boolean;
    if (botType === "interactive") {
      ok = registry.bindInteractiveBot(sessionId, botId);
      if (ok) {
        // M3: start WSClient connection for this bot
        void feishuManager.startInteractiveBot(botId);
      }
    } else {
      ok = registry.bindPushBot(sessionId, botId);
    }
    const payload: BindBotResponse = {
      type: "bind_bot_response",
      payload: { ok, error: ok ? undefined : "session not found" },
    };
    socket.write(toJsonLine(payload));
    return;
  }

  const unbindBot = unbindBotSchema.safeParse(parsed);
  if (unbindBot.success) {
    const { sessionId, botType } = unbindBot.data.payload;
    let ok: boolean;
    if (botType === "interactive") {
      const session = registry.get(sessionId);
      const oldBotId = session?.interactiveBotId;
      ok = registry.unbindInteractiveBot(sessionId);
      if (ok && oldBotId) {
        // M3: stop WSClient if no other session uses this bot
        const stillUsed = registry
          .list()
          .some((s) => s.interactiveBotId === oldBotId && s.status !== "ended");
        if (!stillUsed) {
          feishuManager.stopInteractiveBot(oldBotId);
        }
      }
    } else {
      ok = registry.unbindPushBot(sessionId);
      if (ok) {
        outputBuffer.cleanup(sessionId);
      }
    }
    const payload: BindBotResponse = {
      type: "bind_bot_response",
      payload: { ok, error: ok ? undefined : "session not found" },
    };
    socket.write(toJsonLine(payload));
    return;
  }

  /* ── M3: Test bot connection ── */

  const testBot = testBotSchema.safeParse(parsed);
  if (testBot.success) {
    const { botType, botId } = testBot.data.payload;
    let result: { ok: boolean; error?: string; botName?: string };
    if (botType === "interactive") {
      result = await feishuManager.testInteractiveBot(botId);
    } else {
      result = await feishuManager.testPushBot(botId);
    }
    const payload: TestBotResponse = {
      type: "test_bot_response",
      payload: result,
    };
    socket.write(toJsonLine(payload));
    return;
  }

  /* ── M2: Config read/write ── */

  const getConfig = getConfigSchema.safeParse(parsed);
  if (getConfig.success) {
    const payload: GetConfigResponse = {
      type: "get_config_response",
      payload: configManager.getConfig(),
    };
    socket.write(toJsonLine(payload));
    return;
  }

  const saveConfig = saveConfigSchema.safeParse(parsed);
  if (saveConfig.success) {
    try {
      const configPayload = {
        ...saveConfig.data.payload,
        defaults: saveConfig.data.payload.defaults ?? configManager.getDefaults(),
        input: saveConfig.data.payload.input ?? configManager.getSettings().input,
      };
      await configManager.saveSettings(configPayload);
      const payload: SaveConfigResponse = {
        type: "save_config_response",
        payload: { ok: true },
      };
      socket.write(toJsonLine(payload));
    } catch (err) {
      const payload: SaveConfigResponse = {
        type: "save_config_response",
        payload: { ok: false, error: String(err) },
      };
      socket.write(toJsonLine(payload));
    }
    return;
  }

  /* ── Default bot settings ── */

  const setDefaultBot = setDefaultBotSchema.safeParse(parsed);
  if (setDefaultBot.success) {
    try {
      const { botType, botId } = setDefaultBot.data.payload;
      const ok = await configManager.setDefaultBot(botType, botId);
      const payload: SetDefaultBotResponse = {
        type: "set_default_bot_response",
        payload: { ok, error: ok ? undefined : "bot not found" },
      };
      socket.write(toJsonLine(payload));
    } catch (err) {
      const payload: SetDefaultBotResponse = {
        type: "set_default_bot_response",
        payload: { ok: false, error: String(err) },
      };
      socket.write(toJsonLine(payload));
    }
    return;
  }

  const getDefaults = getDefaultsSchema.safeParse(parsed);
  if (getDefaults.success) {
    const payload: GetDefaultsResponse = {
      type: "get_defaults_response",
      payload: configManager.getDefaults(),
    };
    socket.write(toJsonLine(payload));
    return;
  }

  /* ── Codex config check/setup ── */

  const checkCodex = checkCodexConfigSchema.safeParse(parsed);
  if (checkCodex.success) {
    const payload: CheckCodexConfigResponse = {
      type: "check_codex_config_response",
      payload: checkCodexConfig(),
    };
    socket.write(toJsonLine(payload));
    return;
  }

  const setupCodex = setupCodexConfigSchema.safeParse(parsed);
  if (setupCodex.success) {
    const result = setupCodexConfig();
    const payload: SetupCodexConfigResponse = {
      type: "setup_codex_config_response",
      payload: result,
    };
    socket.write(toJsonLine(payload));
    return;
  }

  /* ── Codex notify hook ── */

  const codexNotify = codexNotifySchema.safeParse(parsed);
  if (codexNotify.success) {
    const { cwd, message } = codexNotify.data.payload;
    // Match cwd to an active session
    const sessions = registry.list();
    const session = sessions.find(
      (s) => s.status !== "ended" && s.cwd === cwd
    );
    if (session) {
      console.log(
        `[felay] codex notify for session ${session.sessionId}: ${message.slice(0, 80)}...`
      );
      void feishuManager.handleCodexNotify(session.sessionId, message);
    } else {
      console.log(`[felay] codex notify: no active session for cwd ${cwd}`);
    }
    return;
  }

  /* ── Claude Code notify hook ── */

  const claudeNotify = claudeNotifySchema.safeParse(parsed);
  if (claudeNotify.success) {
    const { cwd, message } = claudeNotify.data.payload;
    // Match cwd to an active session (same strategy as codex)
    const sessions = registry.list();
    const session = sessions.find(
      (s) => s.status !== "ended" && s.cwd === cwd
    );
    if (session) {
      console.log(
        `[felay] claude notify for session ${session.sessionId}: ${message.slice(0, 80)}...`
      );
      // Reuse the same feishu send path as codex notify
      void feishuManager.handleCodexNotify(session.sessionId, message);
    } else {
      console.log(`[felay] claude notify: no active session for cwd ${cwd}`);
    }
    return;
  }

  /* ── Claude Code config check/setup ── */

  const checkClaude = checkClaudeConfigSchema.safeParse(parsed);
  if (checkClaude.success) {
    const payload: CheckClaudeConfigResponse = {
      type: "check_claude_config_response",
      payload: checkClaudeConfig(),
    };
    socket.write(toJsonLine(payload));
    return;
  }

  const setupClaude = setupClaudeConfigSchema.safeParse(parsed);
  if (setupClaude.success) {
    const result = setupClaudeConfig();
    const payload: SetupClaudeConfigResponse = {
      type: "setup_claude_config_response",
      payload: result,
    };
    socket.write(toJsonLine(payload));
    return;
  }
}

main().catch((error) => {
  console.error("[felay:daemon] failed to start", error);
  process.exit(1);
});
