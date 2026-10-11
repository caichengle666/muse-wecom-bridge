/** 授权群（allowedChatIds）：判定规则、配置校验、/授权本群 /取消授权本群。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeIsAllowed, validateConfig, type BridgeConfig } from "../config.js";
import { groupBindCommand } from "../bridge.js";
import { makeEnv, frame, textFrame, waitFor, writeOutbox, type Env } from "./helpers.js";

const group = (msgid: string, from: string, text: string, chatid = "g1") => textFrame(msgid, from, text, { chattype: "group", chatid });
const lastReply = (env: Env) => String(env.client.of("replyStream").at(-1)!.args[2]);
const disk = async (env: Env) => JSON.parse(await readFile(env.paths.config, "utf8"));

/** 放行的消息会进 inbox 并等回复：写一条 outbox 让它收尾 */
async function passes(env: Env, f: ReturnType<typeof textFrame>): Promise<void> {
  const id = String(f.body.msgid);
  const p = env.bridge.handleText(f);
  await waitFor(() => existsSync(join(env.paths.inbox, `${id}.json`)));
  await writeOutbox(env, id, { chatId: String(f.body.chatid || f.body.from.userid), text: "ok" });
  assert.equal((await p)?.status, "sent");
}

async function blockedText(env: Env, f: ReturnType<typeof textFrame>): Promise<void> {
  assert.equal(await env.bridge.handleText(f), null);
  assert.ok(!existsSync(join(env.paths.inbox, `${f.body.msgid}.json`)));
  assert.match(lastReply(env), /只服务它的主人/);
}

test("授权群：判定规则——主人照旧；授权群里任何人；私聊和别的群不受影响；没有主人时不生效", () => {
  const ok = makeIsAllowed({ allowedUserIds: ["owner"], allowedChatIds: ["g1", " g2 "] });
  assert.ok(ok("owner", "single", "owner"));
  assert.ok(ok("owner", "group", "g9"));
  assert.ok(ok("bob", "group", "g1"));
  assert.ok(ok("bob", "group", "g2"), "首尾空白去掉");
  assert.ok(!ok("bob", "single", "bob"), "私聊不受影响");
  assert.ok(!ok("bob", "single", "g1"), "只认群聊");
  assert.ok(!ok("bob", "group", "g3"), "别的群不受影响");
  assert.ok(!makeIsAllowed({ allowedChatIds: ["g1"], pairCode: "ABCDEFGH" })("bob", "group", "g1"), "没有主人时授权群不生效");
});

test("授权群：配置校验——非空字符串、不能只有群没有主人、配对中给警告", () => {
  assert.deepEqual(validateConfig({ allowedUserIds: ["owner"], allowedChatIds: ["g1"] }).errors, []);
  assert.deepEqual(validateConfig({ allowedUserIds: ["owner"], allowedChatIds: [] }).errors, []);
  for (const bad of [[""], ["  "], [1], "g1"] as unknown[]) {
    assert.match(validateConfig({ allowedUserIds: ["owner"], allowedChatIds: bad } as BridgeConfig).errors.join(), /allowedChatIds 必须是非空字符串数组/);
  }
  assert.match(validateConfig({ allowedUserIds: ["owner"], allowedChatIds: [" g1"] }).errors.join(), /前后有空格/);
  assert.match(validateConfig({ allowedChatIds: ["g1"] }).errors.join(), /还必须有主人/);
  const pairing = validateConfig({ allowedChatIds: ["g1"], pairCode: "ABCDEFGH" });
  assert.deepEqual(pairing.errors, []);
  assert.match(pairing.warnings.join(), /配对完成前 allowedChatIds 不生效/);
});

test("授权命令解析：中英文、可带 @机器人；句子里顺带提到不算", () => {
  assert.equal(groupBindCommand("/授权本群"), "allow");
  assert.equal(groupBindCommand("@Muse助手 /allowgroup "), "allow");
  assert.equal(groupBindCommand("@Muse /取消授权本群"), "disallow");
  assert.equal(groupBindCommand("/DisallowGroup"), "disallow");
  assert.equal(groupBindCommand("怎么 /授权本群"), null);
  assert.equal(groupBindCommand("/授权本群 吧"), null);
});

test("/授权本群：主人授权 → 写回 config.json、群成员立即可用；重复授权提示；私聊和别的群照旧拦", async () => {
  const config: BridgeConfig = { allowedUserIds: ["owner"], replyTimeoutMin: 20 };
  const env = await makeEnv({ config });
  await writeFile(env.paths.config, JSON.stringify({ ...config, logMessageText: false }));

  await blockedText(env, group("m1", "bob", "@Muse 你好"));
  const log = env.logs.find((l) => l.event === "daemon.blocked_not_allowed");
  assert.equal(log?.data.chatId, "g1", "没授权的群：日志里能找到 chatid");

  await env.bridge.handleText(group("b1", "owner", "@Muse /授权本群"));
  assert.equal(lastReply(env), "已授权本群：群里所有成员 @我 都能使用。");
  assert.deepEqual(await disk(env), { allowedUserIds: ["owner"], replyTimeoutMin: 20, logMessageText: false, allowedChatIds: ["g1"] });
  assert.deepEqual(config.allowedChatIds, ["g1"]);
  assert.ok(!existsSync(join(env.paths.inbox, "b1.json")), "授权命令不进 inbox");

  await passes(env, group("m2", "bob", "@Muse 你好"));
  const item = JSON.parse(await readFile(join(env.paths.sent, "m2.json"), "utf8"));
  assert.equal(item.chatId, "g1");

  await env.bridge.handleText(group("b2", "owner", "/allowgroup"));
  assert.match(lastReply(env), /本群已经授权过了/);
  assert.deepEqual((await disk(env)).allowedChatIds, ["g1"]);

  await blockedText(env, textFrame("m3", "bob", "私聊"));
  await blockedText(env, group("m4", "bob", "@Muse hi", "g2"));
});

test("/授权本群：非主人（含已授权群里的成员）被拒、配置不变；私聊发提示要在群里发", async () => {
  const config: BridgeConfig = { allowedUserIds: ["owner"], allowedChatIds: ["g1"] };
  const env = await makeEnv({ config });
  await writeFile(env.paths.config, JSON.stringify(config));
  const before = await readFile(env.paths.config, "utf8");

  await env.bridge.handleText(group("x1", "mallory", "@Muse /授权本群", "g2"));
  assert.match(lastReply(env), /只有机器人的主人能授权/);
  await env.bridge.handleText(group("x2", "bob", "@Muse /取消授权本群", "g1"));
  assert.match(lastReply(env), /只有机器人的主人能授权/);
  assert.equal(await readFile(env.paths.config, "utf8"), before);
  assert.ok(env.logs.some((l) => l.event === "daemon.group_bind_refused" && l.data.chatId === "g2"));

  await env.bridge.handleText(textFrame("x3", "owner", "/授权本群"));
  assert.match(lastReply(env), /要在群里 @我 发送/);
  assert.equal(await readFile(env.paths.config, "utf8"), before);
});

test("/取消授权本群：移除后群成员被拦、主人照旧；没授权过的群提示不用取消", async () => {
  const config: BridgeConfig = { allowedUserIds: ["owner"], allowedChatIds: ["g1", "g2"] };
  const env = await makeEnv({ config });
  await writeFile(env.paths.config, JSON.stringify(config));

  await env.bridge.handleText(group("u1", "owner", "@Muse /取消授权本群"));
  assert.match(lastReply(env), /^已取消本群授权/);
  assert.deepEqual((await disk(env)).allowedChatIds, ["g2"]);
  await blockedText(env, group("u2", "bob", "@Muse 在吗"));
  await passes(env, group("u3", "owner", "@Muse 在吗"));
  await passes(env, group("u4", "bob", "@Muse 在吗", "g2"));

  await env.bridge.handleText(group("u5", "owner", "/disallowgroup"));
  assert.match(lastReply(env), /本来就没有授权/);
  assert.deepEqual((await disk(env)).allowedChatIds, ["g2"]);
});

test("授权群：同时两条授权命令串行写盘，互不覆盖；磁盘上手改的项保留", async () => {
  const config: BridgeConfig = { allowedUserIds: ["owner"] };
  const env = await makeEnv({ config });
  await writeFile(env.paths.config, JSON.stringify({ allowedUserIds: ["owner", "carol"], allowedChatIds: ["g0"] }));
  await Promise.all([
    env.bridge.handleText(group("c1", "owner", "/授权本群", "g1")),
    env.bridge.handleText(group("c2", "owner", "/授权本群", "g2")),
  ]);
  const d = await disk(env);
  assert.deepEqual(d.allowedChatIds, ["g0", "g1", "g2"]);
  assert.deepEqual(d.allowedUserIds, ["owner", "carol"]);
});

test("授权群：图片 / 文件 / 语音 / 卡片点击 / /stop 同样放行；没授权的群照旧拦", async () => {
  const env = await makeEnv({ config: { allowedUserIds: ["owner"], allowedChatIds: ["g1"] } });
  const media = (msgid: string, chatid: string) =>
    frame({ msgid, msgtype: "image", chattype: "group", chatid, from: { userid: "bob" }, image: { url: "https://x/y" } });
  const p = env.bridge.handleMedia(media("i1", "g1"), "image");
  await waitFor(() => existsSync(join(env.paths.inbox, "i1.json")));
  await writeOutbox(env, "i1", { chatId: "g1", text: "看到了" });
  assert.equal((await p)?.status, "sent");
  assert.equal(await env.bridge.handleMedia(media("i2", "g2"), "image"), null);
  assert.ok(!existsSync(join(env.paths.inbox, "i2.json")));

  const empty = (msgid: string, chatid: string) =>
    frame({ msgid, msgtype: "voice", chattype: "group", chatid, from: { userid: "bob" }, voice: { content: "" } });
  await env.bridge.handleVoice(empty("v1", "g1"));
  assert.match(lastReply(env), /没听清/);
  const n = env.client.of("replyStream").length;
  await env.bridge.handleVoice(empty("v2", "g2"));
  assert.equal(env.client.of("replyStream").length, n, "没授权的群：静默");

  const card = (chatid: string) =>
    frame({
      msgtype: "event",
      chattype: "group",
      chatid,
      from: { userid: "bob" },
      event: { eventtype: "template_card_event", template_card_event: { event_key: "go", task_id: `t-${chatid}` } },
    });
  await env.bridge.onCardEvent(card("g1"));
  await env.bridge.onCardEvent(card("g2"));
  const items = (await readdirJson(env.paths.inbox)).filter((x) => x.type === "card_event");
  assert.deepEqual(items.map((x) => x.chatId), ["g1"]);

  await env.bridge.handleText(group("s1", "bob", "@Muse /stop"));
  assert.match(lastReply(env), /任务/);
});

async function readdirJson(dir: string): Promise<{ type?: string; chatId?: string }[]> {
  const out = [];
  for (const n of await readdir(dir)) if (n.endsWith(".json")) out.push(JSON.parse(await readFile(join(dir, n), "utf8")));
  return out;
}
