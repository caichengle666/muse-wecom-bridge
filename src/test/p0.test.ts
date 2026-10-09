import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeEnv, frame, textFrame, writeOutbox, waitFor, ls, readJson, sleep } from "./helpers.js";
import { HeartbeatWriter } from "../state.js";
import { checkOutgoingFile } from "../files.js";
import { validateConfig, makeIsAllowed } from "../config.js";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");

// ---------------------------------------------------------------- Bug 1
test("bug1: disconnected_event 写 kicked.json、心跳置 connected:false、延迟后 exit(1)", async () => {
  const env = await makeEnv({ kickExitDelayMs: 30 });
  env.bridge.attach();
  env.client.emit("authenticated");
  await waitFor(async () => existsSync(env.paths.heartbeat) && (await readJson(env.paths.heartbeat)).connected === true);
  env.client.emit("event.disconnected_event", frame({ event: { eventtype: "disconnected_event" } }));
  await waitFor(() => existsSync(env.paths.kicked));
  assert.deepEqual(env.exits, [], "不应立即退出（先让日志/标记落盘）");
  await waitFor(() => env.exits.length > 0);
  assert.deepEqual(env.exits, [1]);
  const hb = await readJson(env.paths.heartbeat);
  assert.equal(hb.connected, false);
});

test("bug1: 心跳只在已认证时写，带 connected:true；断开后不再刷新", async () => {
  const env = await makeEnv();
  let now = 1000;
  const hb = new HeartbeatWriter(env.paths.heartbeat, 4242, () => now);
  await hb.tick();
  assert.equal(existsSync(env.paths.heartbeat), false, "未认证时不写心跳（原实现无条件写 → 僵尸也显得健康）");
  await hb.setConnected(true);
  assert.deepEqual(await readJson(env.paths.heartbeat), { pid: 4242, ts: 1000, connected: true });
  now = 2000;
  await hb.tick();
  assert.equal((await readJson(env.paths.heartbeat)).ts, 2000);
  now = 3000;
  await hb.setConnected(false);
  assert.deepEqual(await readJson(env.paths.heartbeat), { pid: 4242, ts: 3000, connected: false });
  now = 9000;
  await hb.tick();
  assert.equal((await readJson(env.paths.heartbeat)).ts, 3000, "断开后 ts 冻结，keepalive 可判停滞");
});

test("bug1: 'disconnected' 事件把心跳置为 connected:false", async () => {
  const env = await makeEnv();
  env.bridge.attach();
  env.client.emit("authenticated");
  await waitFor(async () => existsSync(env.paths.heartbeat));
  env.client.emit("disconnected", "network");
  await waitFor(async () => (await readJson(env.paths.heartbeat)).connected === false);
});

// ---------------------------------------------------------------- Bug 2
test("bug2: waitReply 遇到非法 JSON 继续轮询，之后变合法则返回内容", async () => {
  const env = await makeEnv({ replyTimeoutMs: 1000 });
  await writeOutbox(env, "m1", "{ not json");
  const p = env.backend.waitReply("m1");
  await sleep(60);
  await writeOutbox(env, "m1", { chatId: "owner", text: "真正的回复" });
  const r = await p;
  assert.equal(r?.text, "真正的回复");
  assert.equal(env.logs.filter((l) => l.event === "backend.outbox_parse_error").length, 1, "解析失败只记一次日志");
});

test("bug2: 非法 JSON 到超时 → 按超时处理（不归档空回复、不丢消息）", async () => {
  const env = await makeEnv({ replyTimeoutMs: 150 });
  await writeOutbox(env, "m2", "{ broken");
  assert.equal(await env.backend.waitReply("m2"), null, "原实现返回 {text:''}");
  const res = await env.bridge.deliverReply(textFrame("m2", "owner", "hi"), "m2", "owner");
  assert.equal(res.status, "timeout");
  assert.deepEqual(await ls(env.paths.sent), [], "不能把空回复归档到 sent/");
  assert.ok(existsSync(join(env.paths.expired, "m2.json")), "原文件保留在 expired/ 供排查");
});

// ---------------------------------------------------------------- Bug 3
test("bug3: 文本已发、文件路径不允许 → 进 failed/，再次排空不重发文本", async () => {
  const env = await makeEnv();
  await writeOutbox(env, "p1", { chatId: "owner", text: "早报", file: "/etc/passwd" });
  const r1 = await env.bridge.drain();
  assert.deepEqual(r1?.failed, ["p1"]);
  const texts = () => env.client.of("sendMessage").filter((c) => (c.args[1] as any).msgtype === "markdown" && (c.args[1] as any).markdown.content === "早报");
  assert.equal(texts().length, 1);
  assert.ok(existsSync(join(env.paths.failed, "p1.json")));
  const reason = await readJson(join(env.paths.failed, "p1.reason.json"));
  assert.match(reason.reason, /file: 文件路径不在允许范围/);
  assert.deepEqual(reason.done, ["text:0"]);
  for (let i = 0; i < 3; i++) await env.bridge.drain();
  assert.equal(texts().length, 1, "原实现每 60 秒重发一次文本，永不停止");
});

test("bug3: 文件过大 / 不存在 → 永久失败进 failed/", async () => {
  const env = await makeEnv();
  const big = join(env.paths.outgoing, "big.bin");
  await writeFile(big, Buffer.alloc(10 * 1024 * 1024 + 1));
  await writeOutbox(env, "p2", { chatId: "owner", text: "", file: big });
  await writeOutbox(env, "p3", { chatId: "owner", text: "", file: join(env.paths.outgoing, "nope.pdf") });
  const r = await env.bridge.drain();
  assert.deepEqual(r?.failed.sort(), ["p2", "p3"]);
  assert.match((await readJson(join(env.paths.failed, "p2.reason.json"))).reason, /文件过大/);
  assert.match((await readJson(join(env.paths.failed, "p3.reason.json"))).reason, /文件不存在/);
  assert.equal(env.client.of("uploadMedia").length, 0);
});

test("bug3: 卡片永久错误码(42045) → failed/，文本不重发", async () => {
  const env = await makeEnv();
  await writeOutbox(env, "p4", { chatId: "owner", text: "看卡片", card: { card_type: "news_notice", task_id: "t4" } });
  let n = 0;
  const orig = env.client.sendMessage.bind(env.client);
  env.client.sendMessage = async (chatid: string, body: any) => {
    if (body.msgtype === "template_card") {
      n++;
      env.client.calls.push({ method: "sendMessage", args: [chatid, body] });
      throw { errcode: 42045, errmsg: "invalid card" };
    }
    return orig(chatid, body);
  };
  await env.bridge.drain();
  await env.bridge.drain();
  assert.equal(n, 1, "永久错误不重试");
  assert.ok(existsSync(join(env.paths.failed, "p4.json")));
  assert.equal(env.client.of("sendMessage").filter((c) => (c.args[1] as any).markdown?.content === "看卡片").length, 1);
});

test("bug3: 临时错误重试，最多 5 次后进 failed/；已发部件不重发", async () => {
  const env = await makeEnv();
  await writeOutbox(env, "p5", { chatId: "owner", text: "文本", card: { card_type: "button_interaction", task_id: "t5" } });
  let cardTries = 0;
  const orig = env.client.sendMessage.bind(env.client);
  env.client.sendMessage = async (chatid: string, body: any) => {
    if (body.msgtype === "template_card") {
      cardTries++;
      throw { errcode: 846607, errmsg: "rate limited" };
    }
    return orig(chatid, body);
  };
  for (let i = 0; i < 4; i++) {
    const r = await env.bridge.drain();
    assert.deepEqual(r?.retry, ["p5"]);
  }
  const r5 = await env.bridge.drain();
  assert.deepEqual(r5?.failed, ["p5"]);
  assert.equal(cardTries, 5);
  assert.equal(env.client.of("sendMessage").length, 1, "文本只发了一次");
  await env.bridge.drain();
  assert.equal(cardTries, 5, "进 failed/ 后不再尝试");
  assert.deepEqual(await ls(env.paths.progress), [], "进度文件已清理");
});

test("bug3: 缺少 chatId 的 outbox → failed/（不再静默归档成已发送）", async () => {
  const env = await makeEnv();
  await writeOutbox(env, "p6", { text: "x" });
  await env.bridge.drain();
  assert.ok(existsSync(join(env.paths.failed, "p6.json")));
  assert.deepEqual(await ls(env.paths.sent), []);
});

// ---------------------------------------------------------------- Bug 4
test("bug4: 被动发送进行中 activeWaits 仍持有该 id，排空不会重复发送", async () => {
  const env = await makeEnv();
  await env.backend.init();
  const release = env.client.hold("replyStream");
  await writeOutbox(env, "a1", { chatId: "owner", text: "回复" });
  const p = env.bridge.deliverReply(textFrame("a1", "owner", "hi"), "a1", "owner");
  await waitFor(() => env.client.of("replyStream").length === 1);
  assert.ok(env.bridge.activeWaits.has("a1"), "原实现在 waitReply 返回后就删掉了");
  const r = await env.bridge.drain();
  assert.deepEqual(r?.sent, []);
  assert.equal(env.client.of("sendMessage").length, 0, "排空不得在被动发送期间主动补发");
  release();
  assert.equal((await p).status, "sent");
  assert.equal(env.bridge.activeWaits.has("a1"), false);
  assert.ok(existsSync(join(env.paths.sent, "a1.json")));
});

// ---------------------------------------------------------------- Bug 5
test("bug5: 被动回复文本成功、文件临时失败 → 排空只补发文件，不重发文本", async () => {
  const env = await makeEnv();
  const f = join(env.paths.outgoing, "report.pdf");
  await writeFile(f, "PDF");
  await writeOutbox(env, "b1", { chatId: "owner", text: "报告如下", file: f });
  env.client.failNext("uploadMedia", new Error("Reply ack timeout (5000ms)"));
  const res = await env.bridge.deliverReply(textFrame("b1", "owner", "给我报告"), "b1", "owner");
  assert.equal(res.status, "retry");
  assert.equal(env.client.of("replyStream").length, 1);
  assert.ok(existsSync(join(env.paths.outbox, "b1.json")), "留在 outbox 等排空");
  const r = await env.bridge.drain();
  assert.deepEqual(r?.sent, ["b1"]);
  const pro = env.client.of("sendMessage").map((c) => (c.args[1] as any).msgtype);
  assert.deepEqual(pro, ["file"], "排空只发文件，原实现会把文本再主动发一遍");
  assert.ok(existsSync(join(env.paths.sent, "b1.json")));
});

// ---------------------------------------------------------------- Bug 6
test("bug6: 超时后迟到的回复不会被主动补发（墓碑 → expired/）", async () => {
  const env = await makeEnv({ replyTimeoutMs: 80 });
  const res = await env.bridge.deliverReply(textFrame("c1", "owner", "hi"), "c1", "owner");
  assert.equal(res.status, "timeout");
  assert.ok(existsSync(join(env.paths.expired, "c1.tombstone")));
  await writeOutbox(env, "c1", { chatId: "owner", text: "迟到的回复" });
  const r = await env.bridge.drain();
  assert.deepEqual(r?.expired, ["c1"]);
  assert.equal(env.client.of("sendMessage").length, 0, "原实现会把过时回复主动推送出去");
  assert.ok(existsSync(join(env.paths.expired, "c1.json")));
  assert.equal(existsSync(join(env.paths.outbox, "c1.json")), false);
});

// ---------------------------------------------------------------- Bug 7
test("bug7: 拒绝 secrets.env / ROOT 内非 outgoing 文件（即使 ROOT 在 /tmp 下）", async () => {
  const env = await makeEnv();
  const opts = { root: env.root, allowedRoots: [join(env.root, "outgoing"), "/tmp"] };
  const r1 = await checkOutgoingFile(env.paths.secrets, opts);
  assert.equal(r1.ok, false);
  await mkdir(join(env.root, "private"), { recursive: true });
  await writeFile(join(env.root, "private", "notes.txt"), "x");
  const r2 = await checkOutgoingFile(join(env.root, "private", "notes.txt"), opts);
  assert.equal(r2.ok, false);
  assert.match((r2 as { reason: string }).reason, /outgoing/);
  const r3 = await checkOutgoingFile(join(env.root, "state.json"), opts);
  assert.equal(r3.ok, false);
  const ok = join(env.paths.outgoing, "a.txt");
  await writeFile(ok, "x");
  assert.equal((await checkOutgoingFile(ok, opts)).ok, true);
});

test("bug7: 符号链接绕过被拒（realpath 后判断）", async () => {
  const env = await makeEnv();
  const opts = { root: env.root, allowedRoots: [env.paths.outgoing] };
  const link1 = join(env.paths.outgoing, "innocent.txt");
  await symlink(env.paths.secrets, link1);
  assert.equal((await checkOutgoingFile(link1, opts)).ok, false, "指向 secrets.env 的链接");
  await mkdir(join(env.root, "private"), { recursive: true });
  await writeFile(join(env.root, "private", "data.txt"), "x");
  const link2 = join(env.paths.outgoing, "data.txt");
  await symlink(join(env.root, "private", "data.txt"), link2);
  assert.equal((await checkOutgoingFile(link2, opts)).ok, false, "指向允许根之外的链接");
});

test("bug7: 敏感文件名一律拒绝（*.env、id_rsa、config.json…）", async () => {
  const env = await makeEnv();
  const opts = { root: env.root, allowedRoots: [env.paths.outgoing] };
  for (const name of ["prod.env", ".env.local", "secrets.txt", "id_rsa", "id_ed25519.pub", "config.json", "heartbeat.json", "server.pem"]) {
    const p = join(env.paths.outgoing, name);
    await writeFile(p, "x");
    assert.equal((await checkOutgoingFile(p, opts)).ok, false, name);
  }
});

test("bug7: images 走同一校验，secrets 路径被跳过", async () => {
  const env = await makeEnv();
  const png = join(env.paths.outgoing, "ok.png");
  await writeFile(png, "PNGDATA");
  const sneaky = join(env.paths.outgoing, "x.png");
  await symlink(env.paths.secrets, sneaky);
  await writeOutbox(env, "i1", { chatId: "owner", text: "", images: [png, sneaky, env.paths.secrets] });
  const res = await env.bridge.deliverReply(textFrame("i1", "owner", "图"), "i1", "owner");
  assert.equal(res.status, "sent");
  const calls = env.client.of("replyStreamWithCard");
  assert.equal(calls.length, 1);
  const items = (calls[0].args[4] as any).msgItem;
  assert.equal(items.length, 1, "只有 ok.png");
  assert.equal(Buffer.from(items[0].image.base64, "base64").toString(), "PNGDATA");
});

// ---------------------------------------------------------------- Bug 8
test("bug8: 白名单为空 → 配置校验失败（fail-closed）；allowAll:true 显式放开", () => {
  assert.ok(validateConfig({}).errors.length > 0);
  assert.ok(validateConfig({ allowedUserIds: [] }).errors.length > 0);
  assert.deepEqual(validateConfig({ allowedUserIds: ["u1"] }).errors, []);
  assert.deepEqual(validateConfig({ allowAll: true }).errors, []);
  assert.equal(makeIsAllowed({})("anyone"), false, "原实现：空列表 = 对所有人开放");
  assert.equal(makeIsAllowed({ allowAll: true })("anyone"), true);
  assert.equal(makeIsAllowed({ allowedUserIds: ["u1"], allowAll: true })("u2"), false, "列表非空时以列表为准");
});

test("bug8: daemon / check-config 在白名单为空时拒绝启动（不连网）", async () => {
  const env = await makeEnv();
  await writeFile(env.paths.config, JSON.stringify({ allowedUserIds: [] }));
  const daemon = join(REPO, "dist", "daemon.js");
  for (const args of [["--check-config"], []]) {
    const r = spawnSync(process.execPath, [daemon, ...args], {
      env: { ...process.env, MUSE_WECOM_ROOT: env.root },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(r.status, 2, `args=${args.join(" ")} stderr=${r.stderr}`);
    assert.match(r.stderr, /白名单为空/);
  }
  assert.equal(existsSync(env.paths.pid), false, "未写 pid 文件 → 没走到建连");
});

test("bug8: 非白名单用户的文本不入 inbox", async () => {
  const env = await makeEnv({ config: {} });
  await env.bridge.handleText(textFrame("x1", "stranger", "hello"));
  assert.deepEqual(await ls(env.paths.inbox), []);
  const reply = env.client.of("replyStream")[0];
  assert.match(String(reply.args[2]), /只服务它的主人/);
});
