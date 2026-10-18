/** 0.3.5 回归测试：hook 自动定位桥接目录（M1）、群卡片去重带点击人（M2）、非主人硬约束（H1）、L1~L6。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, copyFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge, messageIdOf } from "../bridge.js";
import { isSafeMessageId } from "../muse-backend.js";
import { CardEventDedupe, MessageRoutes } from "../state.js";
import { makeEnv, frame, textFrame, waitFor, writeOutbox, sleep, readJson, type Env } from "./helpers.js";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const HOOK = join(REPO, "hooks", "wecom-inbox-watch.sh");
const KA = join(REPO, "keepalive.sh");

async function inboxItems(env: Env): Promise<any[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out = [];
  for (const n of (await readdir(env.paths.inbox)).sort()) {
    if (n.endsWith(".json") || n.endsWith(".json.claimed")) out.push(JSON.parse(await readFile(join(env.paths.inbox, n), "utf8")));
  }
  return out;
}

const cardClick = (from: string, extra: Record<string, unknown> = {}) =>
  frame({
    chatid: "g1",
    chattype: "group",
    from: { userid: from },
    event: { eventtype: "template_card_event", template_card_event: { event_key: "approve", task_id: "t1" } },
    ...extra,
  });

// ---------------------------------------------------------------- M2 / L1

test("M2: 群里不同成员点同一按钮各自入队（去重键带点击人）；同一人重复点仍只入队一次；单聊不变", async () => {
  const env = await makeEnv({ config: { allowedUserIds: ["owner"], allowedChatIds: ["g1"] } });
  await env.bridge.onCardEvent(cardClick("alice", { msgid: "e1" }));
  await env.bridge.onCardEvent(cardClick("bob", { msgid: "e2" }));
  await env.bridge.onCardEvent(cardClick("bob", { msgid: "e3" }));
  const items = (await inboxItems(env)).filter((x) => x.type === "card_event");
  assert.deepEqual(items.map((x) => x.senderUserId).sort(), ["alice", "bob"], "bob 的点击不再被 alice 的吞掉；bob 自己的重复点击去重");
  assert.equal(env.client.of("updateTemplateCard").length, 3, "卡片照样每次更新");
  // 单聊：键仍是会话键（= userid），重复点去重
  const single = (msgid: string) =>
    frame({ msgid, chattype: "single", from: { userid: "owner" }, event: { template_card_event: { event_key: "x", task_id: "t2" } } });
  await env.bridge.onCardEvent(single("s1"));
  await env.bridge.onCardEvent(single("s2"));
  assert.equal((await inboxItems(env)).filter((x) => x.taskId === "t2").length, 1);
});

test("L1: 回调没有 msgid、去重 TTL 已过时，新 messageId 不会撞上还在处理中（已认领 / outbox / inflight）的那一轮", async () => {
  const env = await makeEnv({ config: { allowedUserIds: ["owner"] } });
  let now = 1_000_000;
  const cardEvents = new CardEventDedupe(null, 10, () => now);
  const bridge = createBridge({ ...env, config: { allowedUserIds: ["owner"] }, log: () => undefined, cardEvents });
  const click = () =>
    frame({ chattype: "single", from: { userid: "owner" }, event: { template_card_event: { event_key: "go", task_id: "t9" } } });
  const ids: string[] = [];
  const takeNew = async () => {
    const before = new Set(await readdir(env.paths.inbox));
    await bridge.onCardEvent(click());
    const added = (await readdir(env.paths.inbox)).filter((n) => !before.has(n));
    assert.equal(added.length, 1);
    return added[0].replace(/\.json$/, "");
  };
  ids.push(await takeNew());
  // 1) hook 已认领、worker 还在跑
  await import("node:fs/promises").then((fs) => fs.rename(join(env.paths.inbox, `${ids[0]}.json`), join(env.paths.inbox, `${ids[0]}.json.claimed`)));
  now += 100;
  ids.push(await takeNew());
  assert.notEqual(ids[1], ids[0], "认领中的那一轮不被复用（以前会得到同一个 id，mv 覆盖 .claimed）");
  // 2) 回复已写进 outbox、还没排空发出
  await rm(join(env.paths.inbox, `${ids[1]}.json`));
  await writeOutbox(env, ids[1], { chatId: "owner", text: "处理中" });
  now += 100;
  ids.push(await takeNew());
  assert.equal(new Set(ids).size, 3, "outbox 里有回复的也算占用");
});

// ---------------------------------------------------------------- L2

test("L2: msgid 清洗——安全的原样用；含 ../ 等的换成确定性的 m-<hash>，不会写到 ROOT 外，也不会把自己的入队内容当回复回显", async () => {
  assert.equal(messageIdOf("msg_ABC-123@x.y"), "msg_ABC-123@x.y");
  assert.equal(messageIdOf(""), "");
  for (const bad of ["../../escaped", "a/b", "..", ".", ".hidden", "x".repeat(200), "a\\b", "中文"]) {
    const id = messageIdOf(bad);
    assert.match(id, /^m-[0-9a-f]{32}$/, bad);
    assert.equal(messageIdOf(bad), id, "确定性：重复投递照样去重");
    assert.ok(isSafeMessageId(id));
  }
  const env = await makeEnv();
  const escaped = join(env.root, "..", "escaped.json");
  await rm(escaped, { force: true });
  const p = env.bridge.handleText(textFrame("../../escaped", "owner", "hi"));
  const id = messageIdOf("../../escaped");
  await waitFor(() => existsSync(join(env.paths.inbox, `${id}.json`)));
  assert.ok(!existsSync(escaped), "没有写到 ROOT 外");
  await writeOutbox(env, id, { chatId: "owner", text: "真回复" });
  assert.equal((await p)?.status, "sent");
  assert.equal(String(env.client.of("replyStream").at(-1)!.args[2]), "真回复");
  // 兜底：backend.enqueue 直接拒绝不安全的 id
  await assert.rejects(
    env.backend.enqueue({ messageId: "../x", chatId: "owner", chatType: "single", senderUserId: "owner", text: "t", ts: "t", status: "new" }),
    /不安全/,
  );
});

// ---------------------------------------------------------------- H1

test("H1: 入队时 daemon 标记 senderIsOwner（文字、文件、卡片点击）；没有主人且 allowAll 时人人算主人", async () => {
  const env = await makeEnv({ config: { allowedUserIds: ["owner"], allowedChatIds: ["g1"] } });
  const g = (msgid: string, from: string) => textFrame(msgid, from, "hi", { chattype: "group", chatid: "g1" });
  void env.bridge.handleText(g("m1", "owner"));
  void env.bridge.handleText(g("m2", "bob"));
  void env.bridge.handleMedia(
    frame({ msgid: "m3", msgtype: "file", chattype: "group", chatid: "g1", from: { userid: "bob" }, file: { url: "https://x/f" } }),
    "file",
  );
  await env.bridge.onCardEvent(cardClick("bob", { msgid: "e1" }));
  await waitFor(async () => (await inboxItems(env)).length === 4);
  const by = Object.fromEntries((await inboxItems(env)).map((x) => [x.type === "card_event" ? "card" : x.messageId, x.senderIsOwner]));
  assert.deepEqual(by, { m1: true, m2: false, m3: false, card: false });
  const routes = new MessageRoutes(env.paths.routes);
  await waitFor(() => existsSync(env.paths.routes));
  routes.loadSync();
  assert.deepEqual({ ...routes.get("m2"), ts: 0 }, { chatId: "g1", chatType: "group", senderUserId: "bob", senderIsOwner: false, ts: 0 }, "来源会话持久化");

  const open = await makeEnv({ config: { allowAll: true } });
  void open.bridge.handleText(textFrame("o1", "anyone", "hi"));
  await waitFor(() => existsSync(join(open.paths.inbox, "o1.json")));
  assert.equal((await readJson(join(open.paths.inbox, "o1.json"))).senderIsOwner, true);
});

test("H1: 排空主动推送校验 chatId——非主人发起的只能回原会话；主人发起的可发主人私聊/授权群；proactive-* 只能发主人私聊或授权群", async () => {
  const env = await makeEnv({ config: { allowedUserIds: ["owner"], allowedChatIds: ["g1"] } });
  // bob 在授权群点卡片（卡片事件没有等待方，回复走排空）
  await env.bridge.onCardEvent(cardClick("bob", { msgid: "e1" }));
  await env.bridge.onCardEvent(cardClick("owner", { msgid: "e2" }));
  const items = (await inboxItems(env)).filter((x) => x.type === "card_event");
  const bobId = items.find((x) => x.senderUserId === "bob").messageId;
  const ownerId = items.find((x) => x.senderUserId === "owner").messageId;

  await writeOutbox(env, bobId, { chatId: "owner", text: "以机器人身份私信主人" });
  await writeOutbox(env, ownerId, { chatId: "owner", text: "主人要求转到自己私聊" });
  await writeOutbox(env, "proactive-1", { chatId: "owner", text: "早报" });
  await writeOutbox(env, "proactive-2", { chatId: "stranger", text: "发给陌生人" });
  await writeOutbox(env, "proactive-3", { chatId: "g1", text: "发到授权群" });
  await writeOutbox(env, "proactive-4", { chatId: "g9", text: "发到没授权的群" });
  const rep = await env.bridge.drain();
  assert.deepEqual(rep?.failed.sort(), [bobId, "proactive-2", "proactive-4"].sort());
  assert.deepEqual(rep?.sent.sort(), [ownerId, "proactive-1", "proactive-3"].sort());
  const sentTo = env.client.of("sendMessage").map((c) => c.args[0]);
  assert.ok(!sentTo.includes("stranger") && !sentTo.includes("g9"));
  assert.equal(sentTo.filter((x) => x === "owner").length, 2, "bob 那条没发到主人私聊");
  assert.match((await readJson(join(env.paths.failed, `${bobId}.reason.json`))).reason, /非主人发起的消息只能回到原会话/);
  assert.ok(env.logs.some((l) => l.event === "daemon.drain_route_rejected" && l.data.msgid === bobId));

  // 写回原会话照常发出
  await env.bridge.onCardEvent(cardClick("bob", { msgid: "e3", event: { template_card_event: { event_key: "other", task_id: "t1" } } }));
  const bob2 = (await inboxItems(env)).find((x) => x.eventKey === "other").messageId;
  await writeOutbox(env, bob2, { chatId: "g1", text: "回到群里" });
  assert.deepEqual((await env.bridge.drain())?.sent, [bob2]);
});

test("H1: daemon 重启后来源表从 routes.json 读回，排空照样校验（被动回复没发成、转排空的情况）", async () => {
  const env = await makeEnv({ config: { allowedUserIds: ["owner"], allowedChatIds: ["g1"] } });
  await env.bridge.routes.record("m9", { chatId: "g1", chatType: "group", senderUserId: "bob", senderIsOwner: false });
  await env.bridge.routes.record("m10", { chatId: "g1", chatType: "group", senderUserId: "bob", senderIsOwner: false });
  // 模拟重启：新 bridge 从磁盘读来源表
  const fresh = createBridge({ ...env, config: { allowedUserIds: ["owner"], allowedChatIds: ["g1"] }, log: () => undefined, cardEvents: new CardEventDedupe(null) });
  await writeOutbox(env, "m9", { chatId: "owner", text: "偷偷私信主人" });
  await writeOutbox(env, "m10", { chatId: "g1", text: "回到原群" });
  const rep = await fresh.drain();
  assert.deepEqual(rep?.failed, ["m9"]);
  assert.deepEqual(rep?.sent, ["m10"]);
});

// ---------------------------------------------------------------- L6

test("L6: 白名单外的人点赞不写 feedback_raw/，白名单内照常记录", async () => {
  const env = await makeEnv();
  const fb = (from: string) => frame({ chattype: "single", from: { userid: from }, event: { feedback_event: { id: "f", type: 1 } } });
  await env.bridge.onFeedback(fb("stranger"));
  assert.deepEqual(await readdir(env.paths.feedbackRaw), []);
  assert.equal(env.client.of("sendMessage").length, 0);
  await env.bridge.onFeedback(fb("owner"));
  assert.equal((await readdir(env.paths.feedbackRaw)).length, 1);
});

// ---------------------------------------------------------------- M1：hook 自动定位桥接目录

async function fakeBridge(dir: string): Promise<void> {
  for (const d of ["inbox", "sent", "expired", "failed", "stop"]) await mkdir(join(dir, d), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "muse-wecom-bridge", version: "0.0.0" }, null, 2));
  await writeFile(join(dir, "keepalive.sh"), "#!/bin/bash\nexit 0\n");
  await writeFile(join(dir, "config.json"), "{}");
}

function runHook(home: string, br: string, env: Record<string, string> = {}, freshHeartbeat = true) {
  const rt = join(home, "rt.sh");
  spawnSync("bash", ["-c", `printf 'silent(){ echo "SILENT: $1"; exit 0; }\\nwake(){ echo "WAKE: $1 $2"; exit 0; }\\n' > "${rt}"`]);
  if (freshHeartbeat && existsSync(br)) {
    spawnSync("bash", ["-c", `printf '{"ts":%s,"connected":true}' "$(($(date +%s)*1000))" > "${br}/heartbeat.json"`]);
  }
  const base: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete base.MUSE_WECOM_ROOT;
  delete base.NODE_BIN;
  return spawnSync("bash", [HOOK], { env: { ...base, HOME: home, HATCH_HOOK_RUNTIME: rt, ...env }, encoding: "utf8" });
}

function wakePayload(out: string): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  const m = /^WAKE: \S+ inbox 有 \d+ 条待处理消息 (\{.*\})$/m.exec(out) || /^WAKE: .*? (\{.*\})$/m.exec(out);
  assert.ok(m, out);
  return JSON.parse(m![1]);
}

test("M1: hook 自动定位——默认目录；$HOME 下 3 层内唯一副本（并缓存）；MUSE_WECOM_ROOT 优先；多份时退回默认并提示；wake payload 带 bridge_root", async () => {
  // 1) 默认目录
  let home = await mkdtemp(join(tmpdir(), "mwb-m1-"));
  let br = join(home, "workspace", "muse-wecom-bridge");
  await fakeBridge(br);
  await writeFile(join(br, "inbox", "a1.json"), JSON.stringify({ messageId: "a1", chatId: "u1", text: "hi", ts: "t" }));
  let r = runHook(home, br);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(wakePayload(r.stdout).bridge_root, br);
  assert.ok(existsSync(join(br, "inbox", "a1.json.claimed")));

  // 2) 装在别处（唯一副本）
  home = await mkdtemp(join(tmpdir(), "mwb-m1-"));
  br = join(home, "apps", "wecom");
  await fakeBridge(br);
  await writeFile(join(br, "inbox", "b1.json"), JSON.stringify({ messageId: "b1", chatId: "u1", text: "hi", ts: "t" }));
  r = runHook(home, br);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(wakePayload(r.stdout).bridge_root, br, "找到 $HOME 下唯一的副本");
  assert.equal((await readFile(join(home, "hooks", "state", ".wecom-bridge-root"), "utf8")).trim(), br, "结果缓存");

  // 3) 多份：退回默认并在 stderr 提示
  await fakeBridge(join(home, "other", "wecom2"));
  await rm(join(home, "hooks", "state", ".wecom-bridge-root"));
  r = runHook(home, br);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /找到多份 muse-wecom-bridge，退回默认/);

  // 4) MUSE_WECOM_ROOT 优先（多份时也能指定）
  await writeFile(join(br, "inbox", "b2.json"), JSON.stringify({ messageId: "b2", chatId: "u1", text: "hi", ts: "t" }));
  r = runHook(home, br, { MUSE_WECOM_ROOT: br });
  assert.equal(r.status, 0, r.stderr);
  const pl = wakePayload(r.stdout);
  assert.equal(pl.bridge_root, br);
  assert.deepEqual(pl.message_ids, ["b2"]);
});

test("M1/L4: 健康告警的 payload 也带 bridge_root；兜底拉起 keepalive 时带 NODE_BIN（PATH 里没有就读 .node-bin）和 MUSE_WECOM_ROOT", async () => {
  const home = await mkdtemp(join(tmpdir(), "mwb-m1h-"));
  const br = join(home, "workspace", "muse-wecom-bridge");
  await fakeBridge(br);
  const got = join(home, "ka-env.txt");
  await writeFile(join(br, "keepalive.sh"), `#!/bin/bash\necho "NODE_BIN=$NODE_BIN ROOT=$MUSE_WECOM_ROOT" > ${JSON.stringify(got)}\n`);
  await writeFile(join(br, ".node-bin"), "/opt/fake-nvm/bin/node\n");
  await writeFile(join(br, "heartbeat.json"), JSON.stringify({ ts: Date.now() - 3600_000, connected: true }));
  // PATH 里只放 hook 需要的工具、不放 node
  const bin = join(home, "bin");
  await mkdir(bin);
  for (const tool of ["jq", "python3", "find", "date", "stat", "touch", "mkdir", "mv", "rm", "cat", "grep", "dirname", "wc", "tr", "setsid", "flock", "bash", "sed", "head", "printf", "mktemp", "env"]) {
    const w = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (w && w.startsWith("/")) spawnSync("ln", ["-s", w, join(bin, tool)]);
  }
  const r = runHook(home, br, { PATH: bin }, false);
  assert.equal(r.status, 0, r.stderr);
  const pl = wakePayload(r.stdout);
  assert.ok(pl.health_issue);
  assert.equal(pl.bridge_root, br);
  await waitFor(() => existsSync(got), 3000);
  assert.equal((await readFile(got, "utf8")).trim(), `NODE_BIN=/opt/fake-nvm/bin/node ROOT=${br}`);
});

// ---------------------------------------------------------------- L3 / L4：keepalive 与纯数据目录

test("L3/L4: keepalive——MUSE_WECOM_ROOT 是纯数据目录时用本仓库的 daemon.js；--install-cron 写本仓库脚本 + MUSE_WECOM_ROOT，并记下 .node-bin / .keepalive-path", async () => {
  const data = await mkdtemp(join(tmpdir(), "mwb-data-"));
  const sh = spawnSync("bash", ["-c", `source ${JSON.stringify(KA)}; echo "$DAEMON_JS"`], {
    env: { ...process.env, MUSE_WECOM_ROOT: data },
    encoding: "utf8",
  });
  assert.equal(sh.stdout.trim(), join(REPO, "dist", "daemon.js"), "数据目录里没有 dist/daemon.js：用代码目录的");
  // ROOT 是完整副本（有 dist/daemon.js）时仍用 ROOT 里的
  const full = await mkdtemp(join(tmpdir(), "mwb-full-"));
  await mkdir(join(full, "dist"));
  await writeFile(join(full, "dist", "daemon.js"), "");
  assert.equal(
    spawnSync("bash", ["-c", `source ${JSON.stringify(KA)}; echo "$DAEMON_JS"`], { env: { ...process.env, MUSE_WECOM_ROOT: full }, encoding: "utf8" }).stdout.trim(),
    join(full, "dist", "daemon.js"),
  );

  // 假 crontab
  const bin = await mkdtemp(join(tmpdir(), "mwb-cron-"));
  const tab = join(bin, "tab");
  await writeFile(tab, "");
  await writeFile(join(bin, "crontab"), `#!/bin/bash\nif [ "$1" = "-l" ]; then cat ${JSON.stringify(tab)}; else cat > ${JSON.stringify(tab)}; fi\n`);
  await chmod(join(bin, "crontab"), 0o755);
  const env = { ...process.env, MUSE_WECOM_ROOT: data, NODE_BIN: process.execPath, PATH: `${bin}:${process.env.PATH}` };
  const r = spawnSync("bash", [KA, "--install-cron"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = (await readFile(tab, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.ok(l.includes(`MUSE_WECOM_ROOT=${data}`), l);
    assert.ok(l.includes(`/bin/bash ${join(REPO, "keepalive.sh")}`), l);
    assert.ok(l.includes(`NODE_BIN=${process.execPath}`), l);
  }
  assert.equal((await readFile(join(data, ".node-bin"), "utf8")).trim(), process.execPath);
  assert.equal((await readFile(join(data, ".keepalive-path"), "utf8")).trim(), join(REPO, "keepalive.sh"));
  // 幂等 + 卸载
  spawnSync("bash", [KA, "--install-cron"], { env, encoding: "utf8" });
  assert.equal((await readFile(tab, "utf8")).trim().split("\n").length, 2);
  spawnSync("bash", [KA, "--uninstall-cron"], { env, encoding: "utf8" });
  assert.equal((await readFile(tab, "utf8")).trim(), "");
  // 默认（ROOT = 脚本目录）的 cron 条目不带 MUSE_WECOM_ROOT（与以前一致）
  const copy = await mkdtemp(join(tmpdir(), "mwb-kacopy-"));
  await copyFile(KA, join(copy, "keepalive.sh"));
  const env2 = { ...process.env, NODE_BIN: process.execPath, PATH: `${bin}:${process.env.PATH}` };
  delete (env2 as Record<string, string | undefined>).MUSE_WECOM_ROOT;
  assert.equal(spawnSync("bash", [join(copy, "keepalive.sh"), "--install-cron"], { env: env2, encoding: "utf8" }).status, 0);
  assert.ok(!(await readFile(tab, "utf8")).includes("MUSE_WECOM_ROOT="));
  await sleep(0);
});

test("0.3.5: 脚本语法检查（bash -n hook / keepalive / doctor）", () => {
  for (const f of [HOOK, KA, join(REPO, "doctor.sh")]) {
    const r = spawnSync("bash", ["-n", f], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});
