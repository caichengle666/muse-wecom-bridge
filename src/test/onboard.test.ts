import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createQr, mergeConfig, mergeSecrets, platCode, pollBot } from "../onboard.js";
import { isValidPairCode, newPairCode, pairingPending, validateConfig } from "../config.js";
import { makeEnv, textFrame, ls } from "./helpers.js";

test("onboard: 二维码接口参数与解析", async () => {
  const urls: string[] = [];
  const qr = await createQr(async (u) => (urls.push(u), { data: { scode: "S1", auth_url: "https://a" } }));
  assert.deepEqual(qr, { scode: "S1", authUrl: "https://a" });
  assert.match(urls[0], /\/ai\/qc\/generate\?source=wecom-cli&plat=\d$/);
  assert.equal(platCode("linux"), 3);
  await assert.rejects(createQr(async () => ({ data: {} })), /格式变了/);
});

test("onboard: 轮询 pending → 网络错误 → success", async () => {
  const seq: unknown[] = [{ data: { status: "pending" } }, new Error("net"), { data: { status: "success", bot_info: { botid: "B", secret: "S" } } }];
  const r = await pollBot("x", async () => {
    const v = seq.shift();
    if (v instanceof Error) throw v;
    return v;
  }, { sleep: async () => undefined });
  assert.deepEqual(r, { botId: "B", secret: "S" });
  assert.equal(await pollBot("x", async () => ({ data: { status: "pending" } }), { timeoutMs: 0 }), null);
});

test("onboard: secrets.env 只替换两项凭证", () => {
  const out = mergeSecrets("# c\nWECOM_BOT_ID=old\nFOO=1\nexport WECOM_BOT_SECRET=x\n", "B", "S");
  assert.equal(out, "# c\nFOO=1\nWECOM_BOT_ID=B\nWECOM_BOT_SECRET=S\n");
  assert.match(mergeSecrets("", "B", "S"), /^# .*\nWECOM_BOT_ID=B\nWECOM_BOT_SECRET=S\n$/);
});

test("onboard: 白名单为空才生成配对码，示例占位被清掉", () => {
  const a = mergeConfig({ allowedUserIds: ["你的企业微信userid"], allowAll: false, replyTimeoutMin: 20 }, "ABCDEFGH");
  assert.deepEqual(a, { config: { allowedUserIds: [], allowAll: false, replyTimeoutMin: 20, pairCode: "ABCDEFGH" }, pairCode: "ABCDEFGH" });
  const b = mergeConfig({ allowedUserIds: ["zhangsan"], pairCode: "OLDOLDXX" });
  assert.deepEqual(b, { config: { allowedUserIds: ["zhangsan"] } });
  assert.equal(mergeConfig({ allowAll: true }).pairCode, undefined);
});

test("config: 配对码格式与校验", () => {
  for (let i = 0; i < 50; i++) assert.ok(isValidPairCode(newPairCode()));
  assert.equal(isValidPairCode("abcdefgh"), false);
  assert.equal(isValidPairCode("ABCDEFG0"), false);
  assert.deepEqual(validateConfig({ allowedUserIds: [], pairCode: "ABCDEFGH" }).errors, []);
  assert.ok(pairingPending({ pairCode: "ABCDEFGH" }));
  assert.match(validateConfig({ pairCode: "bad" }).errors.join(), /pairCode/);
  assert.match(validateConfig({ allowedUserIds: ["u"], pairCode: "ABCDEFGH" }).warnings.join(), /pairCode 不再生效/);
});

test("配对：错码被拦，私聊发对码 → 写回 config.json、立即放行、码作废", async () => {
  const config = { allowedUserIds: [] as string[], pairCode: "ABCDEFGH", replyTimeoutMin: 20 };
  const env = await makeEnv({ config });
  await writeFile(env.paths.config, JSON.stringify(config));
  await env.bridge.handleText(textFrame("p1", "zhang", "hello"));
  assert.match(String(env.client.of("replyStream")[0].args[2]), /配对码/);
  await env.bridge.handleText(textFrame("p2", "li", "abcdefgh", { chattype: "group", chatid: "g1" }));
  assert.equal(pairingPending(config), true, "群聊里发码不算");
  await env.bridge.handleText(textFrame("p3", "zhang", " abcdefgh "));
  assert.match(String(env.client.of("replyStream").at(-1)!.args[2]), /配对成功/);
  assert.deepEqual(JSON.parse(await readFile(env.paths.config, "utf8")), { allowedUserIds: ["zhang"], replyTimeoutMin: 20 });
  await env.bridge.handleText(textFrame("p4", "li", "ABCDEFGH"));
  assert.match(String(env.client.of("replyStream").at(-1)!.args[2]), /只服务它的主人/);
  assert.deepEqual(await ls(env.paths.inbox), []);
  const p = env.bridge.handleText(textFrame("p5", "zhang", "你好"));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await ls(env.paths.inbox)).length, 1, "主人消息进 inbox");
  void p;
});
