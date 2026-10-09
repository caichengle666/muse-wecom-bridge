#!/usr/bin/env node
// 一次性主动推送测试：建连 -> 认证 -> sendMessage -> 断开
// 注意：同一 BotID 只允许一个长连接，运行此脚本会把 daemon 踢下线，跑完需重启 daemon
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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

const [toUserId, ...textParts] = process.argv.slice(2);
if (!toUserId || !textParts.length) {
  console.error("用法: node send-test.mjs <userid> <消息文本>");
  process.exit(1);
}
const text = textParts.join(" ");

const env = parseEnvFile(await readFile(join(ROOT, "secrets.env"), "utf8"));
const client = new WSClient({
  botId: env.WECOM_BOT_ID,
  secret: env.WECOM_BOT_SECRET,
  maxReconnectAttempts: 0,
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: (m, ...a) => console.error("[sdk]", m) },
});

const timeout = setTimeout(() => { console.error("超时：30 秒内未完成"); process.exit(2); }, 30000);

client.on("authenticated", async () => {
  try {
    const frame = await client.sendMessage(toUserId, {
      msgtype: "markdown",
      markdown: { content: text },
    });
    console.log("发送成功:", JSON.stringify({ errcode: frame.errcode, errmsg: frame.errmsg }).slice(0, 200));
  } catch (e) {
    console.error("发送失败:", e?.message || e);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    client.disconnect();
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  }
});
client.on("error", (e) => console.error("[error]", e?.message || e));

client.connect();
