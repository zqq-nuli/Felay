import net from "node:net";
import crypto from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  toJsonLine,
  type FeishuInputEvent,
  type InteractiveBotConfig,
  type PushBotConfig,
} from "@feishu-cli/shared";
import type { SessionRegistry } from "./sessionRegistry.js";
import type { ConfigManager } from "./configManager.js";
import type { OutputBuffer } from "./outputBuffer.js";
import { stripAnsi, filterNoiseLines } from "./sanitizer.js";

/* ── Types ── */

interface BotConnection {
  client: Lark.Client;
  wsClient: Lark.WSClient;
  healthy: boolean;
  lastEventAt: number;
  healthCheckTimer?: ReturnType<typeof setInterval>;
  unhealthySince?: number;
}

interface PendingReply {
  messageId: string;
  chatId: string;
}

/* ── Card builder ── */

function buildCard(title: string, content: string): string {
  // Truncate content for card body (Feishu card limit ~30KB)
  const body = content.length > 28000 ? "...(truncated)\n" + content.slice(-27000) : content;

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: title },
      template: "blue",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: "```\n" + body + "\n```",
        },
      },
    ],
  };
  return JSON.stringify(card);
}

/* ── FeishuManager ── */

export class FeishuManager {
  private readonly registry: SessionRegistry;
  private readonly configManager: ConfigManager;
  private readonly socketMap: Map<string, net.Socket>;
  private readonly outputBuffer: OutputBuffer;

  /** botId → active WSClient connection */
  private readonly connections = new Map<string, BotConnection>();
  /** sessionId → pending reply info (waiting for output to flush) */
  private readonly pendingReplies = new Map<string, PendingReply>();
  /** sessionId → chatId (persisted from first Feishu message for task summary) */
  private readonly sessionChatIds = new Map<string, string>();

  constructor(
    registry: SessionRegistry,
    configManager: ConfigManager,
    socketMap: Map<string, net.Socket>,
    outputBuffer: OutputBuffer
  ) {
    this.registry = registry;
    this.configManager = configManager;
    this.socketMap = socketMap;
    this.outputBuffer = outputBuffer;
  }

  /* ── WSClient connection pool ── */

  /** Start (or reuse) a WSClient for the given interactive bot. */
  async startInteractiveBot(botId: string): Promise<void> {
    if (this.connections.has(botId)) {
      console.log(`[feishu] bot ${botId} already connected`);
      return;
    }

    const bots = this.configManager.getBots();
    const botConfig = bots.interactive.find((b) => b.id === botId);
    if (!botConfig) {
      console.error(`[feishu] interactive bot ${botId} not found in config`);
      return;
    }

    try {
      const client = new Lark.Client({
        appId: botConfig.appId,
        appSecret: botConfig.appSecret,
      });

      const eventDispatcher = new Lark.EventDispatcher({
        encryptKey: botConfig.encryptKey || "",
      });

      eventDispatcher.register({
        "im.message.receive_v1": async (data) => {
          await this.handleFeishuMessage(botId, botConfig, client, data);
        },
      });

      const wsClient = new Lark.WSClient({
        appId: botConfig.appId,
        appSecret: botConfig.appSecret,
        loggerLevel: Lark.LoggerLevel.warn,
        autoReconnect: true,
      });

      await wsClient.start({ eventDispatcher });

      const connection: BotConnection = {
        client,
        wsClient,
        healthy: true,
        lastEventAt: Date.now(),
      };

      // Health check: detect if WSClient has gone silent (likely disconnected)
      const reconnectSettings = this.configManager.getSettings().reconnect;
      const maxUnhealthyMs =
        reconnectSettings.maxRetries *
        reconnectSettings.initialInterval *
        1000 *
        Math.pow(
          reconnectSettings.backoffMultiplier,
          reconnectSettings.maxRetries - 1
        );

      connection.healthCheckTimer = setInterval(() => {
        const silenceMs = Date.now() - connection.lastEventAt;
        // WSClient should have periodic activity; 90s silence suggests disconnection
        if (silenceMs > 90_000) {
          if (connection.healthy) {
            connection.healthy = false;
            connection.unhealthySince = Date.now();
            console.log(`[feishu] bot ${botId} appears disconnected`);
          } else if (
            connection.unhealthySince &&
            Date.now() - connection.unhealthySince > maxUnhealthyMs
          ) {
            console.error(`[feishu] bot ${botId} reconnection likely exhausted`);
          }
        } else {
          if (!connection.healthy) {
            console.log(`[feishu] bot ${botId} reconnected`);
          }
          connection.healthy = true;
          connection.unhealthySince = undefined;
        }
      }, 30_000);

      this.connections.set(botId, connection);
      console.log(`[feishu] bot ${botId} (${botConfig.name}) WSClient connected`);
    } catch (err) {
      console.error(`[feishu] failed to start bot ${botId}:`, err);
    }
  }

  /** Stop a WSClient connection. */
  stopInteractiveBot(botId: string): void {
    const conn = this.connections.get(botId);
    if (!conn) return;

    if (conn.healthCheckTimer) clearInterval(conn.healthCheckTimer);
    // The SDK doesn't expose a clean close() on WSClient; delete reference
    this.connections.delete(botId);
    console.log(`[feishu] bot ${botId} WSClient stopped`);
  }

  /** Check if a bot is connected and healthy. */
  isBotConnected(botId: string): boolean {
    const conn = this.connections.get(botId);
    return conn ? conn.healthy : false;
  }

  /** Get warnings for unhealthy bot connections. */
  getBotWarnings(): Array<{ botId: string; message: string }> {
    const warnings: Array<{ botId: string; message: string }> = [];
    for (const [botId, conn] of this.connections) {
      if (!conn.healthy && conn.unhealthySince) {
        const elapsed = Math.round((Date.now() - conn.unhealthySince) / 1000);
        warnings.push({
          botId,
          message: `连接断开已 ${elapsed} 秒，正在重试...`,
        });
      }
    }
    return warnings;
  }

  /* ── Receive Feishu message ── */

  private async handleFeishuMessage(
    botId: string,
    _botConfig: InteractiveBotConfig,
    client: Lark.Client,
    data: any
  ): Promise<void> {
    // Update health tracking
    const conn = this.connections.get(botId);
    if (conn) conn.lastEventAt = Date.now();

    try {
      const event = data as {
        sender?: { sender_id?: { open_id?: string } };
        message?: {
          message_id?: string;
          chat_id?: string;
          message_type?: string;
          content?: string;
        };
      };

      const messageId = event.message?.message_id;
      const chatId = event.message?.chat_id;
      const messageType = event.message?.message_type;
      const rawContent = event.message?.content;

      if (!messageId || !chatId || !rawContent) {
        console.log("[feishu] ignoring event with missing fields");
        return;
      }

      // Only handle text messages
      if (messageType !== "text") {
        console.log(`[feishu] ignoring non-text message type: ${messageType}`);
        return;
      }

      // Parse text content
      let text: string;
      try {
        const parsed = JSON.parse(rawContent);
        text = parsed.text ?? "";
      } catch {
        text = rawContent;
      }

      if (!text.trim()) return;

      // Add EYES reaction
      try {
        await client.im.v1.messageReaction.create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: "EYES" } },
        });
      } catch (err) {
        console.log("[feishu] failed to add reaction:", err);
      }

      // Find session bound to this bot
      const session = this.registry
        .list()
        .find((s) => s.interactiveBotId === botId && s.status !== "ended");

      if (!session) {
        console.log(`[feishu] no active session bound to bot ${botId}`);
        // Send a reply indicating no session
        try {
          await client.im.v1.message.create({
            params: { receive_id_type: "chat_id" },
            data: {
              receive_id: chatId,
              msg_type: "interactive",
              content: buildCard("No Session", "No active session is bound to this bot."),
            },
          });
        } catch {
          // ignore
        }
        return;
      }

      // Send feishu_input to CLI via socket
      const socket = this.socketMap.get(session.sessionId);
      if (!socket || socket.destroyed) {
        console.log(`[feishu] no socket for session ${session.sessionId}`);
        return;
      }

      const feishuInput: FeishuInputEvent = {
        type: "feishu_input",
        payload: {
          sessionId: session.sessionId,
          text: text + "\n",
          at: new Date().toISOString(),
        },
      };
      socket.write(toJsonLine(feishuInput));

      // Start collecting output for the reply (only if not already collecting —
      // avoids overwriting a pending reply and losing the first message's response)
      if (!this.pendingReplies.has(session.sessionId)) {
        this.outputBuffer.startCollecting(session.sessionId);
        this.pendingReplies.set(session.sessionId, { messageId, chatId });
      }

      // Persist chatId for task summary on session end
      if (!this.sessionChatIds.has(session.sessionId)) {
        this.sessionChatIds.set(session.sessionId, chatId);
      }

      console.log(
        `[feishu] forwarded message to session ${session.sessionId}: ${text.slice(0, 50)}...`
      );
    } catch (err) {
      console.error("[feishu] error handling message:", err);
    }
  }

  /* ── Send interactive reply (called by OutputBuffer callback) ── */

  async sendInteractiveReply(sessionId: string, rawOutput: string): Promise<void> {
    const pending = this.pendingReplies.get(sessionId);
    if (!pending) return;

    const session = this.registry.get(sessionId);
    const botId = session?.interactiveBotId;
    if (!botId) return;

    const conn = this.connections.get(botId);
    if (!conn) return;

    // Clean output
    const cleaned = filterNoiseLines(stripAnsi(rawOutput));
    if (!cleaned.trim()) return;

    const title = `Reply [${sessionId}] ${session?.cli ?? ""}`;

    try {
      await conn.client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: pending.chatId,
          msg_type: "interactive",
          content: buildCard(title, cleaned),
        },
      });
    } catch (err) {
      console.error(`[feishu] failed to send reply for session ${sessionId}:`, err);
    }

    // Remove EYES reaction
    try {
      // List reactions to find the one we added
      const reactions = await conn.client.im.v1.messageReaction.list({
        path: { message_id: pending.messageId },
        params: { reaction_type: "EYES" },
      });
      const myReaction = reactions?.data?.items?.[0];
      if (myReaction?.reaction_id) {
        await conn.client.im.v1.messageReaction.delete({
          path: {
            message_id: pending.messageId,
            reaction_id: myReaction.reaction_id,
          },
        });
      }
    } catch {
      // Reaction cleanup is best-effort
    }

    this.pendingReplies.delete(sessionId);
  }

  /* ── Webhook push (called by OutputBuffer callback) ── */

  async sendPushMessage(sessionId: string, rawOutput: string): Promise<void> {
    const session = this.registry.get(sessionId);
    if (!session?.pushBotId || !session.pushEnabled) return;

    const bots = this.configManager.getBots();
    const botConfig = bots.push.find((b) => b.id === session.pushBotId);
    if (!botConfig) return;

    const cleaned = filterNoiseLines(stripAnsi(rawOutput));
    if (!cleaned.trim()) return;

    if (!FeishuManager.isAllowedWebhookUrl(botConfig.webhook)) {
      console.error(`[feishu] blocked push to untrusted webhook URL: ${botConfig.webhook}`);
      return;
    }

    const title = `Push [${sessionId}] ${session.cli}`;
    const cardContent = buildCard(title, cleaned);

    try {
      const body: Record<string, unknown> = {
        msg_type: "interactive",
        card: JSON.parse(cardContent),
      };

      // Sign if secret is configured
      if (botConfig.secret) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const sign = this.genWebhookSign(timestamp, botConfig.secret);
        body.timestamp = timestamp;
        body.sign = sign;
      }

      const resp = await fetch(botConfig.webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const result = (await resp.json()) as { code?: number; msg?: string };

      if (result.code === 0) {
        // Success
      } else if (result.code === 11232) {
        // Rate limited — increase merge window
        console.log(`[feishu] push rate limited for session ${sessionId}, increasing merge window`);
        this.outputBuffer.increaseMergeWindow(sessionId);
      } else {
        console.error(`[feishu] push failed for session ${sessionId}:`, result);
      }
    } catch (err) {
      console.error(`[feishu] push error for session ${sessionId}:`, err);
    }
  }

  /** Validate that a webhook URL belongs to a trusted Feishu/Lark domain. */
  private static isAllowedWebhookUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      return (
        host.endsWith(".feishu.cn") ||
        host.endsWith(".larksuite.com") ||
        host === "open.feishu.cn" ||
        host === "open.larksuite.com"
      );
    } catch {
      return false;
    }
  }

  /** Generate HMAC-SHA256 signature for webhook. */
  private genWebhookSign(timestamp: string, secret: string): string {
    const payload = timestamp + "\n" + secret;
    return crypto.createHmac("sha256", payload).update("").digest("base64");
  }

  /* ── Test bot connections ── */

  async testInteractiveBot(
    botId: string
  ): Promise<{ ok: boolean; error?: string; botName?: string }> {
    const bots = this.configManager.getBots();
    const botConfig = bots.interactive.find((b) => b.id === botId);
    if (!botConfig) return { ok: false, error: "bot not found in config" };

    try {
      const client = new Lark.Client({
        appId: botConfig.appId,
        appSecret: botConfig.appSecret,
      });

      // Use a lightweight API to verify credentials: get app_access_token
      const resp = await client.auth.appAccessToken.internal({
        data: { app_id: botConfig.appId, app_secret: botConfig.appSecret },
      });
      if (resp?.code === 0) {
        return { ok: true, botName: botConfig.name };
      }
      return { ok: false, error: resp?.msg ?? "failed to obtain access token" };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      return { ok: false, error: msg };
    }
  }

  async testPushBot(botId: string): Promise<{ ok: boolean; error?: string }> {
    const bots = this.configManager.getBots();
    const botConfig = bots.push.find((b) => b.id === botId);
    if (!botConfig) return { ok: false, error: "bot not found in config" };

    if (!FeishuManager.isAllowedWebhookUrl(botConfig.webhook)) {
      return { ok: false, error: "webhook URL must be a feishu.cn or larksuite.com domain" };
    }

    try {
      const body: Record<string, unknown> = {
        msg_type: "text",
        content: { text: "[Feishu CLI Proxy] 测试消息" },
      };

      if (botConfig.secret) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const sign = this.genWebhookSign(timestamp, botConfig.secret);
        body.timestamp = timestamp;
        body.sign = sign;
      }

      const resp = await fetch(botConfig.webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const result = (await resp.json()) as { code?: number; msg?: string };
      if (result.code === 0) {
        return { ok: true };
      }
      return { ok: false, error: result.msg ?? `code ${result.code}` };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  /* ── Session lifecycle ── */

  async onSessionEnded(sessionId: string): Promise<void> {
    // Force flush any remaining interactive output
    const remaining = this.outputBuffer.forceFlushInteractive(sessionId);

    const session = this.registry.get(sessionId);
    if (!session) {
      this.outputBuffer.cleanup(sessionId);
      return;
    }

    // Send final reply if there's pending output
    if (remaining) {
      await this.sendInteractiveReply(sessionId, remaining);
    }

    const botId = session.interactiveBotId;
    if (botId) {
      const conn = this.connections.get(botId);
      // Use persistent chatId (set on first Feishu message), fallback to pendingReplies
      const pending = this.pendingReplies.get(sessionId);
      const chatId = this.sessionChatIds.get(sessionId) ?? pending?.chatId;

      if (conn && chatId) {
        // Get task summary from the rolling output buffer
        const rawSummary = this.outputBuffer.getSummary(sessionId);
        const summaryText = rawSummary
          ? filterNoiseLines(stripAnsi(rawSummary)).trim()
          : "";

        const cardBody = summaryText
          ? summaryText
          : `Session ${sessionId} (${session.cli}) has ended.`;

        try {
          await conn.client.im.v1.message.create({
            params: { receive_id_type: "chat_id" },
            data: {
              receive_id: chatId,
              msg_type: "interactive",
              content: buildCard(`Task Summary [${sessionId}]`, cardBody),
            },
          });
        } catch (err) {
          console.error(`[feishu] failed to send task summary:`, err);
        }
      }

      // Clean up EYES reaction from last pending message
      if (pending?.messageId && conn) {
        try {
          const reactions = await conn.client.im.v1.messageReaction.list({
            path: { message_id: pending.messageId },
            params: { reaction_type: "EYES" },
          });
          const myReaction = reactions?.data?.items?.[0];
          if (myReaction?.reaction_id) {
            await conn.client.im.v1.messageReaction.delete({
              path: {
                message_id: pending.messageId,
                reaction_id: myReaction.reaction_id,
              },
            });
          }
        } catch {
          // best-effort
        }
      }
    }

    this.pendingReplies.delete(sessionId);
    this.sessionChatIds.delete(sessionId);
    this.outputBuffer.cleanup(sessionId);
  }

  /* ── Shutdown ── */

  shutdown(): void {
    for (const botId of [...this.connections.keys()]) {
      this.stopInteractiveBot(botId);
    }
    this.pendingReplies.clear();
    this.sessionChatIds.clear();
  }
}
