/**
 * 独立测试飞书 WSClient 长连接
 * 用法: pnpm test:ws <appId> <appSecret>
 */

// 绕过系统代理（Clash/V2Ray 等），飞书是国内服务不需要代理
process.env.NO_PROXY = "open.feishu.cn,*.feishu.cn,*.larksuite.com";

import * as Lark from "@larksuiteoapi/node-sdk";

const appId = process.argv[2];
const appSecret = process.argv[3];

if (!appId || !appSecret) {
  console.error("用法: pnpm test:ws <appId> <appSecret>");
  process.exit(1);
}

async function main() {
  console.log(`[test] appId=${appId}`);
  console.log(`[test] appSecret=${appSecret.slice(0, 4)}****`);

  // Step 1: 先测试凭证是否有效
  console.log("\n[test] Step 1: 验证 app 凭证...");
  const client = new Lark.Client({
    appId,
    appSecret,
    domain: Lark.Domain.Feishu,
    appType: Lark.AppType.SelfBuild,
  });

  try {
    const tokenResp = await client.auth.appAccessToken.internal({
      data: { app_id: appId, app_secret: appSecret },
    });
    if (tokenResp?.code === 0) {
      console.log("[test] OK 凭证有效, app_access_token 获取成功");
    } else {
      console.error("[test] FAIL 凭证验证失败:", tokenResp);
      process.exit(1);
    }
  } catch (err) {
    console.error("[test] FAIL 凭证验证异常:", err);
    process.exit(1);
  }

  // Step 2: 测试 WSClient 长连接
  console.log("\n[test] Step 2: 启动 WSClient 长连接...");

  const eventDispatcher = new Lark.EventDispatcher({});

  const testMarkdown = `测试IM API文字消息markdown渲染:

1. **加粗文字**
2. *斜体文字*
3. 单反引号 \`inline code\` 测试
4. 三反引号代码块:
\`\`\`
function hello() {
  console.log("world");
}
\`\`\`
5. 链接: [飞书](https://www.feishu.cn)
6. 列表:
- 项目A
- 项目B
7. ~~删除线~~`;

  eventDispatcher.register({
    "im.message.receive_v1": async (data: any) => {
      const msg = data.message;
      const chatId = msg?.chat_id;
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

      // Auto-reply with rich text (post) via IM API
      if (chatId) {
        console.log("[test] Sending post (rich text) reply via IM API...");
        const postContent = {
          zh_cn: {
            title: "",
            content: [
              [
                { tag: "text", text: "普通文字，" },
                { tag: "text", text: "加粗文字", style: ["bold"] },
                { tag: "text", text: "，" },
                { tag: "text", text: "斜体文字", style: ["italic"] },
              ],
              [
                { tag: "text", text: "行内代码: " },
                { tag: "text", text: "console.log()", style: ["code"] },
                { tag: "text", text: " 结束" },
              ],
              [
                { tag: "text", text: "链接: " },
                { tag: "a", text: "飞书官网", href: "https://www.feishu.cn" },
              ],
              [
                { tag: "text", text: "下面是代码块:" },
              ],
              [
                {
                  tag: "code_block",
                  language: "javascript",
                  text: "function hello() {\n  console.log(\"world\");\n}",
                },
              ],
              [
                { tag: "text", text: "代码块结束。" },
              ],
            ],
          },
        };
        try {
          await client.im.v1.message.create({
            params: { receive_id_type: "chat_id" },
            data: {
              receive_id: chatId,
              msg_type: "post",
              content: JSON.stringify(postContent),
            },
          });
          console.log("[test] Post reply sent!\n");
        } catch (err) {
          console.error("[test] Post reply failed:", err);
        }
      }
    },
  });

  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    domain: Lark.Domain.Feishu,
    appType: Lark.AppType.SelfBuild,
    loggerLevel: Lark.LoggerLevel.debug,
    autoReconnect: true,
  });

  console.log("[test] 正在调用 wsClient.start()...");

  try {
    await wsClient.start({ eventDispatcher });
    console.log("[test] OK wsClient.start() 返回成功");
    console.log("[test] 长连接已建立，等待消息中...");
    console.log("[test] (在飞书中给机器人发消息来测试，按 Ctrl+C 退出)\n");
  } catch (err) {
    console.error("[test] FAIL wsClient.start() 失败:", err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(1);
});

// 保持进程运行
process.on("SIGINT", () => {
  console.log("\n[test] 退出");
  process.exit(0);
});
