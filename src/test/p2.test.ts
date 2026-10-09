import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, frame, textFrame, writeOutbox, ls, readJson } from "./helpers.js";
import { SeenStore } from "../state.js";
import { atomicWriteJson, pruneOldFiles } from "../fsutil.js";
import { RotatingLogger } from "../logger.js";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");

// ---------------------------------------------------------------- Bug 14
test("bug14: SeenStore 并发保存串行化，state.json 始终是完整 JSON，无残留 tmp", async () => {
  const env = await makeEnv();
  const s = new SeenStore(env.paths.state, 50);
  await Promise.all(Array.from({ length: 120 }, (_, i) => s.add(`m${i}`)));
  const data = await readJson(env.paths.state);
  assert.equal(data.seen.length, 50);
  assert.equal(data.seen[49], "m119");
  assert.equal((await ls(env.root)).filter((f) => f.endsWith(".tmp")).length, 0);
  const s2 = new SeenStore(env.paths.state, 50);
  await s2.load();
  assert.ok(s2.has("m119") && !s2.has("m0"));
});

test("bug14: atomicWriteJson 覆盖写不留半截文件（heartbeat/kicked 同用）", async () => {
  const env = await makeEnv();
  const p = join(env.root, "x.json");
  await Promise.all(Array.from({ length: 30 }, (_, i) => atomicWriteJson(p, { i, pad: "x".repeat(10000) })));
  const v = JSON.parse(await readFile(p, "utf8"));
  assert.equal(typeof v.i, "number");
  assert.equal((await ls(env.root)).filter((f) => f.endsWith(".tmp")).length, 0);
});

// ---------------------------------------------------------------- Bug 15
test("bug15: 非白名单用户：空语音 / 图文混排 / 点赞 / 进入会话 都不回", async () => {
  const env = await makeEnv();
  const from = { userid: "stranger" };
  await env.bridge.handleVoice(frame({ msgid: "v1", from, voice: { content: "" } }));
  await env.bridge.handleMixed(frame({ msgid: "x1", from }));
  await env.bridge.onFeedback(frame({ msgid: "f1", from, event: { feedback_event: { id: "a", type: 1 } } }));
  await env.bridge.onEnterChat(frame({ from, event: { eventtype: "enter_chat" } }));
  assert.deepEqual(env.client.calls, [], "原实现对陌生人也回复/欢迎");
  assert.ok(env.logs.filter((l) => l.event === "daemon.blocked_not_allowed").length >= 4);
});

test("bug15: 白名单用户照常收到欢迎语与空语音提示", async () => {
  const env = await makeEnv();
  const from = { userid: "owner" };
  await env.bridge.onEnterChat(frame({ from, event: { eventtype: "enter_chat" } }));
  await env.bridge.handleVoice(frame({ msgid: "v2", from, voice: { content: "" } }));
  await env.bridge.onFeedback(frame({ msgid: "f2", from, event: { feedback_event: { id: "a", type: 1 } } }));
  assert.equal(env.client.of("replyWelcome").length, 1);
  assert.match(String(env.client.of("replyStream")[0].args[2]), /没听清/);
  assert.match((env.client.of("sendMessage")[0].args[1] as any).markdown.content, /👍/);
});

// ---------------------------------------------------------------- Bug 16
test("bug16: debug.log 超过上限轮转为 debug.log.1（只保留 1 份）", async () => {
  const env = await makeEnv();
  const lg = new RotatingLogger(env.paths.debugLog, 2000);
  for (let i = 0; i < 100; i++) lg.fn("e", { i, pad: "x".repeat(50) });
  await lg.flush();
  assert.ok(existsSync(env.paths.debugLog + ".1"));
  assert.equal(existsSync(env.paths.debugLog + ".2"), false);
  assert.ok((await stat(env.paths.debugLog)).size <= 2000);
  const last = (await readFile(env.paths.debugLog, "utf8")).trim().split("\n").pop()!;
  assert.equal(JSON.parse(last).i, 99);
});

test("bug16: 默认不记录消息原文；logMessageText:true 才记", async () => {
  const env = await makeEnv({ replyTimeoutMs: 30 });
  await env.bridge.handleText(textFrame("t1", "owner", "我的银行卡密码是123"));
  const m = env.logs.find((l) => l.event === "daemon.msg")!;
  assert.equal("text" in m.data, false);
  assert.equal(JSON.stringify(env.logs).includes("银行卡"), false);

  const env2 = await makeEnv({ replyTimeoutMs: 30, config: { allowedUserIds: ["owner"], logMessageText: true } });
  await env2.bridge.handleText(textFrame("t2", "owner", "可记录"));
  assert.equal(env2.logs.find((l) => l.event === "daemon.msg")!.data.text, "可记录");
});

test("bug16: 清理 incoming/ feedback_raw/ 7 天、sent/ 30 天前的文件", async () => {
  const env = await makeEnv();
  const DAY = 86400_000;
  const now = Date.now();
  const mk = async (dir: string, name: string, ageDays: number) => {
    const p = join(dir, name);
    await writeFile(p, "x");
    const t = new Date(now - ageDays * DAY);
    await utimes(p, t, t);
  };
  await mk(env.paths.incoming, "old.jpg", 8);
  await mk(env.paths.incoming, "new.jpg", 1);
  await mk(env.paths.feedbackRaw, "old.json", 8);
  await mk(env.paths.sent, "old.json", 31);
  await mk(env.paths.sent, "mid.json", 10);
  const res = await env.bridge.prune(now);
  assert.equal(res.incoming, 1);
  assert.equal(res.feedback_raw, 1);
  assert.equal(res.sent, 1);
  assert.deepEqual(await ls(env.paths.incoming), ["new.jpg"]);
  assert.deepEqual(await ls(env.paths.sent), ["mid.json"]);
  assert.equal(await pruneOldFiles(join(env.root, "nonexistent"), 1), 0);
});

// ---------------------------------------------------------------- Bug 17
test("bug17: 已移除无用的 frames 映射", () => {
  for (const f of ["daemon.ts", "bridge.ts"]) {
    assert.doesNotMatch(readFileSync(join(REPO, "src", f), "utf8"), /\bframes\b/);
  }
});

// ---------------------------------------------------------------- Bug 18
function py(code: string, env: Record<string, string> = {}) {
  return spawnSync("python3", ["-c", code], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env } });
}

test("bug18: 早报按 24 小时窗口、按上海时区比较（与机器本地时区无关）", (t) => {
  if (spawnSync("python3", ["--version"]).status !== 0) return t.skip("无 python3");
  const code = `
import importlib.util, json, sys
from datetime import datetime, timezone
spec = importlib.util.spec_from_file_location("brief", ${JSON.stringify(join(REPO, "src", "wecom-morning-brief.py"))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
now = datetime(2026, 10, 10, 0, 5, tzinfo=timezone.utc)   # = 上海 08:05
items = [
  {"title": "23h前", "published_at": "2026-10-09 09:05:00", "priority": 1},
  {"title": "25h前", "published_at": "2026-10-09 07:05:00", "priority": 9},
  {"title": "坏格式", "published_at": "x"},
]
print(json.dumps({"titles": [i["title"] for i in m.filter_fresh(items, now)], "root": str(m.ROOT), "text": m.build_text([], now)}, ensure_ascii=False))
`;
  const r = py(code, { TZ: "UTC", MUSE_WECOM_ROOT: "" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.titles, ["23h前"], "原实现用 26 小时且按本地（UTC）时间比较，会混入 25 小时前的资讯");
  assert.equal(out.root, REPO, "默认 ROOT = 脚本所在目录的上一级");
  assert.match(out.text, /10月10日/);
  assert.match(out.text, /过去 24 小时/);
  const r2 = py(code, { MUSE_WECOM_ROOT: "/srv/mw" });
  assert.equal(JSON.parse(r2.stdout).root, "/srv/mw");
});

test("bug18: brief 语法检查（py_compile）", (t) => {
  if (spawnSync("python3", ["--version"]).status !== 0) return t.skip("无 python3");
  const r = py(`p=${JSON.stringify(join(REPO, "src", "wecom-morning-brief.py"))}; compile(open(p, encoding="utf-8").read(), p, "exec")`);
  assert.equal(r.status, 0, r.stderr);
});

// ---------------------------------------------------------------- Bug 19
test("bug19: .gitignore 覆盖运行时状态文件，且不再误忽略 secrets.env.example", () => {
  const gi = readFileSync(join(REPO, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
  for (const e of ["state.json", "daemon.pid", "failed/", "expired/", "debug.log.*", "progress/", "cards.json"]) {
    assert.ok(gi.includes(e), e);
  }
  assert.equal(gi.includes("secrets.env.example"), false);
  if (spawnSync("git", ["--version"]).status === 0 && existsSync(join(REPO, ".git"))) {
    const r = spawnSync("git", ["check-ignore", "-q", "secrets.env.example"], { cwd: REPO });
    assert.notEqual(r.status, 0, "secrets.env.example 应被提交");
    const r2 = spawnSync("git", ["check-ignore", "-q", "secrets.env"], { cwd: REPO });
    assert.equal(r2.status, 0, "secrets.env 必须被忽略");
  }
});

// ---------------------------------------------------------------- 其它：图片总量上限 & ack
test("images: base64 合计超过上限的图片被跳过并记日志", async () => {
  const env = await makeEnv();
  const a = join(env.paths.outgoing, "a.png");
  const b = join(env.paths.outgoing, "b.png");
  await writeFile(a, Buffer.alloc(6 * 1024 * 1024));
  await writeFile(b, Buffer.alloc(6 * 1024 * 1024));
  await writeOutbox(env, "im", { chatId: "owner", text: "", images: [a, b] });
  await env.bridge.deliverReply(textFrame("im", "owner", "图"), "im", "owner");
  const items = (env.client.of("replyStreamWithCard")[0].args[4] as any).msgItem;
  assert.equal(items.length, 1);
  assert.ok(env.logs.some((l) => l.event === "daemon.images_skipped" && /总量/.test(String(l.data.reason))));
});

test("ack: 回复迟迟不来时先发『收到，正在处理』，随后正式回复照常发出", async () => {
  const env = await makeEnv({ ackDelayMs: 20, replyTimeoutMs: 2000 });
  const p = env.bridge.handleText(textFrame("ak", "owner", "慢慢来"));
  await new Promise((r) => setTimeout(r, 80));
  await writeOutbox(env, "ak", { chatId: "owner", text: "好了" });
  const res = await p;
  assert.equal(res?.status, "sent");
  const contents = env.client.of("replyStream").map((c) => c.args[2]);
  assert.deepEqual(contents, ["收到，正在处理，稍等…", "好了"]);
});
