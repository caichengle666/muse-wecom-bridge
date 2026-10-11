/** 流式输出：stream/<id>.jsonl → 企业微信流式消息（同一 streamId 整体覆盖），最终回复定格。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, textFrame, writeOutbox, waitFor, sleep } from "./helpers.js";
import { parseStreamText, streamDisplayText, STREAM_MORE_NOTE } from "../stream.js";

const streams = (env: Awaited<ReturnType<typeof makeEnv>>) =>
  env.client.of("replyStream").map((c) => ({ sid: String(c.args[1]), text: String(c.args[2]), finish: c.args[3] === true }));
const line = (text: string) => JSON.stringify({ text }) + "\n";

test("stream: 解析与截断", () => {
  assert.equal(parseStreamText(line("a") + line("b\n") + '{"text":"半'), "ab\n");
  const long = "```\n" + "字".repeat(8000);
  const d = streamDisplayText(long);
  assert.ok(d.endsWith(STREAM_MORE_NOTE));
  assert.ok(d.includes("\n```" + STREAM_MORE_NOTE), "代码块内截断要补闭合围栏");
  assert.ok(Buffer.byteLength(d) <= 20480);
});

test("stream: 处理中 → 逐段刷新 → 最终回复定格在同一条流式消息上", async () => {
  const env = await makeEnv({ ackDelayMs: 20 });
  const p = env.bridge.handleText(textFrame("m1", "owner", "写一篇长文"));
  await waitFor(() => streams(env).some((s) => s.text.includes("正在处理")));
  const f = join(env.paths.stream, "m1.jsonl");
  await appendFile(f, line("第一段\n\n"));
  await waitFor(() => streams(env).some((s) => s.text === "第一段\n\n"));
  await appendFile(f, line("第二段"));
  await waitFor(() => streams(env).some((s) => s.text === "第一段\n\n第二段"));
  await writeOutbox(env, "m1", { chatId: "owner", text: "第一段\n\n第二段（完整版）" });
  const r = await p;
  assert.equal(r?.status, "sent");
  const all = streams(env);
  assert.equal(new Set(all.map((s) => s.sid)).size, 1, "始终是同一条流式消息");
  assert.deepEqual(all.at(-1), { sid: all[0].sid, text: "第一段\n\n第二段（完整版）", finish: true });
  assert.equal(all.filter((s) => s.finish).length, 1);
  assert.ok(!existsSync(f), "stream 文件清理");
});

test("stream: 流式内容早于处理中提示时不再覆盖成“处理中”", async () => {
  const env = await makeEnv({ ackDelayMs: 300 });
  const p = env.bridge.handleText(textFrame("m2", "owner", "hi"));
  await waitFor(() => existsSync(join(env.paths.inbox, "m2.json")));
  await appendFile(join(env.paths.stream, "m2.jsonl"), line("马上"));
  await waitFor(() => streams(env).some((s) => s.text === "马上"));
  await sleep(400);
  assert.ok(!streams(env).some((s) => s.text.includes("正在处理")));
  await writeOutbox(env, "m2", { chatId: "owner", text: "马上就好" });
  await p;
  assert.equal(streams(env).at(-1)?.text, "马上就好");
});

test("stream: 接近窗口上限先收尾，正式回复另发新消息", async () => {
  const env = await makeEnv({ ackDelayMs: 10, streamWindowMs: 150 });
  const p = env.bridge.handleText(textFrame("m3", "owner", "很慢的活"));
  await waitFor(() => streams(env).some((s) => s.finish && s.text.includes("完成后另发")));
  await writeOutbox(env, "m3", { chatId: "owner", text: "终于好了" });
  await p;
  const all = streams(env);
  const last = all.at(-1)!;
  assert.equal(last.text, "终于好了");
  assert.equal(last.finish, true);
  assert.notEqual(last.sid, all[0].sid);
});

test("stream: 超时 / 推送失败 / 关闭开关", async () => {
  // 超时：超时提示定格在流式消息上，不另发
  const env = await makeEnv({ ackDelayMs: 10, replyTimeoutMs: 200 });
  const r = await env.bridge.handleText(textFrame("m4", "owner", "x"));
  assert.equal(r?.status, "timeout");
  const all = streams(env);
  assert.equal(new Set(all.map((s) => s.sid)).size, 1);
  assert.ok(all.at(-1)!.finish && all.at(-1)!.text.includes("超时"));

  // 刷新失败（如 846608 窗口已过）：最终回复改为另发
  const e2 = await makeEnv({ ackDelayMs: 10 });
  const p2 = e2.bridge.handleText(textFrame("m5", "owner", "y"));
  await waitFor(() => streams(e2).length === 1);
  e2.client.failNext("replyStream", Object.assign(new Error("846608"), { errcode: 846608 }));
  await writeOutbox(e2, "m5", { chatId: "owner", text: "结果" });
  assert.equal((await p2)?.status, "sent");
  const s2 = streams(e2);
  assert.equal(s2.at(-1)!.text, "结果");
  assert.notEqual(s2.at(-1)!.sid, s2[0].sid);

  // streamReplies=false：处理中是一条独立的已完成消息
  const e3 = await makeEnv({ ackDelayMs: 10, config: { allowedUserIds: ["owner"], streamReplies: false } });
  const p3 = e3.bridge.handleText(textFrame("m6", "owner", "z"));
  await waitFor(() => streams(e3).length === 1);
  await appendFile(join(e3.paths.stream, "m6.jsonl"), line("不该推"));
  await sleep(50);
  await writeOutbox(e3, "m6", { chatId: "owner", text: "好" });
  await p3;
  const s3 = streams(e3);
  assert.ok(s3.every((s) => s.finish));
  assert.ok(!s3.some((s) => s.text === "不该推"));
});
