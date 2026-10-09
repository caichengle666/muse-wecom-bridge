#!/usr/bin/env node
// 一次性文件推送测试：建连 -> 上传文件拿 media_id -> 主动推送文件 -> 断开
// 注意：同一 BotID 只允许一个长连接，运行此脚本会把 daemon 踢下线，跑完需重启 daemon
import { readFile } from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.MUSE_WECOM_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 按扩展名识别媒体类型（与 src/files.ts detectMediaType 保持一致）。
 * 视频/图片/语音原生发出，其它当普通文件；写死 "file" 会让视频只能当附件收。
 */
export function detectMediaType(filename) {
  const ext = String(filename).toLowerCase().split(".").pop() || "";
  if (["mp4", "mov", "avi", "mkv", "wmv", "m4v"].includes(ext)) return "video";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) return "image";
  if (["mp3", "wav", "amr", "m4a", "ogg", "aac"].includes(ext)) return "voice";
  return "file";
}

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

async function main() {
  const [toUserId, filePath] = process.argv.slice(2);
  if (!toUserId || !filePath) {
    console.error("用法: node send-file.mjs <userid> <文件路径>");
    process.exit(1);
  }

  const { WSClient } = await import("@wecom/aibot-node-sdk");
  const env = parseEnvFile(await readFile(join(ROOT, "secrets.env"), "utf8"));
  const buf = await readFile(filePath);
  const client = new WSClient({
    botId: env.WECOM_BOT_ID,
    secret: env.WECOM_BOT_SECRET,
    maxReconnectAttempts: 0,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: (m, ...a) => console.error("[sdk]", m) },
  });

  const timeout = setTimeout(() => { console.error("超时：60 秒内未完成"); process.exit(2); }, 60000);

  client.on("authenticated", async () => {
    try {
      const filename = basename(filePath);
      const mediaType = detectMediaType(filename);
      console.log(`上传中: ${filename} (${buf.length} 字节, type=${mediaType})…`);
      const up = await client.uploadMedia(buf, { type: mediaType, filename });
      console.log("上传成功 media_id:", up.media_id);
      const frame = await client.sendMediaMessage(
        toUserId, mediaType, up.media_id, mediaType === "video" ? { title: filename } : undefined,
      );
      console.log("发送结果:", JSON.stringify({ errcode: frame.errcode, errmsg: frame.errmsg }).slice(0, 300));
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
}

// 仅在作为脚本直接运行时执行（被 import 时只导出 detectMediaType，供测试用）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
