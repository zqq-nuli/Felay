/**
 * Standalone test: connect to Feishu WSClient, receive messages and log raw content.
 * Usage: cd packages/daemon && npx tsx ../../scripts/test-receive-msg.ts
 */

process.env.NO_PROXY = "open.feishu.cn,*.feishu.cn,*.larksuite.com";

import * as Lark from "@larksuiteoapi/node-sdk";

const APP_ID = "cli_a910699735b89bdf";
const APP_SECRET = ""; // ← 填入你的 appSecret

const client = new Lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: Lark.Domain.Feishu,
  appType: Lark.AppType.SelfBuild,
});

const wsClient = new Lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  domain: Lark.Domain.Feishu,
  loggerLevel: Lark.LoggerLevel.INFO,
});

console.log("[test] Starting WSClient, waiting for messages...");
console.log("[test] Send any message (text, rich text, code block, bold etc.) from Feishu\n");

wsClient.start({
  eventDispatcher: new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: any) => {
      const msg = data.message;
      console.log("========== MESSAGE RECEIVED ==========");
      console.log("message_type:", msg?.message_type);
      console.log("content (raw):", msg?.content);
      try {
        const parsed = JSON.parse(msg?.content || "{}");
        console.log("content (parsed):", JSON.stringify(parsed, null, 2));
      } catch {
        console.log("content (parse failed)");
      }
      console.log("=======================================\n");
    },
  }),
});
