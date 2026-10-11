/** 评审修复：超时作废 inbox、/stop 扫 inbox、流式收尾、配对竞态、锁原子创建、白名单校验。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEnv, frame, textFrame, writeOutbox, waitFor, ls, readJson, sleep } from "./helpers.js";
import { acquireInstanceLock } from "../lock.js";
import { readStartTime } from "../proc.js";
import { EXAMPLE_USERID, makeIsAllowed, validateConfig } from "../config.js";

test("#1 超时：inbox 文件（已认领）移到 expired/ 并留 <id>.timeout，写墓碑；worker 的 .claimed 不见了", async () => {
  const env = await makeEnv({ replyTimeoutMs: 80 });
  const p = env.bridge.handleText(textFrame("m1", "owner", "跑个长任务"));
  await waitFor(() => existsSync(join(env.paths.inbox, "m1.json")));
  await rename(join(env.paths.inbox, "m1.json"), join(env.paths.inbox, "m1.json.claimed"));
  assert.equal((await p)?.status, "timeout");
  assert.deepEqual(await ls(env.paths.inbox), []);
  assert.ok(existsSync(join(env.paths.expired, "m1.inbox.json")));
  assert.ok(existsSync(join(env.paths.expired, "m1.timeout")));
  assert.ok(!existsSync(join(env.paths.expired, "m1.stopped")), "不是 /stop，别记成被中断");
  assert.ok(env.outbox.hasTombstone("m1"));
  assert.ok(env.client.of("replyStream").some((c) => String(c.args[2]).includes("超时")));
  // 未认领也一样
  const p2 = env.bridge.handleText(textFrame("m2", "owner", "hook 没在跑"));
  assert.equal((await p2)?.status, "timeout");
  assert.ok(!existsSync(join(env.paths.inbox, "m2.json")));
  assert.equal((await readJson(join(env.paths.expired, "m2.timeout"))).state, "unclaimed");
});

test("#3 /stop：卡片点击的任务、daemon 重启前收到的任务（inbox 里没有等待方）也能停；别的会话不动", async () => {
  const env = await makeEnv();
  await env.bridge.onCardEvent(
    frame({ msgid: "ev1", chattype: "single", from: { userid: "owner" }, event: { eventtype: "template_card_event", template_card_event: { event_key: "go", task_id: "t1" } } }),
  );
  const card = (await ls(env.paths.inbox)).find((f) => f.startsWith("card-"))!.replace(/\.json$/, "");
  assert.ok(card);
  await rename(join(env.paths.inbox, `${card}.json`), join(env.paths.inbox, `${card}.json.claimed`));
  // daemon 重启前收到、已被认领
  await writeFile(join(env.paths.inbox, "old1.json.claimed"), JSON.stringify({ messageId: "old1", chatId: "owner", text: "x" }));
  // 别的会话
  await writeFile(join(env.paths.inbox, "g1.json"), JSON.stringify({ messageId: "g1", chatId: "grp", text: "y" }));
  await env.bridge.handleText(textFrame("s1", "owner", "/stop"));
  const st = await readJson(join(env.paths.stop, "owner.json"));
  assert.deepEqual([...st.cancelled].sort(), [card, "old1"].sort());
  assert.deepEqual(await ls(env.paths.inbox), ["g1.json"]);
  for (const id of [card, "old1"]) {
    assert.ok(existsSync(join(env.paths.expired, `${id}.stopped`)));
    assert.ok(env.outbox.hasTombstone(id));
  }
  assert.ok(env.client.of("replyStream").some((c) => String(c.args[2]).includes("已停止 2 个")));
  // worker 之后写出的回复不会被排空主动推送
  await writeOutbox(env, card, { chatId: "owner", text: "卡片任务做完了" });
  await env.bridge.drain();
  assert.ok(!env.client.calls.some((c) => JSON.stringify(c.args).includes("卡片任务做完了")));
});

test("#4 流式：正式回复在'处理中'首推等回执时到达，仍定格在同一条流式消息上并 finish", async () => {
  const env = await makeEnv({ ackDelayMs: 10 });
  const release = env.client.holdAt("replyStream", 1); // 首推（处理中）挂起等回执
  const p = env.bridge.handleText(textFrame("r1", "owner", "问题"));
  await waitFor(() => env.client.of("replyStream").length === 1);
  await writeOutbox(env, "r1", { chatId: "owner", text: "正式回复" });
  await sleep(60); // 回复已到，首推的回执还没回来
  release();
  assert.equal((await p)?.status, "sent");
  const calls = env.client.of("replyStream").map((c) => ({ sid: c.args[1], text: c.args[2], finish: c.args[3] }));
  const sid = calls[0].sid;
  assert.ok(calls.every((c) => c.sid === sid), JSON.stringify(calls));
  assert.deepEqual(calls.at(-1), { sid, text: "正式回复", finish: true });
});

test("#6 配对竞态：两人同时发码只有第一个成功；并进磁盘上已有的白名单，不覆盖", async () => {
  const config = { allowedUserIds: [] as string[], pairCode: "ABCDEFGH", replyTimeoutMin: 20 };
  const env = await makeEnv({ config });
  // 磁盘上有人手动加了 bob（内存里还没生效）
  await writeFile(env.paths.config, JSON.stringify({ ...config, allowedUserIds: ["bob", EXAMPLE_USERID] }));
  await Promise.all([
    env.bridge.handleText(textFrame("p1", "alice", "abcdefgh")),
    env.bridge.handleText(textFrame("p2", "mallory", "ABCDEFGH")),
  ]);
  const texts = env.client.of("replyStream").map((c) => String(c.args[2]));
  assert.equal(texts.filter((t) => t.includes("配对成功")).length, 1, texts.join("|"));
  assert.ok(texts.some((t) => t.includes("alice") && t.includes("配对成功")));
  const disk = JSON.parse(readFileSync(env.paths.config, "utf8"));
  assert.deepEqual(disk.allowedUserIds, ["bob", "alice"]);
  assert.equal(disk.pairCode, undefined);
  assert.equal(disk.replyTimeoutMin, 20);
  assert.equal(config.pairCode, undefined);
  // alice 立即可用，mallory 不行
  const p = env.bridge.handleText(textFrame("q1", "alice", "你好"));
  await waitFor(() => existsSync(join(env.paths.inbox, "q1.json")));
  await writeOutbox(env, "q1", { chatId: "alice", text: "hi" });
  assert.equal((await p)?.status, "sent");
});

test("#6 配对：config.json 写失败时配对码放回，可以再试", async () => {
  const config: { allowedUserIds: string[]; pairCode?: string } = { allowedUserIds: [], pairCode: "ABCDEFGH" };
  const env = await makeEnv({ config });
  await writeFile(env.paths.config, "{坏的 json");
  await env.bridge.handleText(textFrame("p1", "alice", "ABCDEFGH"));
  assert.match(String(env.client.of("replyStream").at(-1)!.args[2]), /配对失败/);
  assert.equal(config.pairCode, "ABCDEFGH");
});

test("#7 锁：先写临时文件再 link，锁文件一出现就有完整内容；不留临时文件；被占时也清理", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mwb-lock2-"));
  const lock = join(dir, "daemon.lock");
  const me = { pid: process.pid, starttime: readStartTime(process.pid)!, token: "tokA1234567" };
  assert.deepEqual(acquireInstanceLock(lock, me), { ok: true, reclaimed: false });
  assert.equal(readFileSync(lock, "utf8"), `${me.pid} ${me.starttime} ${me.token}\n`);
  const r = acquireInstanceLock(lock, { ...me, token: "tokB1234567" }, { isAlive: () => true });
  assert.equal(r.ok, false);
  assert.deepEqual(readdirSync(dir), ["daemon.lock"]);
});

test("#9 白名单：示例占位、前后带空格的 userid 校验报错；判定时按去空格比较", () => {
  assert.match(validateConfig({ allowedUserIds: [EXAMPLE_USERID] }).errors.join(), /示例占位/);
  assert.match(validateConfig({ allowedUserIds: [" alice"] }).errors.join(), /前后有空格/);
  assert.match(validateConfig({ allowedUserIds: ["   "] }).errors.join(), /非空字符串数组/);
  assert.deepEqual(validateConfig({ allowedUserIds: ["alice"] }).errors, []);
  assert.ok(makeIsAllowed({ allowedUserIds: [" alice "] })("alice", "single", "alice"));
  assert.ok(!makeIsAllowed({ allowedUserIds: [EXAMPLE_USERID] })(EXAMPLE_USERID, "single", EXAMPLE_USERID));
});

test("代理选择：HTTPS_PROXY 生效、NO_PROXY 命中直连、config 可强制 off / 覆盖；配置校验拒绝非法 proxy", async () => {
  const { chooseProxy, applyAxiosProxy } = await import("../proxy.js");
  const { validateConfig } = await import("../config.js");
  const T = "https://openws.work.weixin.qq.com";
  assert.equal(chooseProxy(T, undefined, {}).url, null);
  assert.equal(chooseProxy(T, undefined, { HTTPS_PROXY: "http://u:p@px:3128" }).label, "http://px:3128");
  assert.equal(chooseProxy(T, undefined, { HTTPS_PROXY: "http://px:1", NO_PROXY: ".weixin.qq.com" }).url, null);
  assert.equal(chooseProxy(T, "off", { HTTPS_PROXY: "http://px:1" }).url, null);
  assert.equal(chooseProxy(T, "http://cfg:8080", { HTTPS_PROXY: "http://px:1" }).url, "http://cfg:8080");
  const d: Record<string, unknown> = {};
  applyAxiosProxy(d, undefined);
  assert.equal(d.proxy, false);
  assert.equal(d.httpsAgent, undefined);
  const base = { allowedUserIds: ["zhangsan"] };
  assert.equal(validateConfig({ ...base, proxy: "socks5://x" }).errors.length, 1);
  assert.equal(validateConfig({ ...base, proxy: "http://127.0.0.1:7890" }).errors.length, 0);
});
