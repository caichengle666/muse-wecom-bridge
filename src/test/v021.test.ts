/** 0.2.1 回归测试：进程身份 / 同 id 互斥 / 认领与墓碑 / errcode / 卡片去重 / 单实例锁 / keepalive / 计次 / 硬链接 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, link, symlink, readFile } from "node:fs/promises";
import { existsSync, copyFileSync, chmodSync, readFileSync, statSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, frame, textFrame, writeOutbox, waitFor, ls, readJson, sleep, FakeClient } from "./helpers.js";
import { parseProcStat, readStartTime, isSameProcessAlive, STARTTIME_REST_INDEX, parseIdentity } from "../proc.js";
import { acquireInstanceLock, releaseInstanceLock } from "../lock.js";
import { CardEventDedupe } from "../state.js";
import { cardEventMessageId } from "../bridge.js";
import { errcodeOf, isPermanentError, runDelivery, OutboxStore, type Channel, type ReplyPayload } from "../outbox.js";
import { checkOutgoingFile, denyInodes } from "../files.js";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const KA = join(REPO, "keepalive.sh");
const HAS_PROC = existsSync("/proc/self/stat");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 等子进程退出（已退出则立即返回；带超时，防止测试挂死） */
function exited(c: ChildProcess, ms = 8000): Promise<void> {
  if (c.exitCode !== null || c.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`子进程 ${c.pid} ${ms}ms 内未退出`)), ms);
    c.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

function killQuiet(pid: number | undefined, sig: NodeJS.Signals = "SIGKILL"): void {
  if (!pid) return;
  try {
    process.kill(pid, sig);
  } catch {
    /* gone */
  }
}

/** 在 bash 里 source keepalive.sh 后执行 snippet（真正跑 shell 函数） */
function kaFn(snippet: string, env: Record<string, string> = {}): { status: number; out: string; err: string } {
  const r = spawnSync("bash", ["-c", `source "$KA"; ${snippet}`], {
    env: { ...process.env, KA, ...env },
    encoding: "utf8",
  });
  return { status: r.status ?? -1, out: (r.stdout || "").trim(), err: r.stderr || "" };
}

// ================================================================ 1. pid + starttime + token
test("v021-1: /proc/<pid>/stat 解析——comm 含空格与 ')'（'/tmp/…/a b) c'），TS 与 shell 结果一致且与 etimes 吻合", async (t) => {
  if (!HAS_PROC) return t.skip("需要 /proc");
  const dir = await mkdtemp(join(tmpdir(), "mwb-comm-"));
  const bin = join(dir, "a b) c");
  copyFileSync("/bin/sleep", bin);
  chmodSync(bin, 0o755);
  const child = spawn(bin, ["30"], { stdio: "ignore" });
  try {
    await waitFor(() => existsSync(`/proc/${child.pid}/stat`) && readFileSync(`/proc/${child.pid}/stat`, "utf8").includes("a b) c"));
    const raw = readFileSync(`/proc/${child.pid}/stat`, "utf8");
    const ps = parseProcStat(raw)!;
    assert.equal(ps.comm, "a b) c", "comm 截到最后一个 ')'");
    assert.equal(ps.pid, child.pid);
    assert.equal(STARTTIME_REST_INDEX, 19, "第 22 字段 = 剩余部分 0 基下标 19（= ${20}）");
    const ts = readStartTime(child.pid!)!;
    assert.equal(ts, ps.starttime);
    // 朴素按空格切分取第 22 个会取错（comm 里的空格把字段错位）
    assert.notEqual(raw.split(" ")[21], ts, "朴素解析会错位，测试有区分力");
    // shell 版
    const sh = kaFn(`proc_starttime ${child.pid}`);
    assert.equal(sh.status, 0, sh.err);
    assert.equal(sh.out, ts, "keepalive.sh 的 proc_starttime 与 TS 一致");
    // 独立校验：uptime - starttime/CLK_TCK ≈ 进程已运行秒数（ps etimes）
    const clk = Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout.trim()) || 100;
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    const etimes = Number(spawnSync("ps", ["-o", "etimes=", "-p", String(child.pid)], { encoding: "utf8" }).stdout.trim());
    assert.ok(Math.abs(uptime - Number(ts) / clk - etimes) <= 2, `starttime 合理：uptime=${uptime} st=${ts} etimes=${etimes}`);
  } finally {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("v021-1: isSameProcessAlive——pid 存在且 starttime 相同才算活；token 不符/pid 已死/starttime 不符都为 false", async (t) => {
  if (!HAS_PROC) return t.skip("需要 /proc");
  const st = readStartTime(process.pid)!;
  assert.equal(isSameProcessAlive({ pid: process.pid, starttime: st, token: "tokAAAAAAAA" }), true);
  assert.equal(isSameProcessAlive({ pid: process.pid, starttime: st, token: "tokAAAAAAAA" }, "tokAAAAAAAA"), true);
  assert.equal(isSameProcessAlive({ pid: process.pid, starttime: st, token: "tokAAAAAAAA" }, "tokBBBBBBBB"), false);
  assert.equal(isSameProcessAlive({ pid: process.pid, starttime: String(Number(st) + 1), token: "tokAAAAAAAA" }), false);
  const c = spawn("sleep", ["5"]);
  const cpid = c.pid!;
  const cst = readStartTime(cpid)!;
  assert.equal(isSameProcessAlive({ pid: cpid, starttime: cst, token: "tokAAAAAAAA" }), true);
  c.kill("SIGKILL");
  await exited(c); // node 已回收子进程
  assert.equal(isSameProcessAlive({ pid: cpid, starttime: cst, token: "tokAAAAAAAA" }), false, "进程已死");
  assert.equal(parseIdentity("123 456 abcdefgh\n")?.starttime, "456");
  assert.equal(parseIdentity("123\n"), null, "旧格式（只有 pid）不再被信任");
});

// ---- keepalive 端到端（真跑 keepalive.sh）
const FAKE_DAEMON_JS = `
const fs = require("fs");
const root = process.env.MUSE_WECOM_ROOT || process.cwd();
if (process.env.FAKE_SILENT === "1") { setInterval(() => {}, 1000); return; }
const s = fs.readFileSync("/proc/self/stat", "utf8");
const st = s.slice(s.lastIndexOf(")") + 1).trim().split(/\\s+/)[19];
const tok = require("crypto").randomBytes(8).toString("hex");
fs.writeFileSync(root + "/daemon.pid", process.pid + " " + st + " " + tok + "\\n");
const hb = () => {
  try { if (fs.readFileSync(root + "/freeze", "utf8").trim() === String(process.pid)) return; } catch {}
  fs.writeFileSync(root + "/heartbeat.json", JSON.stringify({ pid: process.pid, ts: Date.now(), connected: true, token: tok }));
};
hb();
setInterval(hb, 300);
`;

async function kaRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mwb-ka21-"));
  await mkdir(join(root, "dist"), { recursive: true });
  copyFileSync(KA, join(root, "keepalive.sh"));
  chmodSync(join(root, "keepalive.sh"), 0o755);
  await writeFile(join(root, "dist", "daemon.js"), FAKE_DAEMON_JS);
  return root;
}

function runKa(root: string, args: string[] = [], env: Record<string, string> = {}): number {
  const r = spawnSync("bash", [join(root, "keepalive.sh"), ...args], {
    env: {
      ...process.env,
      MUSE_WECOM_START_GRACE_SEC: "0",
      MUSE_WECOM_GRACE_SEC: "0",
      MUSE_WECOM_STALE_SEC: "90",
      MUSE_WECOM_WAIT_SEC: "8",
      NODE_BIN: process.execPath,
      ...env,
    },
    encoding: "utf8",
  });
  return r.status ?? -1;
}

function pidOf(root: string): number {
  return Number(readFileSync(join(root, "daemon.pid"), "utf8").split(" ")[0]);
}

function kaLog(root: string): string {
  return existsSync(join(root, "daemon.log")) ? readFileSync(join(root, "daemon.log"), "utf8") : "";
}

test("v021-1: keepalive 全流程——拉起 → 健康不重拉 → 心跳停滞时（身份核实后）杀掉重拉", async (t) => {
  if (!HAS_PROC) return t.skip("需要 /proc");
  const root = await kaRoot();
  const pids: number[] = [];
  try {
    assert.equal(runKa(root), 0, kaLog(root));
    const p1 = pidOf(root);
    pids.push(p1);
    assert.ok(alive(p1));
    assert.match(kaLog(root), /拉起成功/);
    if (existsSync("/usr/bin/flock")) {
      const fl = spawnSync("/usr/bin/flock", ["-n", join(root, ".keepalive.lock"), "true"]);
      assert.equal(fl.status, 0, "daemon 没有继承 keepalive 的 flock fd（0.2.0 会继承并永久持锁）");
    }
    assert.equal(runKa(root, ["--status"]), 0, "pid + starttime + token + ROOT 都对 → healthy");
    assert.equal(runKa(root), 0);
    assert.equal(pidOf(root), p1, "健康时不重拉");
    // 心跳停滞：冻结旧进程（只冻结它自己）并写一份过期心跳
    await writeFile(join(root, "freeze"), String(p1));
    await sleep(400);
    const tok = readFileSync(join(root, "daemon.pid"), "utf8").trim().split(" ")[2];
    await writeFile(join(root, "heartbeat.json"), JSON.stringify({ pid: p1, ts: Date.now() - 200_000, connected: true, token: tok }));
    assert.equal(runKa(root, ["--status"]), 1);
    // 新进程启动后会写心跳；旧进程被杀
    const r = runKa(root, [], { MUSE_WECOM_STALE_SEC: "1" });
    await sleep(100);
    const p2 = pidOf(root);
    pids.push(p2);
    assert.equal(r, 0, kaLog(root));
    assert.notEqual(p2, p1);
    assert.equal(alive(p1), false, "身份核实的僵尸被杀");
    assert.match(kaLog(root), /杀掉重拉/);
  } finally {
    for (const p of pids) killQuiet(p);
    await rm(root, { recursive: true, force: true });
  }
});

test("v021-1: keepalive 不杀 pid 复用/身份不符的进程（starttime 不符、token 不符、非本 ROOT 脚本）", async (t) => {
  if (!HAS_PROC) return t.skip("需要 /proc");
  const root = await kaRoot();
  // 一个命令行与 daemon 完全相同、但不写任何文件的进程（模拟 pid 被复用的另一个进程 / 身份对不上）
  const victim = spawn(process.execPath, [join(root, "dist", "daemon.js")], {
    cwd: root,
    env: { ...process.env, MUSE_WECOM_ROOT: root, FAKE_SILENT: "1" },
    stdio: "ignore",
  });
  const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
  const started: number[] = [];
  try {
    await sleep(200);
    const vpid = victim.pid!;
    const vst = readStartTime(vpid)!;
    const tok = "tok0123456789ab";
    const hbOld = (pid: number, token: string) =>
      writeFile(join(root, "heartbeat.json"), JSON.stringify({ pid, ts: Date.now() - 999_000, connected: false, token }));

    // (a) starttime 不符（pid 复用）
    await writeFile(join(root, "daemon.pid"), `${vpid} ${Number(vst) + 12345} ${tok}\n`);
    await hbOld(vpid, tok);
    assert.equal(kaFn(`identity_verified`, { MUSE_WECOM_ROOT: root }).status, 1);
    assert.equal(runKa(root), 0, kaLog(root));
    started.push(pidOf(root));
    assert.ok(alive(vpid), "starttime 不符：绝不 kill");
    assert.match(kaLog(root), /身份不符/);
    killQuiet(started.pop());

    // (b) starttime 对、心跳 token 不符
    await writeFile(join(root, "daemon.pid"), `${vpid} ${vst} ${tok}\n`);
    await hbOld(vpid, "tokDIFFERENT000");
    assert.equal(kaFn(`identity_verified`, { MUSE_WECOM_ROOT: root }).status, 1);
    assert.equal(runKa(root), 0, kaLog(root));
    started.push(pidOf(root));
    assert.ok(alive(vpid), "token 不符：绝不 kill");
    killQuiet(started.pop());

    // (c) pid/starttime/token 都对，但进程不是本 ROOT 的 daemon.js（sleep）
    const spid = sleeper.pid!;
    await writeFile(join(root, "daemon.pid"), `${spid} ${readStartTime(spid)} ${tok}\n`);
    await hbOld(spid, tok);
    assert.equal(runKa(root), 0, kaLog(root));
    started.push(pidOf(root));
    assert.ok(alive(spid), "不是本 ROOT 的 daemon：绝不 kill");

    // (d) 对照：全部核实 → 才会 kill
    killQuiet(started.pop());
    await writeFile(join(root, "daemon.pid"), `${vpid} ${vst} ${tok}\n`);
    await hbOld(vpid, tok);
    assert.equal(kaFn(`identity_verified`, { MUSE_WECOM_ROOT: root }).status, 0);
    assert.equal(runKa(root), 0, kaLog(root));
    started.push(pidOf(root));
    await waitFor(() => !alive(vpid) || readFileSync(`/proc/${vpid}/stat`, "utf8").includes(") Z"), 3000);
  } finally {
    killQuiet(victim.pid);
    killQuiet(sleeper.pid);
    for (const p of started) killQuiet(p);
    await rm(root, { recursive: true, force: true });
  }
});

// ================================================================ 2. 同 id 互斥
function scriptedChannel(sendText: (c: string, i: number) => Promise<void>, kind: "passive" | "proactive" = "proactive"): Channel {
  return {
    kind,
    imagesBatch: false,
    sendText,
    sendFile: async () => undefined,
    sendImages: async () => undefined,
    sendCard: async () => undefined,
    notify: async () => undefined,
  };
}

test("v021-2: 同一 id 并发 runDelivery 返回同一个进行中的 Promise，只发送一次", async () => {
  const env = await makeEnv();
  await writeOutbox(env, "m1", { chatId: "owner", text: "一次" });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let sends = 0;
  const ch = scriptedChannel(async () => {
    sends++;
    await gate;
  });
  const payload: ReplyPayload = { messageId: "m1", chatId: "owner", text: "一次" };
  const a = runDelivery(env.outbox, payload, ch, env.bridge.engine);
  const b = runDelivery(env.outbox, payload, ch, env.bridge.engine);
  assert.equal(a, b, "同一个 Promise");
  await waitFor(() => sends === 1);
  release();
  assert.deepEqual(await a, { status: "sent" });
  assert.deepEqual(await b, { status: "sent" });
  assert.equal(sends, 1);
  // 结束后再调用：已在 sent/，不重发
  assert.deepEqual(await runDelivery(env.outbox, payload, ch, env.bridge.engine), { status: "sent" });
  assert.equal(sends, 1);
});

test("v021-2: deliverReply 与 drain 的 TOCTOU——排空先认领发送中，被动回复加入同一投递、不重复发送", async () => {
  const env = await makeEnv({ replyTimeoutMs: 3000 });
  await writeOutbox(env, "t1", { chatId: "owner", text: "回复" });
  const release = env.client.holdAt("sendMessage", 1);
  // 排空在被动等待开始之前检查了 activeWaits（模拟检查-再执行竞态），认领并卡在发送里
  const dr = env.bridge.drain();
  await waitFor(() => env.client.of("sendMessage").length === 1);
  assert.ok(existsSync(join(env.paths.inflight, "t1.json")), "已认领到 inflight/");
  const pr = env.bridge.deliverReply(textFrame("t1", "owner", "hi"), "t1", "owner");
  await waitFor(() => env.logs.some((l) => l.event === "daemon.delivery_joined" && l.data.msgid === "t1"));
  release();
  const [d, p] = await Promise.all([dr, pr]);
  assert.deepEqual(d?.sent, ["t1"]);
  assert.equal(p.status, "sent");
  assert.equal(env.client.of("sendMessage").length, 1, "只主动发了一次");
  assert.equal(env.client.of("replyStream").length, 0, "被动通道没有再发一遍");
  assert.ok(existsSync(join(env.paths.sent, "t1.json")));
  assert.equal(existsSync(join(env.paths.expired, "t1.tombstone")), false, "没有因为看不到 outbox 文件而超时写墓碑");
});

// ================================================================ 3. 认领 / 墓碑 / 崩溃恢复
test("v021-3: 超时路径先 rename 抢到 outbox 文件 → expired/，之后发送方不发送", async () => {
  const env = await makeEnv();
  await writeOutbox(env, "x1", { chatId: "owner", text: "迟到" });
  assert.equal(await env.outbox.tombstone("x1"), "expired");
  assert.ok(existsSync(join(env.paths.expired, "x1.json")));
  const r = await runDelivery(env.outbox, { messageId: "x1", chatId: "owner", text: "迟到" }, scriptedChannel(async () => assert.fail("不应发送")), env.bridge.engine);
  assert.equal(r.status, "expired");
});

test("v021-3: 已认领发送中才到墓碑 → 超时路径记墓碑，发送方在部件之间停下，移到 expired/ 并写 partial", async () => {
  const env = await makeEnv();
  const text = "中".repeat(15000); // 3 段
  await writeOutbox(env, "x2", { chatId: "owner", text });
  const release = env.client.holdAt("sendMessage", 1);
  const dr = env.bridge.drain();
  await waitFor(() => env.client.of("sendMessage").length === 1);
  assert.equal(await env.outbox.tombstone("x2"), "inflight", "超时路径 rename 失败（已在 inflight）→ 只记墓碑");
  release();
  const rep = await dr;
  assert.deepEqual(rep?.expired, ["x2"]);
  assert.equal(env.client.of("sendMessage").length, 1, "剩余 2 段没有发出");
  assert.ok(existsSync(join(env.paths.expired, "x2.json")));
  const partial = await readJson(join(env.paths.expired, "x2.partial.json"));
  assert.deepEqual(partial.done, ["text:0"]);
  assert.deepEqual(partial.notSent, ["text:1", "text:2"]);
  assert.deepEqual(await ls(env.paths.inflight), []);
  assert.deepEqual(await ls(env.paths.outbox), []);
});

test("v021-3: 崩溃恢复——发送途中进程崩溃，文件留在 inflight/；重启后移回 outbox，只补发未发部件", async () => {
  const env1 = await makeEnv();
  const text = "中".repeat(15000); // 3 段
  await writeOutbox(env1, "cr1", { chatId: "owner", text });
  env1.client.holdAt("sendMessage", 2); // 第 2 段永远挂起 = 进程在此刻崩溃
  void env1.bridge.drain();
  await waitFor(() => env1.client.of("sendMessage").length === 2);
  await waitFor(async () => (await env1.outbox.loadProgress("cr1")).done.length === 1);
  assert.ok(existsSync(join(env1.paths.inflight, "cr1.json")), "崩溃时文件在 inflight/");
  assert.deepEqual(await ls(env1.paths.outbox), [], "排空看不到 inflight 文件（不会被别的排空重复拿走）");
  const sent1 = env1.client.of("sendMessage").map((c) => (c.args[1] as any).markdown.content as string);

  // "重启"：同一 ROOT 上的新进程（新 store / bridge / client）
  const env2 = await makeEnv({ root: env1.root });
  const rec = await env2.outbox.recoverInflight();
  assert.deepEqual(rec, { requeued: ["cr1"], expired: [] });
  assert.ok(existsSync(join(env2.paths.outbox, "cr1.json")));
  const rep = await env2.bridge.drain();
  assert.deepEqual(rep?.sent, ["cr1"]);
  const sent2 = env2.client.of("sendMessage").map((c) => (c.args[1] as any).markdown.content as string);
  assert.equal(sent2.length, 2, "只补发 text:1 与 text:2");
  assert.equal(sent1[0] + sent2.join(""), text, "已发的 text:0 不重发，内容完整");
  assert.ok(existsSync(join(env2.paths.sent, "cr1.json")));
});

test("v021-3: 崩溃恢复——inflight 文件已有墓碑 → 移到 expired/，不续发", async () => {
  const env = await makeEnv();
  await mkdir(env.paths.inflight, { recursive: true });
  await writeFile(join(env.paths.inflight, "cr2.json"), JSON.stringify({ messageId: "cr2", chatId: "owner", text: "x" }));
  await writeFile(env.outbox.tombstonePath("cr2"), "t\n");
  assert.deepEqual(await env.outbox.recoverInflight(), { requeued: [], expired: ["cr2"] });
  assert.ok(existsSync(join(env.paths.expired, "cr2.json")));
  await env.bridge.drain();
  assert.equal(env.client.of("sendMessage").length, 0);
});

// ================================================================ 4. errcodeOf
test("v021-4: errcodeOf 识别各种错误形状", () => {
  assert.equal(errcodeOf(new Error("send failed errcode=40008 errmsg=invalid")), 40008);
  assert.equal(errcodeOf(new Error('{"errcode":40008,"errmsg":"invalid message type"}')), 40008);
  assert.equal(errcodeOf(new Error("resp: {'errcode': '42044'}")), 42044);
  assert.equal(errcodeOf({ errcode: 42045, errmsg: "x" }), 42045);
  assert.equal(errcodeOf(new Error("outer", { cause: { errcode: 40058 } })), 40058);
  assert.equal(errcodeOf(new Error("a", { cause: new Error("b", { cause: new Error("ERRCODE: 42045") }) })), 42045, "递归 cause 链");
  assert.equal(errcodeOf(new Error("Reply failed (code: 40008)")), 40008, "SDK 格式");
  const e = new Error("opaque") as Error & { detail?: unknown };
  Object.defineProperty(e, "detail", { value: { errcode: 40008 }, enumerable: false });
  assert.equal(errcodeOf(e), 40008, "JSON.stringify(e, getOwnPropertyNames) 兜底");
  const loop: { cause?: unknown } = {};
  loop.cause = loop;
  assert.equal(errcodeOf(loop), undefined, "环不死循环");
  assert.equal(errcodeOf(new Error("Reply ack timeout (5000ms)")), undefined);
  assert.equal(isPermanentError(new Error("x", { cause: { errcode: 40058 } })), true);
  assert.equal(isPermanentError(new Error("errcode=846607")), false, "限频是临时错误");
});

// ================================================================ 5. 卡片去重
function cardFrame(msgid: string) {
  return frame({
    msgid,
    chattype: "single",
    from: { userid: "owner" },
    event: { eventtype: "template_card_event", template_card_event: { event_key: "approve", task_id: "task-dd" } },
  });
}

test("v021-5: 同一卡片回调投递两次（不同/相同 msgid、并发）→ inbox 只一条，卡片每次都更新", async () => {
  const env = await makeEnv();
  await Promise.all([env.bridge.onCardEvent(cardFrame("evA")), env.bridge.onCardEvent(cardFrame("evA"))]);
  await env.bridge.onCardEvent(cardFrame("evB")); // 重投递换了 msgid
  await env.bridge.onCardEvent(frame({ from: { userid: "owner" }, event: { template_card_event: { event_key: "approve", task_id: "task-dd" } } })); // 没 msgid
  assert.equal(env.client.of("updateTemplateCard").length, 4, "卡片照样更新（5 秒内必须回）");
  const items = (await ls(env.paths.inbox)).filter((f) => f.startsWith("card-"));
  assert.equal(items.length, 1);
  assert.ok(env.logs.some((l) => l.event === "daemon.card_event_duplicate"));
  // 持久化：重启后（新实例读 card_events.json）仍判重复
  await env.bridge.cardEvents.persist();
  const d2 = new CardEventDedupe(env.paths.cardEvents);
  d2.loadSync();
  assert.equal(d2.firstSeen(CardEventDedupe.keyOf("task-dd", "approve", "owner")), false);
  // 不同按钮 / 不同会话不算重复
  assert.equal(d2.firstSeen(CardEventDedupe.keyOf("task-dd", "reject", "owner")), true);
  assert.equal(d2.firstSeen(CardEventDedupe.keyOf("task-dd", "approve", "GROUP9")), true);
});

test("v021-5: 去重 TTL 过期后再次点击会重新入队；messageId 确定性派生（无 Date.now），与已完成的 id 不冲突", () => {
  let now = 1_000_000;
  const d = new CardEventDedupe(null, 10 * 60 * 1000, () => now);
  const k = CardEventDedupe.keyOf("t", "k", "u");
  assert.equal(d.firstSeen(k), true);
  now += 9 * 60 * 1000;
  assert.equal(d.firstSeen(k), false);
  now += 2 * 60 * 1000;
  assert.equal(d.firstSeen(k), true, "TTL 过后放行");
  const id1 = cardEventMessageId(k, "ev1");
  assert.equal(cardEventMessageId(k, "ev1"), id1, "同输入同 id");
  assert.match(id1, /^card-[0-9a-f]{24}$/);
  assert.notEqual(cardEventMessageId(k, ""), id1);
  assert.equal(cardEventMessageId(k, "ev1", (id) => id === id1), `${id1}-r2`, "上一轮已完成 → 追加 -r2");
});

// ================================================================ 6. 单实例锁
test("v021-6: daemon.lock O_EXCL 获取；持有者存活则失败；死进程/启动时间不符/损坏的陈旧锁被 rename 回收", async (t) => {
  if (!HAS_PROC) return t.skip("需要 /proc");
  const dir = await mkdtemp(join(tmpdir(), "mwb-lock-"));
  const lock = join(dir, "daemon.lock");
  const me = { pid: process.pid, starttime: readStartTime(process.pid)!, token: "tokSELF00000001" };
  const r1 = acquireInstanceLock(lock, me);
  assert.deepEqual(r1, { ok: true, reclaimed: false });
  assert.equal(readFileSync(lock, "utf8"), `${me.pid} ${me.starttime} ${me.token}\n`);
  const other = { ...me, token: "tokOTHER0000002" };
  const r2 = acquireInstanceLock(lock, other);
  assert.equal(r2.ok, false, "持有者（本进程，starttime 一致）存活 → 失败");
  releaseInstanceLock(lock, other);
  assert.ok(existsSync(lock), "别人的 token 不能释放");
  releaseInstanceLock(lock, me);
  assert.equal(existsSync(lock), false);

  // 死进程
  const c = spawn("sleep", ["5"]);
  const dead = { pid: c.pid!, starttime: readStartTime(c.pid!)!, token: "tokDEAD00000003" };
  c.kill("SIGKILL");
  await exited(c);
  await writeFile(lock, `${dead.pid} ${dead.starttime} ${dead.token}\n`);
  assert.deepEqual(acquireInstanceLock(lock, me), { ok: true, reclaimed: true });
  assert.equal(parseIdentity(readFileSync(lock, "utf8"))?.token, me.token);
  // pid 复用（pid 活着但 starttime 不符）
  await writeFile(lock, `${process.pid} 1 tokREUSED000004\n`);
  assert.deepEqual(acquireInstanceLock(lock, other), { ok: true, reclaimed: true });
  // 损坏
  await writeFile(lock, "garbage");
  assert.deepEqual(acquireInstanceLock(lock, me), { ok: true, reclaimed: true });
  assert.deepEqual((await ls(dir)).filter((f) => f.includes("stale")), [], "不留 .stale 文件");
  await rm(dir, { recursive: true, force: true });
});

test("v021-6: 真实 daemon（离线 wsUrl）自己持锁：第二个实例拒绝启动；kill -9 后陈旧锁被回收；keepalive 能核实真实 daemon 的身份", async (t) => {
  if (!HAS_PROC) return t.skip("需要 /proc");
  const root = await mkdtemp(join(tmpdir(), "mwb-real-"));
  await symlink(join(REPO, "dist"), join(root, "dist")); // ROOT/dist → 编译产物（keepalive 用 realpath 比较）
  await writeFile(join(root, "config.json"), JSON.stringify({ allowedUserIds: ["owner"], wsUrl: "ws://127.0.0.1:9" }));
  await writeFile(join(root, "secrets.env"), "WECOM_BOT_ID=realid\nWECOM_BOT_SECRET=realsecret\n", { mode: 0o600 });
  const env = { ...process.env, MUSE_WECOM_ROOT: root };
  const start = () => spawn(process.execPath, [join(root, "dist", "daemon.js")], { env, cwd: root, stdio: "ignore" });
  const kids: ChildProcess[] = [];
  try {
    const d1 = start();
    kids.push(d1);
    await waitFor(() => existsSync(join(root, "heartbeat.json")) && existsSync(join(root, "daemon.pid")), 5000);
    const id = parseIdentity(readFileSync(join(root, "daemon.pid"), "utf8"))!;
    assert.equal(id.pid, d1.pid);
    assert.equal(id.starttime, readStartTime(d1.pid!));
    const hb = JSON.parse(readFileSync(join(root, "heartbeat.json"), "utf8"));
    assert.equal(hb.token, id.token, "启动即写带 token 的心跳");
    assert.equal(readFileSync(join(root, "daemon.lock"), "utf8"), readFileSync(join(root, "daemon.pid"), "utf8"));
    assert.equal(kaFn("identity_verified", { MUSE_WECOM_ROOT: root }).status, 0, "keepalive 能核实真实 daemon");

    const r2 = spawnSync(process.execPath, [join(root, "dist", "daemon.js")], { env, cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(r2.status, 1);
    assert.match(r2.stderr, /持有锁/);

    d1.kill("SIGKILL");
    await exited(d1);
    assert.ok(existsSync(join(root, "daemon.lock")), "kill -9 留下陈旧锁");
    const d3 = start();
    kids.push(d3);
    await waitFor(() => existsSync(join(root, "debug.log")) && readFileSync(join(root, "debug.log"), "utf8").split("daemon.started").length - 1 >= 2, 5000);
    await waitFor(() => parseIdentity(readFileSync(join(root, "daemon.lock"), "utf8"))?.pid === d3.pid, 5000);
    await waitFor(() => existsSync(join(root, "debug.log")) && readFileSync(join(root, "debug.log"), "utf8").includes("daemon.lock_reclaimed"), 5000);
    d3.kill("SIGTERM");
    await exited(d3);
    assert.equal(existsSync(join(root, "daemon.lock")), false, "正常退出释放锁");
    assert.equal(existsSync(join(root, "daemon.pid")), false);
  } finally {
    for (const k of kids) killQuiet(k.pid);
    await rm(root, { recursive: true, force: true });
  }
});

// ================================================================ 7. ROOT realpath
test("v021-7: keepalive ROOT 经 realpath 规范化——经符号链接的 ROOT、相对路径或绝对路径启动的 daemon 都能识别", async (t) => {
  if (!HAS_PROC) return t.skip("需要 /proc");
  const root = await kaRoot();
  const linkRoot = join(tmpdir(), `mwb-ka-link-${process.pid}-${Date.now()}`);
  await symlink(root, linkRoot);
  const kids: ChildProcess[] = [];
  try {
    for (const how of ["relative", "abs-via-link"] as const) {
      const child =
        how === "relative"
          ? spawn(process.execPath, ["dist/daemon.js"], { cwd: linkRoot, env: { ...process.env, MUSE_WECOM_ROOT: root }, stdio: "ignore" })
          : spawn(process.execPath, [join(linkRoot, "dist", "daemon.js")], { cwd: "/", env: { ...process.env, MUSE_WECOM_ROOT: root }, stdio: "ignore" });
      kids.push(child);
      await waitFor(() => existsSync(join(root, "daemon.pid")) && pidOf(root) === child.pid, 3000);
      await waitFor(() => existsSync(join(root, "heartbeat.json")), 3000);
      const out = kaFn('echo "$ROOT"; identity_verified && echo OK', { MUSE_WECOM_ROOT: linkRoot });
      assert.equal(out.out.split("\n")[0], root, "ROOT 被 realpath");
      assert.match(out.out, /OK/, `${how} 启动的 daemon 被识别`);
      child.kill("SIGKILL");
      await rm(join(root, "daemon.pid"), { force: true });
    }
  } finally {
    for (const k of kids) killQuiet(k.pid);
    await rm(linkRoot, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

// ================================================================ 8. flock / mkdir 回退
test("v021-8: flock 未获取时记一行日志后退出；没有 flock 时警告并退回 mkdir 锁（持有者存活跳过、陈旧可回收）", async (t) => {
  if (!HAS_PROC) return t.skip("需要 /proc");
  const root = await mkdtemp(join(tmpdir(), "mwb-flock-"));
  copyFileSync(KA, join(root, "keepalive.sh"));
  try {
    if (existsSync("/usr/bin/flock")) {
      const holder = spawn("/usr/bin/flock", [join(root, ".keepalive.lock"), "sleep", "5"], { stdio: "ignore" });
      await sleep(300);
      assert.equal(runKa(root), 0);
      holder.kill("SIGKILL");
      assert.match(kaLog(root), /flock 未获取/);
    }
    // 没有 flock
    const st = readStartTime(process.pid)!;
    await mkdir(join(root, ".keepalive.lock.d"));
    await writeFile(join(root, ".keepalive.lock.d", "owner"), `${process.pid} ${st}\n`);
    assert.equal(runKa(root, [], { MUSE_WECOM_FLOCK_BIN: "" }), 0);
    assert.match(kaLog(root), /未找到 flock，退回 mkdir 锁/);
    assert.match(kaLog(root), /持有 mkdir 锁，本次跳过/);
    // 陈旧（starttime 不符）→ 回收后继续（缺 dist/daemon.js → exit 1），退出时释放锁目录
    await writeFile(join(root, ".keepalive.lock.d", "owner"), `${process.pid} 1\n`);
    assert.equal(runKa(root, [], { MUSE_WECOM_FLOCK_BIN: "" }), 1);
    assert.match(kaLog(root), /回收了陈旧的 mkdir 锁/);
    assert.match(kaLog(root), /缺少 .*daemon\.js/);
    assert.equal(existsSync(join(root, ".keepalive.lock.d")), false, "EXIT trap 释放 mkdir 锁");
    // 语法
    assert.equal(spawnSync("bash", ["-n", KA]).status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ================================================================ 9. 按部件 / 时间窗口计次
test("v021-9: 临时错误按部件计数、成功清零——各部件各失败 4 次不会进 failed/（0.2.0 累计计数会）", async () => {
  const env = await makeEnv();
  const store = env.outbox;
  const text = "中".repeat(15000); // 3 段
  await writeOutbox(env, "at1", { chatId: "owner", text });
  const failsLeft = new Map<number, number>([[0, 4], [1, 4], [2, 4]]);
  let sent = 0;
  const ch = scriptedChannel(async (_c, i) => {
    const n = failsLeft.get(i) || 0;
    if (n > 0) {
      failsLeft.set(i, n - 1);
      throw new Error("Reply ack timeout (5000ms)");
    }
    sent++;
  });
  const payload: ReplyPayload = { messageId: "at1", chatId: "owner", text };
  const statuses: string[] = [];
  for (let k = 0; k < 20; k++) {
    const r = await runDelivery(store, payload, ch, env.bridge.engine);
    statuses.push(r.status);
    if (r.status !== "retry") break;
  }
  assert.equal(statuses.at(-1), "sent", statuses.join(","));
  assert.equal(statuses.filter((s) => s === "retry").length, 12);
  assert.equal(sent, 3);
});

test("v021-9: 临时错误只在时间窗口内计数（默认 1h 内 5 次）——跨窗口的零星失败不会进 failed/", async () => {
  const env = await makeEnv();
  let now = 10_000_000;
  const engine = { ...env.bridge.engine, now: () => now, attemptWindowMs: 3600_000, maxAttempts: 5 };
  await writeOutbox(env, "at2", { chatId: "owner", text: "x" });
  const payload: ReplyPayload = { messageId: "at2", chatId: "owner", text: "x" };
  const ch = scriptedChannel(async () => {
    throw new Error("errcode=846607 rate limited");
  });
  for (let k = 0; k < 8; k++) {
    const r = await runDelivery(env.outbox, payload, ch, engine);
    assert.equal(r.status, "retry", `第 ${k + 1} 次（每次间隔 20 分钟，窗口内最多 3 次）`);
    now += 20 * 60 * 1000;
  }
  // 窗口内密集失败 5 次 → failed/
  let last = "";
  for (let k = 0; k < 5; k++) {
    last = (await runDelivery(env.outbox, payload, ch, engine)).status;
    now += 1000;
  }
  assert.equal(last, "failed");
  assert.ok(existsSync(join(env.paths.failed, "at2.json")));
  const reason = await readJson(join(env.paths.failed, "at2.reason.json"));
  assert.match(reason.reason, /60 分钟内重试 5 次/);
});

// ================================================================ 10. 硬链接
test("v021-10: 硬链接绕过被拒——nlink>1 拒绝；dev+ino 黑名单包含 ROOT 下的敏感文件", async () => {
  const env = await makeEnv();
  const opts = { root: env.root, allowedRoots: [env.paths.outgoing, tmpdir(), "/tmp"] };
  const l1 = join(env.paths.outgoing, "innocent.txt");
  await link(env.paths.secrets, l1);
  const r1 = await checkOutgoingFile(l1, opts);
  assert.equal(r1.ok, false, "outgoing/ 里指向 secrets.env 的硬链接（realpath 解析不出）");
  assert.match((r1 as { reason: string }).reason, /硬链接/);
  await writeFile(env.paths.config, "{}");
  const l2 = join(await mkdtemp(join(tmpdir(), "mwb-hl-")), "notes.txt");
  await link(env.paths.config, l2);
  assert.equal((await checkOutgoingFile(l2, opts)).ok, false, "/tmp 下指向 config.json 的硬链接");
  const inos = await denyInodes(env.root);
  const st = statSync(env.paths.secrets);
  assert.ok(inos.has(`${st.dev}:${st.ino}`));
  assert.ok(inos.has(`${statSync(env.paths.config).dev}:${statSync(env.paths.config).ino}`));
  const ok = join(env.paths.outgoing, "plain.txt");
  await writeFile(ok, "x");
  assert.equal((await checkOutgoingFile(ok, opts)).ok, true, "普通文件照常允许");
  assert.equal((await readFile(ok, "utf8")), "x");
});

// FakeClient 的 holdAt 本身也要可靠（并发测试的基础）
test("v021: FakeClient.holdAt 只挂起第 n 次调用", async () => {
  const c = new FakeClient();
  const rel = c.holdAt("sendMessage", 2);
  await c.sendMessage("a", {});
  let done = false;
  const p = c.sendMessage("b", {}).then(() => (done = true));
  await sleep(20);
  assert.equal(done, false);
  await c.sendMessage("c", {});
  rel();
  await p;
  assert.equal(done, true);
});
