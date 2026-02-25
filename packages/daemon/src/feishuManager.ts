import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  toJsonLine,
  type FeishuInputEvent,
  type InteractiveBotConfig,
  type PushBotConfig,
} from "@felay/shared";
import type { SessionRegistry } from "./sessionRegistry.js";
import type { ConfigManager } from "./configManager.js";
import type { OutputBuffer } from "./outputBuffer.js";
import { stripAnsi, filterNoiseLines, renderTerminalOutput, extractResponseText } from "./sanitizer.js";
import { markdownToPost, markdownToPostBasic } from "./markdownToPost.js";

/** Check if a CLI command is Codex (supports notify hook for clean replies). */
function isCodexCli(cli: string): boolean {
  const base = cli.replace(/\\/g, "/").split("/").pop() || "";
  const name = base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  return name === "codex";
}

/* ── Types ── */

interface BotConnection {
  client: Lark.Client;
  wsClient: Lark.WSClient;
  healthy: boolean;
  lastEventAt: number;
  connectedAt: number;
  healthCheckTimer?: ReturnType<typeof setInterval>;
  unhealthySince?: number;
}

interface PendingReply {
  messageId: string;
  chatId: string;
}

/* ── Card builders ── */

/** Card with content inside a code block (for session-ended, structured info). */
function buildCard(title: string, content: string, template: string = "blue"): string {
  const body = content.length > 28000 ? "...(truncated)\n" + content.slice(-27000) : content;

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: title },
      template,
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

/** Card with lark_md content rendered as markdown (for AI responses, push messages). */
function buildMarkdownCard(title: string, content: string, template: string = "blue"): string {
  const body = content.length > 28000 ? "...(truncated)\n" + content.slice(-27000) : content;

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: title },
      template,
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: body,
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
      console.log(`[felay] bot ${botId} already connected`);
      return;
    }

    const bots = this.configManager.getBots();
    const botConfig = bots.interactive.find((b) => b.id === botId);
    if (!botConfig) {
      console.error(`[felay] interactive bot ${botId} not found in config`);
      return;
    }

    try {
      const client = new Lark.Client({
        appId: botConfig.appId,
        appSecret: botConfig.appSecret,
        domain: Lark.Domain.Feishu,
        appType: Lark.AppType.SelfBuild,
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
        domain: Lark.Domain.Feishu,
        // @ts-expect-error — appType exists at runtime but is missing from @larksuiteoapi/node-sdk type declarations
        appType: Lark.AppType.SelfBuild,
        loggerLevel: Lark.LoggerLevel.info,
        autoReconnect: true,
      });

      await wsClient.start({ eventDispatcher });

      const connectedAt = Date.now();
      const connection: BotConnection = {
        client,
        wsClient,
        healthy: true,
        lastEventAt: connectedAt,
        connectedAt,
      };

      // Health check: try sending a lightweight API request to verify the bot
      // credentials and connectivity are still valid.  We no longer rely on
      // message-silence heuristics (90 s) because idle periods without user
      // messages are perfectly normal and caused false "disconnected" warnings.
      //
      // The WSClient has `autoReconnect: true`, so the SDK handles WebSocket
      // reconnection internally.  Our health-check only verifies that the
      // Feishu API is reachable and the bot's access token is still valid.
      connection.healthCheckTimer = setInterval(async () => {
        try {
          // A lightweight API call — get bot info (tiny payload).
          const resp = await client.request({
            method: "GET",
            url: "https://open.feishu.cn/open-apis/bot/v3/info",
          });
          const body = resp as { code?: number };
          if (body.code === 0) {
            if (!connection.healthy) {
              console.log(`[felay] bot ${botId} reconnected`);
            }
            connection.healthy = true;
            connection.unhealthySince = undefined;
          } else {
            if (connection.healthy) {
              connection.healthy = false;
              connection.unhealthySince = Date.now();
              console.log(`[felay] bot ${botId} health-check failed: code=${body.code}`);
            }
          }
        } catch {
          if (connection.healthy) {
            connection.healthy = false;
            connection.unhealthySince = Date.now();
            console.log(`[felay] bot ${botId} health-check error, marking unhealthy`);
          }
        }
      }, 120_000); // Check every 2 minutes (instead of every 30s)

      this.connections.set(botId, connection);
      console.log(`[felay] bot ${botId} (${botConfig.name}) WSClient connected`);
    } catch (err) {
      console.error(`[felay] failed to start bot ${botId}:`, err);
    }
  }

  /** Stop a WSClient connection. */
  stopInteractiveBot(botId: string): void {
    const conn = this.connections.get(botId);
    if (!conn) return;

    if (conn.healthCheckTimer) clearInterval(conn.healthCheckTimer);
    // The SDK doesn't expose a clean close() on WSClient; delete reference
    this.connections.delete(botId);
    console.log(`[felay] bot ${botId} WSClient stopped`);
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
          create_time?: string;
        };
      };

      const messageId = event.message?.message_id;
      const chatId = event.message?.chat_id;
      const messageType = event.message?.message_type;
      const rawContent = event.message?.content;
      const createTime = event.message?.create_time;

      if (!messageId || !chatId || !rawContent) {
        console.log("[felay] ignoring event with missing fields");
        return;
      }

      // Ignore messages sent before the bot connected (historical/queued messages)
      if (conn && createTime) {
        const msgTimestamp = parseInt(createTime, 10);
        if (msgTimestamp > 0 && msgTimestamp < conn.connectedAt) {
          console.log(`[felay] ignoring historical message (sent before bot connected)`);
          return;
        }
      }

      // Find session bound to this bot (shared by both image and text branches)
      const session = this.registry
        .list()
        .find((s) => s.interactiveBotId === botId && s.status !== "ended");

      // ── Image message branch ──
      if (messageType === "image") {
        if (!session) {
          console.log(`[felay] no active session bound to bot ${botId}, ignoring image`);
          return;
        }

        // Parse image_key from content
        let imageKey: string;
        try {
          const parsed = JSON.parse(rawContent);
          imageKey = parsed.image_key;
        } catch {
          console.log("[felay] failed to parse image content");
          return;
        }
        if (!imageKey) {
          console.log("[felay] image message missing image_key");
          return;
        }

        // Download image to ~/.felay/images/<sessionId>/
        try {
          const imagesDir = path.join(os.homedir(), ".felay", "images", session.sessionId);
          await fs.promises.mkdir(imagesDir, { recursive: true });

          const fileName = `${Date.now()}_${imageKey.slice(0, 8)}.png`;
          const filePath = path.join(imagesDir, fileName);

          // Use messageResource API to download images from user messages
          // (im.v1.image.get only works for bot-uploaded images)
          const resp = await client.im.v1.messageResource.get({
            path: { message_id: messageId, file_key: imageKey },
            params: { type: "image" },
          });

          // Write the response stream/buffer to file
          if (resp && typeof (resp as any).writeFile === "function") {
            await (resp as any).writeFile(filePath);
          } else {
            // Fallback: resp itself may be a readable stream
            const stream = typeof (resp as any).getReadableStream === "function"
              ? (resp as any).getReadableStream()
              : resp;
            await new Promise<void>((resolve, reject) => {
              const ws = fs.createWriteStream(filePath);
              (stream as NodeJS.ReadableStream).pipe(ws);
              ws.on("finish", resolve);
              ws.on("error", reject);
            });
          }

          console.log(`[felay] downloaded image for session ${session.sessionId}: ${fileName}`);

          // Send image path to CLI immediately (paste into input box)
          const socket = this.socketMap.get(session.sessionId);
          if (socket && !socket.destroyed) {
            const feishuInput: FeishuInputEvent = {
              type: "feishu_input",
              payload: {
                sessionId: session.sessionId,
                text: "",
                at: new Date().toISOString(),
                images: [filePath],
              },
            };
            socket.write(toJsonLine(feishuInput));
          }
        } catch (err) {
          console.error(`[felay] failed to download image:`, err);
          return;
        }

        // Add THUMBSUP reaction to acknowledge
        try {
          await client.im.v1.messageReaction.create({
            path: { message_id: messageId },
            data: { reaction_type: { emoji_type: "THUMBSUP" } },
          });
        } catch {
          // best-effort
        }

        return;
      }

      // ── Post (rich text) message branch: image + text combo ──
      if (messageType === "post") {
        if (!session) {
          console.log(`[felay] no active session bound to bot ${botId}, ignoring post`);
          return;
        }

        // Parse post content: {"zh_cn":{"title":"...","content":[[{"tag":"text","text":"..."},{"tag":"img","image_key":"..."}]]}}
        const postTexts: string[] = [];
        const imageKeys: string[] = [];
        try {
          const parsed = JSON.parse(rawContent);
          // Post content can be either:
          // 1. Direct: {title, content: [[...]]}  (from im.message.receive_v1)
          // 2. Wrapped in locale: {zh_cn: {title, content: [[...]]}}
          let content: any;
          if (Array.isArray(parsed.content)) {
            content = parsed.content;
          } else {
            const localeContent = Object.values(parsed)[0] as any;
            content = localeContent?.content;
          }
          if (Array.isArray(content)) {
            for (const paragraph of content) {
              if (Array.isArray(paragraph)) {
                for (const element of paragraph) {
                  if (element.tag === "text" && element.text) {
                    postTexts.push(element.text);
                  } else if (element.tag === "img" && element.image_key) {
                    imageKeys.push(element.image_key);
                  }
                }
              }
            }
          }
        } catch {
          console.log("[felay] failed to parse post content");
          return;
        }

        const postText = postTexts.join("").trim();
        if (!postText && imageKeys.length === 0) return;

        const socket = this.socketMap.get(session.sessionId);
        if (!socket || socket.destroyed) {
          console.log(`[felay] no socket for session ${session.sessionId}`);
          return;
        }

        // Download and send images first (CLI receives image paths before text)
        if (imageKeys.length > 0) {
          const imagesDir = path.join(os.homedir(), ".felay", "images", session.sessionId);
          await fs.promises.mkdir(imagesDir, { recursive: true });

          for (const imageKey of imageKeys) {
            try {
              const fileName = `${Date.now()}_${imageKey.slice(0, 8)}.png`;
              const filePath = path.join(imagesDir, fileName);

              const resp = await client.im.v1.messageResource.get({
                path: { message_id: messageId, file_key: imageKey },
                params: { type: "image" },
              });

              if (resp && typeof (resp as any).writeFile === "function") {
                await (resp as any).writeFile(filePath);
              } else {
                const stream = typeof (resp as any).getReadableStream === "function"
                  ? (resp as any).getReadableStream()
                  : resp;
                await new Promise<void>((resolve, reject) => {
                  const ws = fs.createWriteStream(filePath);
                  (stream as NodeJS.ReadableStream).pipe(ws);
                  ws.on("finish", resolve);
                  ws.on("error", reject);
                });
              }

              console.log(`[felay] downloaded post image for session ${session.sessionId}: ${fileName}`);

              // Send image path to CLI
              const imgInput: FeishuInputEvent = {
                type: "feishu_input",
                payload: {
                  sessionId: session.sessionId,
                  text: "",
                  at: new Date().toISOString(),
                  images: [filePath],
                },
              };
              socket.write(toJsonLine(imgInput));
            } catch (err) {
              console.error(`[felay] failed to download post image:`, err);
            }
          }
        }

        // Then send text (after images, so CLI processes images first)
        if (postText) {
          // Add THUMBSUP reaction
          try {
            await client.im.v1.messageReaction.create({
              path: { message_id: messageId },
              data: { reaction_type: { emoji_type: "THUMBSUP" } },
            });
          } catch {
            // best-effort
          }

          const inputSettings = this.configManager.getSettings().input;
          const feishuInput: FeishuInputEvent = {
            type: "feishu_input",
            payload: {
              sessionId: session.sessionId,
              text: postText + "\r",
              at: new Date().toISOString(),
              enterRetryCount: inputSettings?.enterRetryCount ?? 2,
              enterRetryInterval: inputSettings?.enterRetryInterval ?? 500,
            },
          };
          socket.write(toJsonLine(feishuInput));

          if (!this.pendingReplies.has(session.sessionId)) {
            if (!isCodexCli(session.cli) && !session.proxyMode) {
              this.outputBuffer.startCollecting(session.sessionId);
            }
            this.pendingReplies.set(session.sessionId, { messageId, chatId });
          }

          if (!this.sessionChatIds.has(session.sessionId)) {
            this.sessionChatIds.set(session.sessionId, chatId);
          }

          console.log(
            `[felay] forwarded post message to session ${session.sessionId}: ${postText.slice(0, 50)}...`
          );
        }

        return;
      }

      // ── Text message branch ──
      if (messageType !== "text") {
        console.log(`[felay] ignoring non-text message type: ${messageType}`);
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

      // Add THUMBSUP reaction
      try {
        await client.im.v1.messageReaction.create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: "THUMBSUP" } },
        });
      } catch (err) {
        console.log("[felay] failed to add reaction:", err);
      }

      if (!session) {
        console.log(`[felay] no active session bound to bot ${botId}`);
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
        console.log(`[felay] no socket for session ${session.sessionId}`);
        return;
      }

      const inputSettings = this.configManager.getSettings().input;
      const feishuInput: FeishuInputEvent = {
        type: "feishu_input",
        payload: {
          sessionId: session.sessionId,
          text: text + "\r",
          at: new Date().toISOString(),
          enterRetryCount: inputSettings?.enterRetryCount ?? 2,
          enterRetryInterval: inputSettings?.enterRetryInterval ?? 500,
        },
      };
      socket.write(toJsonLine(feishuInput));

      // For Codex/proxy sessions, replies come via hooks or proxy (not PTY output),
      // so we skip OutputBuffer interactive collection entirely.
      // For other CLIs, use the existing PTY output collection + xterm parsing.
      if (!this.pendingReplies.has(session.sessionId)) {
        if (!isCodexCli(session.cli) && !session.proxyMode) {
          this.outputBuffer.startCollecting(session.sessionId);
        }
        this.pendingReplies.set(session.sessionId, { messageId, chatId });
      }

      // Persist chatId for task summary on session end
      if (!this.sessionChatIds.has(session.sessionId)) {
        this.sessionChatIds.set(session.sessionId, chatId);
      }

      console.log(
        `[felay] forwarded message to session ${session.sessionId}: ${text.slice(0, 50)}...`
      );
    } catch (err) {
      console.error("[felay] error handling message:", err);
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

    // Render raw PTY output through virtual terminal to get clean screen content
    const rendered = await renderTerminalOutput(rawOutput);
    // Extract only meaningful content — strip TUI chrome (menus, status bar, etc.)
    const cleaned = extractResponseText(rendered);
    if (!cleaned.trim()) return;

    try {
      await conn.client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: pending.chatId,
          msg_type: "post",
          content: JSON.stringify(markdownToPost(cleaned)),
        },
      });
    } catch (err) {
      console.error(`[felay] failed to send reply for session ${sessionId}:`, err);
    }

    // Remove THUMBSUP reaction
    try {
      // List reactions to find the one we added
      const reactions = await conn.client.im.v1.messageReaction.list({
        path: { message_id: pending.messageId },
        params: { reaction_type: "THUMBSUP" },
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

  /* ── Codex notify hook reply (called when codex_notify arrives) ── */

  async handleCodexNotify(sessionId: string, cleanMessage: string, skipPush: boolean = false): Promise<void> {
    const text = cleanMessage.trim();
    if (!text) return;

    const session = this.registry.get(sessionId);
    const botId = session?.interactiveBotId;
    const conn = botId ? this.connections.get(botId) : undefined;

    // 1. Send interactive reply
    // Use pendingReply chatId first, fall back to sessionChatIds (persisted from first message).
    // This allows proxy mode to send multiple replies per user question.
    const pending = this.pendingReplies.get(sessionId);
    const chatId = pending?.chatId ?? this.sessionChatIds.get(sessionId);

    if (conn && chatId) {
      try {
        await conn.client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "post",
            content: JSON.stringify(markdownToPost(text)),
          },
        });
      } catch (err) {
        console.error(`[felay] failed to send codex notify reply for session ${sessionId}:`, err);
      }

      // Remove THUMBSUP reaction on first reply only
      if (pending) {
        try {
          const reactions = await conn.client.im.v1.messageReaction.list({
            path: { message_id: pending.messageId },
            params: { reaction_type: "THUMBSUP" },
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
    }

    // 2. Push to webhook bot (if bound) — clean text, no PTY parsing needed
    // Skip when called from proxy (proxy sends push per-turn separately)
    if (!skipPush && session?.pushBotId && session.pushEnabled) {
      await this.sendPushCleanMessage(sessionId, text);
    }
  }

  /** Push a pre-cleaned message via webhook (for Codex notify hook / API proxy). */
  async sendPushCleanMessage(sessionId: string, cleanText: string): Promise<void> {
    const session = this.registry.get(sessionId);
    if (!session?.pushBotId || !session.pushEnabled) return;

    const bots = this.configManager.getBots();
    const botConfig = bots.push.find((b) => b.id === session.pushBotId);
    if (!botConfig) return;

    if (!FeishuManager.isAllowedWebhookUrl(botConfig.webhook)) {
      console.error(`[felay] blocked push to untrusted webhook URL: ${botConfig.webhook}`);
      return;
    }

    try {
      const body: Record<string, unknown> = {
        msg_type: "post",
        content: { post: markdownToPostBasic(cleanText) },
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
      if (result.code !== 0) {
        console.error(`[felay] push (codex notify) failed for session ${sessionId}:`, result);
      }
    } catch (err) {
      console.error(`[felay] push (codex notify) error for session ${sessionId}:`, err);
    }
  }

  /* ── Webhook push (called by OutputBuffer callback) ── */

  async sendPushMessage(sessionId: string, rawOutput: string): Promise<void> {
    const session = this.registry.get(sessionId);
    if (!session?.pushBotId || !session.pushEnabled) return;

    const bots = this.configManager.getBots();
    const botConfig = bots.push.find((b) => b.id === session.pushBotId);
    if (!botConfig) return;

    // Render through virtual terminal for clean output (handles cursor movements, redraws, etc.)
    const rendered = await renderTerminalOutput(rawOutput);
    const cleaned = extractResponseText(rendered);
    if (!cleaned.trim()) return;

    // Skip very short output (likely keyboard input echo, not real content)
    if (cleaned.trim().length < 10) return;

    if (!FeishuManager.isAllowedWebhookUrl(botConfig.webhook)) {
      console.error(`[felay] blocked push to untrusted webhook URL: ${botConfig.webhook}`);
      return;
    }

    try {
      const body: Record<string, unknown> = {
        msg_type: "post",
        content: { post: markdownToPostBasic(cleaned) },
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
        console.log(`[felay] push rate limited for session ${sessionId}, increasing merge window`);
        this.outputBuffer.increaseMergeWindow(sessionId);
      } else {
        console.error(`[felay] push failed for session ${sessionId}:`, result);
      }
    } catch (err) {
      console.error(`[felay] push error for session ${sessionId}:`, err);
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
        domain: Lark.Domain.Feishu,
        appType: Lark.AppType.SelfBuild,
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
        content: { text: "[Felay] 测试消息" },
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
        // Send a clean session-ended notification.
        // Raw terminal buffer is unreliable for TUI programs (Codex, vim, etc.)
        // that use cursor movement / screen redraws — stripped output becomes garbled.
        const duration = session.startedAt
          ? Math.round((Date.now() - new Date(session.startedAt).getTime()) / 1000)
          : 0;
        const durationStr = duration >= 60
          ? `${Math.floor(duration / 60)}m ${duration % 60}s`
          : `${duration}s`;

        const cardBody = [
          `CLI: ${session.cli}`,
          `Session: ${sessionId}`,
          `Duration: ${durationStr}`,
        ].join("\n");

        try {
          await conn.client.im.v1.message.create({
            params: { receive_id_type: "chat_id" },
            data: {
              receive_id: chatId,
              msg_type: "interactive",
              content: buildCard("⚠ 终端已退出", cardBody, "orange"),
            },
          });
        } catch (err) {
          console.error(`[felay] failed to send session ended card:`, err);
        }
      }

      // Clean up THUMBSUP reaction from last pending message
      if (pending?.messageId && conn) {
        try {
          const reactions = await conn.client.im.v1.messageReaction.list({
            path: { message_id: pending.messageId },
            params: { reaction_type: "THUMBSUP" },
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

    // Clean up downloaded images for this session
    const sessionImagesDir = path.join(os.homedir(), ".felay", "images", sessionId);
    fs.promises.rm(sessionImagesDir, { recursive: true, force: true }).catch(() => {});
  }

  /* ── Startup cleanup ── */

  /** Remove residual images directory from previous daemon runs. */
  static async cleanupImages(): Promise<void> {
    const imagesDir = path.join(os.homedir(), ".felay", "images");
    try {
      await fs.promises.rm(imagesDir, { recursive: true, force: true });
    } catch {
      // ignore — directory may not exist
    }
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
