/**
 * Test sending msg_type: "post" via webhook (basic tags only).
 * Webhook supports: text, a, at, img
 * Usage: node scripts/test-feishu-md.js
 */

process.env.NO_PROXY = "open.feishu.cn,*.feishu.cn,*.larksuite.com";

const WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/d457e2d2-aa14-41b7-bd20-70989f1edb9e";

const postContent = {
  msg_type: "post",
  content: {
    post: {
      zh_cn: {
        title: "富文本测试",
        content: [
          [
            { tag: "text", text: "普通文字，后面是链接: " },
            { tag: "a", text: "飞书官网", href: "https://www.feishu.cn" },
          ],
          [
            { tag: "text", text: "第二段落，换行测试" },
          ],
          [
            { tag: "text", text: "代码内容:\nfunction hello() {\n  console.log('world');\n}" },
          ],
        ],
      },
    },
  },
};

async function main() {
  console.log("Sending post (rich text) message via webhook...\n");

  const resp = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(postContent),
  });

  const result = await resp.json();
  console.log("Result:", JSON.stringify(result, null, 2));
}

main().catch(console.error);
