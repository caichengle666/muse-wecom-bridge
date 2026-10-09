#!/usr/bin/env node
// 验收测试：主动推送一张按钮交互卡片
// 用户点按钮 -> template_card_event -> daemon 5 秒内 updateTemplateCard 更新卡片
// 注意：同一 BotID 只允许一个长连接，运行此脚本会把 daemon 踢下线，跑完需重启 daemon
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WSClient } from "@wecom/aibot-node-sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const [toUserId] = process.argv.slice(2);
if (!toUserId) {
  console.error("用法: node send-card-demo.mjs <userid>");
  process.exit(1);
}

const env = parseEnvFile(await readFile(join(ROOT, "secrets.env"), "utf8"));
const client = new WSClient({
  botId: env.WECOM_BOT_ID,
  secret: env.WECOM_BOT_SECRET,
  maxReconnectAttempts: 0,
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: (m, ...a) => console.error("[sdk]", m) },
});

const timeout = setTimeout(() => { console.error("超时：30 秒内未完成"); process.exit(2); }, 30000);
const taskId = `demo-${Date.now()}`;

client.on("authenticated", async () => {
  try {
    const frame = await client.sendMessage(toUserId, {
      msgtype: "template_card",
      template_card: {
        card_type: "button_interaction",
        task_id: taskId,
        source: { desc: "Muse 助手 · 功能验收" },
        main_title: {
          title: "🧪 新功能验收测试",
          desc: "这是一张交互式卡片，点下面的按钮试试",
        },
        emphasis_content: { title: "待验收", desc: "6 项新功能" },
        horizontal_content_list: [
          { keyname: "模板卡片", value: "就是这张" },
          { keyname: "按钮回调", value: "点按钮看卡片变化" },
          { keyname: "卡片更新", value: "5 秒内实时刷新" },
        ],
        button_list: [
          { text: "确认执行", style: 1, key: "demo_confirm" },
          { text: "取消", style: 3, key: "demo_cancel" },
        ],
      },
    });
    console.log("卡片推送结果:", JSON.stringify({ errcode: frame.errcode, errmsg: frame.errmsg }).slice(0, 200));
    if (frame.errcode !== 0) process.exitCode = 1;
  } catch (e) {
    console.error("失败:", e?.message || e);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    client.disconnect();
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  }
});
client.on("error", (e) => console.error("[error]", e?.message || e));

client.connect();
