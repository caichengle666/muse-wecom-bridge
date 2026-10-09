import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync, copyFileSync, chmodSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, frame, textFrame, writeOutbox, waitFor, ls, readJson, sleep } from "./helpers.js";
import { chunkByBytes } from "../chunk.js";
import { CardRegistry, livePeerDaemon, writePidFile } from "../state.js";
import { readStartTime } from "../proc.js";

/** 0.2.1 pid 文件格式：`<pid> <starttime> <token>` */
function idLine(pid: number, token = "tok12345abcdef"): string {
  return `${pid} ${readStartTime(pid)} ${token}\n`;
}

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");

// ---------------------------------------------------------------- Bug 9
test("bug9: 长文本拆成多条独立流式消息（各自 streamId、finish=true，feedback 只在第一条）", async () => {
  const env = await makeEnv();
  const text = "中".repeat(15000); // 45000 字节
  await writeOutbox(env, "s1", { chatId: "owner", text });
  const res = await env.bridge.deliverReply(textFrame("s1", "owner", "长文"), "s1", "owner");
  assert.equal(res.status, "sent");
  const calls = env.client.of("replyStream");
  assert.equal(calls.length, 3);
  const ids = new Set(calls.map((c) => c.args[1]));
  assert.equal(ids.size, 3, "原实现共用一个 streamId，覆盖语义下只显示最后一块");
  for (const c of calls) {
    assert.equal(c.args[3], true, "每条 finish=true");
    assert.ok(Buffer.byteLength(String(c.args[2])) <= 20000);
  }
  assert.ok(calls[0].args[5], "第一条带 feedback");
  assert.equal(calls[1].args[5], undefined);
  assert.equal(calls.map((c) => c.args[2]).join(""), text);
});

test("bug9: chunkByBytes 不切断多字节字符且每段 ≤ 上限", () => {
  const s = "a😀中".repeat(5000);
  const parts = chunkByBytes(s, 20000);
  assert.equal(parts.join(""), s);
  for (const p of parts) assert.ok(Buffer.byteLength(p) <= 20000);
  assert.deepEqual(chunkByBytes(""), []);
});

// ---------------------------------------------------------------- Bug 10 (keepalive)
function setupKeepaliveRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "mwb-ka-")).then(async (root) => {
    copyFileSync(join(REPO, "keepalive.sh"), join(root, "keepalive.sh"));
    chmodSync(join(root, "keepalive.sh"), 0o755);
    await mkdir(join(root, "dist"), { recursive: true });
    return root;
  });
}

function fakeDaemon(root: string): ChildProcess {
  // 命令行含 dist/daemon.js、cwd=ROOT——模拟 `npm start`（相对路径）启动的 daemon
  return spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "dist/daemon.js"], { cwd: root, stdio: "ignore" });
}

function kaStatus(root: string, extraEnv: Record<string, string> = {}): number {
  const r = spawnSync("bash", [join(root, "keepalive.sh"), "--status"], {
    env: { ...process.env, MUSE_WECOM_START_GRACE_SEC: "0", MUSE_WECOM_GRACE_SEC: "0", MUSE_WECOM_STALE_SEC: "90", ...extraEnv },
    encoding: "utf8",
  });
  return r.status ?? -1;
}

test("bug10: keepalive 以脚本目录为 ROOT、靠 pid 文件 + /proc 识别相对路径启动的 daemon", async (t) => {
  if (!existsSync("/proc/self/cmdline")) return t.skip("需要 /proc");
  const root = await setupKeepaliveRoot();
  const child = fakeDaemon(root);
  try {
    await sleep(200);
    const pid = child.pid!;
    assert.equal(kaStatus(root), 1, "没有 pid 文件 → 不健康");
    await writeFile(join(root, "daemon.pid"), idLine(pid));
    const now = Date.now();
    await writeFile(join(root, "heartbeat.json"), JSON.stringify({ pid, ts: now, connected: true, token: "tok12345abcdef" }));
    assert.equal(kaStatus(root), 0, "pid 匹配 + connected:true + 新鲜 → 健康（原 pgrep 模式匹配不上 muse-wecom-bridge）");
    // 也可用 MUSE_WECOM_ROOT 覆盖
    assert.equal(spawnSync("bash", [join(REPO, "keepalive.sh"), "--status"], {
      env: { ...process.env, MUSE_WECOM_ROOT: root, MUSE_WECOM_START_GRACE_SEC: "0" },
    }).status, 0);
  } finally {
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("bug1+10: keepalive 把 connected:false（超宽限）/ 心跳停滞 / pid 不符 判为不健康", async (t) => {
  if (!existsSync("/proc/self/cmdline")) return t.skip("需要 /proc");
  const root = await setupKeepaliveRoot();
  const child = fakeDaemon(root);
  try {
    await sleep(200);
    const pid = child.pid!;
    await writeFile(join(root, "daemon.pid"), idLine(pid));
    const hb = (o: object) => writeFile(join(root, "heartbeat.json"), JSON.stringify({ token: "tok12345abcdef", ...o }));
    const now = Date.now();
    await hb({ pid, ts: now - 200_000, connected: false });
    assert.equal(kaStatus(root), 1, "被顶号后的僵尸：connected:false 且超过宽限");
    await hb({ pid, ts: now - 10_000, connected: false });
    assert.equal(kaStatus(root, { MUSE_WECOM_GRACE_SEC: "90" }), 0, "刚断线、宽限内（SDK 正在重连）");
    await hb({ pid, ts: now - 200_000, connected: true });
    assert.equal(kaStatus(root), 1, "心跳停滞");
    await hb({ pid: pid + 99999, ts: now, connected: true });
    assert.equal(kaStatus(root), 1, "心跳来自别的进程");
    await writeFile(join(root, "daemon.pid"), idLine(process.pid)); // 活着但不是 daemon.js
    await hb({ pid: process.pid, ts: now, connected: true });
    assert.equal(kaStatus(root), 1, "pid 存活但命令行不是本 ROOT 的 daemon");
  } finally {
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("bug10: keepalive.sh 语法检查（bash -n）", () => {
  const r = spawnSync("bash", ["-n", join(REPO, "keepalive.sh")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("bug10: livePeerDaemon 识别同 ROOT 已在运行的 daemon（防双开顶号）", async (t) => {
  if (!existsSync("/proc/self/cmdline")) return t.skip("需要 /proc");
  const root = await mkdtemp(join(tmpdir(), "mwb-pid-"));
  const child = fakeDaemon(root);
  try {
    await sleep(200);
    const pidPath = join(root, "daemon.pid");
    assert.equal(livePeerDaemon(pidPath), null);
    await writePidFile(pidPath, { pid: child.pid!, starttime: readStartTime(child.pid!)!, token: "tok12345abcdef" });
    assert.equal(livePeerDaemon(pidPath), child.pid);
    await writePidFile(pidPath, { pid: child.pid!, starttime: "1", token: "tok12345abcdef" });
    assert.equal(livePeerDaemon(pidPath), null, "starttime 不符（pid 复用）不算");
    await writePidFile(pidPath, { pid: process.pid, starttime: readStartTime(process.pid)!, token: "tok12345abcdef" });
    assert.equal(livePeerDaemon(pidPath), null, "自己不算");
  } finally {
    child.kill();
  }
});

// ---------------------------------------------------------------- Bug 11
test("bug11: 非演示按钮 → 同 card_type 的『已收到』卡片 + inbox card_event", async () => {
  const env = await makeEnv();
  const card = {
    card_type: "vote_interaction",
    task_id: "task-v1",
    main_title: { title: "投票" },
    checkbox: { question_key: "q", option_list: [{ id: "a", text: "A" }] },
    submit_button: { text: "提交", key: "vote_submit" },
  };
  await writeOutbox(env, "k1", { chatId: "owner", text: "", card });
  await env.bridge.deliverReply(textFrame("k1", "owner", "发个投票"), "k1", "owner");
  assert.equal(env.client.of("replyTemplateCard").length, 1);

  await env.bridge.onCardEvent(
    frame({
      msgid: "ev1",
      chattype: "single",
      from: { userid: "owner" },
      event: { eventtype: "template_card_event", template_card_event: { event_key: "vote_submit", task_id: "task-v1" } },
    }),
  );
  const up = env.client.of("updateTemplateCard");
  assert.equal(up.length, 1);
  const updated = up[0].args[1] as any;
  assert.equal(updated.card_type, "vote_interaction", "原实现一律用 button_interaction → 42045");
  assert.equal(updated.task_id, "task-v1");
  assert.ok(updated.checkbox, "保留类型必填字段");
  assert.match(updated.main_title.title, /已收到/);
  const inbox = await ls(env.paths.inbox);
  const ev = inbox.filter((f) => f.startsWith("card-"));
  assert.equal(ev.length, 1, "点击事件交给助手处理");
  const item = await readJson(join(env.paths.inbox, ev[0]));
  assert.equal(item.type, "card_event");
  assert.equal(item.eventKey, "vote_submit");
  assert.equal(item.taskId, "task-v1");
  assert.equal(item.text, "[卡片点击] vote_submit");
  // 重复回调不重复入队
  await env.bridge.onCardEvent(
    frame({ msgid: "ev1", from: { userid: "owner" }, event: { template_card_event: { event_key: "vote_submit", task_id: "task-v1" } } }),
  );
  assert.equal((await ls(env.paths.inbox)).filter((f) => f.startsWith("card-")).length, 1);
});

test("bug11: 演示按钮原地处理、不进 inbox", async () => {
  const env = await makeEnv();
  await env.bridge.onCardEvent(
    frame({ msgid: "ev2", from: { userid: "owner" }, event: { template_card_event: { event_key: "demo_confirm", task_id: "demo-1" } } }),
  );
  const up = env.client.of("updateTemplateCard")[0].args[1] as any;
  assert.equal(up.card_type, "button_interaction");
  assert.equal(up.task_id, "demo-1");
  assert.match(up.main_title.title, /已确认/);
  assert.deepEqual(await ls(env.paths.inbox), []);
});

test("bug11: task_id 回退表按会话键（群聊 chatid）一致登记与查找", async () => {
  const env = await makeEnv();
  // 主动推送到群
  await writeOutbox(env, "g1", { chatId: "GROUP1", text: "", card: { card_type: "button_interaction", task_id: "gt1", button_list: [{ text: "好", key: "ok" }] } });
  await env.bridge.drain();
  assert.equal(env.cards.lastTaskFor("GROUP1"), "gt1");
  // 群里点击：回调没给 task_id
  await env.bridge.onCardEvent(
    frame({ msgid: "ev3", chatid: "GROUP1", chattype: "group", from: { userid: "owner" }, event: { template_card_event: { event_key: "ok" } } }),
  );
  const up = env.client.of("updateTemplateCard")[0].args[1] as any;
  assert.equal(up.task_id, "gt1", "原实现用 from.userid 查、用 chatId 存，群聊永远查不到");
  const reg = new CardRegistry(env.paths.cards);
  await waitFor(() => existsSync(env.paths.cards));
  reg.loadSync();
  assert.equal(reg.get("gt1")?.cardType, "button_interaction", "登记表持久化，重启后仍可用");
});

// ---------------------------------------------------------------- Bug 12
test("bug12: drainOutbox 并发调用互斥（第二次跳过），不会双发", async () => {
  const env = await makeEnv();
  await writeOutbox(env, "d1", { chatId: "owner", text: "一次" });
  const release = env.client.hold("sendMessage");
  const a = env.bridge.drain();
  await waitFor(() => env.client.of("sendMessage").length === 1);
  const b = await env.bridge.drain();
  assert.equal(b?.skipped, true);
  release();
  await a;
  await env.bridge.drain();
  assert.equal(env.client.of("sendMessage").length, 1);
  assert.ok(existsSync(join(env.paths.sent, "d1.json")));
});

// ---------------------------------------------------------------- Bug 13
test("bug13: send-file.mjs 按扩展名识别媒体类型（不再写死 file）", async () => {
  const mod = (await import(join(REPO, "src", "send-file.mjs"))) as { detectMediaType: (f: string) => string };
  assert.equal(mod.detectMediaType("a.MP4"), "video");
  assert.equal(mod.detectMediaType("b.png"), "image");
  assert.equal(mod.detectMediaType("c.mp3"), "voice");
  assert.equal(mod.detectMediaType("d.pdf"), "file");
  const src = readFileSync(join(REPO, "src", "send-file.mjs"), "utf8");
  assert.doesNotMatch(src, /type: "file"/);
  assert.doesNotMatch(src, /sendMediaMessage\(toUserId, "file"/);
});
