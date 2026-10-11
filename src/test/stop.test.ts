import { test } from "node:test";
import assert from "node:assert/strict";
import { rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, textFrame, writeOutbox, waitFor, ls, readJson, sleep } from "./helpers.js";
import { isStopCommand } from "../bridge.js";

test("stop: 命令识别（可带 @，句子里提到不算）", () => {
  assert.ok(isStopCommand("/stop"));
  assert.ok(isStopCommand("  /STOP "));
  assert.ok(isStopCommand("@小助手 /stop"));
  assert.ok(!isStopCommand("/stop 一下那个服务"));
  assert.ok(!isStopCommand("怎么用 /stop"));
});

test("stop: 中断本会话进行中的消息：不发超时提示、迟到回复不发、写标记；别的会话不受影响；没任务时如实说", async () => {
  const env = await makeEnv({ replyTimeoutMs: 5000 });
  const replies = () => env.client.of("replyStream").map((c) => String(c.args[2]));
  const pA = env.bridge.handleText(textFrame("a1", "owner", "删掉 a 目录"));
  const pB = env.bridge.handleText(textFrame("b1", "owner", "别的会话的活", { chatid: "grp2", chattype: "group" }));
  await waitFor(() => existsSync(join(env.paths.inbox, "a1.json")) && existsSync(join(env.paths.inbox, "b1.json")));
  await rename(join(env.paths.inbox, "a1.json"), join(env.paths.inbox, "a1.json.claimed")); // hook 已认领
  const t0 = Date.now();
  await env.bridge.handleText(textFrame("s1", "owner", "/stop"));
  const ra = await pA;
  assert.equal(ra?.status, "stopped");
  assert.ok(Date.now() - t0 < 1000, "等待立即结束");
  assert.ok(replies().some((x) => x.includes("已停止 1 个")), replies().join("|"));
  assert.ok(!replies().some((x) => x.includes("超时")));
  assert.ok(existsSync(join(env.paths.expired, "a1.stopped")));
  assert.ok(env.outbox.hasTombstone("a1"));
  assert.ok(!(await ls(env.paths.inbox)).some((f) => f.startsWith("a1") || f.startsWith("s1")));
  const st = await readJson(join(env.paths.stop, "owner.json"));
  assert.deepEqual(st.cancelled, ["a1"]);
  // worker 停得慢，之后才写出回复：排空不发
  await writeOutbox(env, "a1", { chatId: "owner", text: "已删除 a 目录" });
  await env.bridge.drain();
  await sleep(20);
  assert.ok(!env.client.calls.some((c) => JSON.stringify(c.args).includes("已删除")));
  // 别的会话照常
  assert.ok(!env.outbox.hasTombstone("b1"));
  await writeOutbox(env, "b1", { chatId: "grp2", text: "做完了" });
  assert.equal((await pB)?.status, "sent");
  // 没有进行中的
  await env.bridge.handleText(textFrame("s2", "owner", "@小助手 /stop"));
  assert.ok(replies().some((x) => x.includes("没有进行中")));
});
