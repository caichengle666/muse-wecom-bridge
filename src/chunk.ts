/** chunk.ts — 按 UTF-8 字节数切分文本（不切断多字节字符）。 */

/** 企业微信流式单条上限 20480 字节，留余量取 20000。 */
export const STREAM_CHUNK_BYTES = 20000;

export function chunkByBytes(s: string, maxBytes: number = STREAM_CHUNK_BYTES): string[] {
  if (maxBytes < 4) throw new Error("maxBytes 至少为 4（容纳一个 UTF-8 字符）");
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, "utf8");
    if (curBytes + b > maxBytes && cur) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur) out.push(cur);
  return out;
}
