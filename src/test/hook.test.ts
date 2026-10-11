/** hooks/wecom-inbox-watch.sh 真跑：假 HOME + 假 hook 运行时（silent/wake 只打印）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const HOOK = join(REPO, "hooks", "wecom-inbox-watch.sh");

interface Hook {
  home: string;
  br: string;
  ctx: string;
  run(): string;
  claim(id: string, text: string, ts: string): Promise<void>;
  replied(id: string, text: string): Promise<void>;
  ctxOf(chat: string): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function makeHook(config: Record<string, unknown> = {}): Promise<Hook> {
  const home = await mkdtemp(join(tmpdir(), "mwb-hook-"));
  const br = join(home, "workspace", "muse-wecom-bridge");
  const ctx = join(home, "hooks", "state");
  for (const d of ["inbox", "sent", "expired", "failed", "stop"]) await mkdir(join(br, d), { recursive: true });
  await mkdir(ctx, { recursive: true });
  await writeFile(join(br, "config.json"), JSON.stringify(config));
  const rt = join(home, "rt.sh");
  await writeFile(rt, 'silent(){ echo "SILENT: $1"; exit 0; }\nwake(){ echo "WAKE: $1 $2"; exit 0; }\n');
  const run = () => {
    // 心跳是新的：没消息时走 SILENT，不触发健康告警
    spawnSync("bash", ["-c", `printf '{"ts":%s,"connected":true}' "$(($(date +%s)*1000))" > "${br}/heartbeat.json"`]);
    const r = spawnSync("bash", [HOOK], { env: { ...process.env, HOME: home, HATCH_HOOK_RUNTIME: rt }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  return {
    home,
    br,
    ctx,
    run,
    async claim(id, text, ts) {
      await writeFile(join(br, "inbox", `${id}.json`), JSON.stringify({ messageId: id, chatId: "u1", text, ts }));
      assert.match(run(), new RegExp(`WAKE: .*"${id}"`));
    },
    async replied(id, text) {
      await writeFile(join(br, "sent", `${id}.json`), JSON.stringify({ text }));
      await rm(join(br, "inbox", `${id}.json.claimed`), { force: true });
    },
    async ctxOf(chat) {
      return JSON.parse(await readFile(join(ctx, `wecom-ctx-${chat}.json`), "utf8"));
    },
  };
}

function age(p: string, secs: number): void {
  const t = Date.now() / 1000 - secs;
  utimesSync(p, t, t);
}

test("hook #1: 有墓碑（超时/停止）的消息不再认领、不重跑，文件移到 expired/；认领有效期按 replyTimeoutMin 算", async () => {
  const h = await makeHook({ replyTimeoutMin: 1 }); // 有效期 = 60 + 300 = 360 秒
  const inbox = join(h.br, "inbox");
  const item = (id: string) => JSON.stringify({ messageId: id, chatId: "u1", text: id, ts: "2026-10-11T00:00:00Z" });
  // 已认领、超过有效期、daemon 已超时写了墓碑
  await writeFile(join(inbox, "t1.json.claimed"), item("t1"));
  age(join(inbox, "t1.json.claimed"), 400);
  await writeFile(join(h.br, "expired", "t1.tombstone"), "x\n");
  // 未认领、有墓碑（hook 暂停期间 daemon 已超时，移文件前就被 hook 看到）
  await writeFile(join(inbox, "t2.json"), item("t2"));
  await writeFile(join(h.br, "expired", "t2.tombstone"), "x\n");
  let out = h.run();
  assert.doesNotMatch(out, /WAKE/, out);
  assert.ok(!existsSync(join(inbox, "t1.json.claimed")) && !existsSync(join(inbox, "t2.json")));
  assert.ok(existsSync(join(h.br, "expired", "t1.inbox.json")) && existsSync(join(h.br, "expired", "t2.inbox.json")));

  // 没墓碑的过期认领（worker 崩了、daemon 没在等）照常回收；400 秒 > 360 秒
  await writeFile(join(inbox, "c1.json.claimed"), item("c1"));
  age(join(inbox, "c1.json.claimed"), 400);
  out = h.run();
  assert.match(out, /WAKE: .*"c1"/, out);

  // 默认 20 分钟超时：400 秒的认领还在有效期内，不回收
  const h2 = await makeHook({});
  await writeFile(join(h2.br, "inbox", "c2.json.claimed"), item("c2"));
  age(join(h2.br, "inbox", "c2.json.claimed"), 400);
  assert.doesNotMatch(h2.run(), /WAKE/);
  age(join(h2.br, "inbox", "c2.json.claimed"), 1600); // > 1200 + 300
  assert.match(h2.run(), /WAKE: .*"c2"/);
});

test("hook #5: 超时（只有墓碑）的消息记成一轮，不在之后的上下文里一直显示'还在处理中'", async () => {
  const h = await makeHook({});
  await h.claim("t1", "长任务", "2026-10-11T00:00:00Z");
  await writeFile(join(h.br, "expired", "t1.tombstone"), "x\n");
  await rm(join(h.br, "inbox", "t1.json.claimed"), { force: true });
  await writeFile(join(h.br, "inbox", "n1.json"), JSON.stringify({ messageId: "n1", chatId: "u1", text: "新问题", ts: "2026-10-11T00:30:00Z" }));
  const out = h.run();
  const file = JSON.parse(/"context_file":("[^"]+")/.exec(out)![1]) as string;
  const ctx = JSON.parse(await readFile(file, "utf8")).n1;
  assert.ok(!JSON.stringify(ctx).includes("还在处理中"), JSON.stringify(ctx));
  assert.equal(ctx.turns.length, 1);
  assert.equal(ctx.turns[0].user, "长任务");
  assert.match(ctx.turns[0].assistant, /超时/);
});

test("hook #2: /clear 之后才到的旧压缩结果被丢弃，不冲掉新对话；seq 不归零；新对话自己的压缩照常合并", async () => {
  const h = await makeHook({});
  let n = 0;
  const ts = () => `2026-10-11T00:00:${String(++n).padStart(2, "0")}Z`;
  for (const [id, q] of [["a1", "旧1"], ["a2", "旧2"], ["a3", "旧3"]]) {
    await h.claim(id, q, ts());
    await h.replied(id, `答${q}`);
  }
  h.run(); // 收割 a3
  assert.equal((await h.ctxOf("u1")).turns.length, 3);
  // /clear，然后新问题
  await h.claim("c1", "/clear", ts());
  await h.replied("c1", "好的，换个话题");
  await h.claim("n1", "新话题", ts());
  await h.replied("n1", "新回答");
  h.run();
  let ctx = await h.ctxOf("u1");
  assert.deepEqual(ctx.turns.map((t: { user: string }) => t.user), ["新话题"]);
  assert.equal(ctx.seq_floor, 4);
  assert.equal(ctx.turns[0].seq, 4, "seq 接着旧历史往上数");
  // a3 的 worker 很慢，现在才交上旧对话的压缩结果
  await writeFile(join(h.ctx, "wecom-ctx-u1.summary.json"), JSON.stringify({ summary: "旧对话摘要", upto_seq: 2 }));
  h.run();
  ctx = await h.ctxOf("u1");
  assert.deepEqual(ctx.turns.map((t: { user: string }) => t.user), ["新话题"]);
  assert.equal(ctx.summary, "");
  // 新对话自己的压缩（upto_seq ≥ seq_floor）照常合并
  await writeFile(join(h.ctx, "wecom-ctx-u1.summary.json"), JSON.stringify({ summary: "新摘要", upto_seq: 4 }));
  h.run();
  ctx = await h.ctxOf("u1");
  assert.equal(ctx.summary, "新摘要");
  assert.equal(ctx.turns.length, 0);

  // worker 提交的 .clear.json 也一样：之后迟到的旧压缩不生效
  await h.claim("n2", "再一个", ts());
  await h.replied("n2", "嗯");
  h.run();
  await writeFile(join(h.ctx, "wecom-ctx-u1.clear.json"), JSON.stringify({ messageId: "zz" }));
  h.run();
  ctx = await h.ctxOf("u1");
  assert.equal(ctx.seq_floor, 6);
  await h.claim("n3", "清空后第一句", ts());
  await h.replied("n3", "收到");
  h.run();
  await writeFile(join(h.ctx, "wecom-ctx-u1.summary.json"), JSON.stringify({ summary: "过时", upto_seq: 5 }));
  h.run();
  ctx = await h.ctxOf("u1");
  assert.deepEqual(ctx.turns.map((t: { user: string }) => t.user), ["清空后第一句"]);
  assert.equal(ctx.summary, "");
});
