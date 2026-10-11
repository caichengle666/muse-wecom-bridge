/**
 * stream.ts — 流式输出（打字机效果）的文件协议，与飞书桥接一致。
 *
 * worker 生成长回复时，边写边往 stream/<messageId>.jsonl 追加一行一段：
 *   {"text":"第一段……\n\n"}
 *   {"text":"第二段……"}
 * 各段原样首尾相接。daemon 把累计全文推到这条消息的企业微信流式消息上（同一 streamId 整体覆盖）；
 * 最终仍以 outbox/<id>.json 为准：到达后流式消息定格为完整回复的第一段，stream 文件删除。
 */
import { STREAM_CHUNK_BYTES, chunkByBytes } from "./chunk.js";

export const STREAM_MORE_NOTE = "\n\n…（内容较长，写完后分段完整发出）";

/** 解析 stream 文件：逐行 JSON {text}，坏行（含正在写的半行）忽略。 */
export function parseStreamText(raw: string): string {
  let text = "";
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as { text?: unknown } | null;
      if (o && typeof o === "object" && typeof o.text === "string") text += o.text;
    } catch {
      /* 半行或坏行 */
    }
  }
  return text;
}

/** 流式期间显示的文本：超过单条上限时截断并加提示；截断处在代码块里就补闭合围栏。 */
export function streamDisplayText(full: string): string {
  if (Buffer.byteLength(full, "utf8") <= STREAM_CHUNK_BYTES) return full;
  let head = chunkByBytes(full, STREAM_CHUNK_BYTES - 200)[0];
  if ((head.match(/^\s*```/gm) || []).length % 2 === 1) head += "\n```";
  return head + STREAM_MORE_NOTE;
}
