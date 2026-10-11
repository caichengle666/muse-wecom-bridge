/**
 * onboard.ts — 扫码创建企业微信智能机器人（npm run onboard）。
 *
 * 用的是企业微信官方 CLI（@wecom/wecom-openclaw-cli）同款扫码接口：
 *   1. GET  work.weixin.qq.com/ai/qc/generate?source=wecom-cli&plat=<1|2|3>  → scode + auth_url
 *   2. 终端打印二维码（同时保存 onboard-qr.png），用手机企业微信扫码，按提示「一键创建智能机器人」；
 *   3. 每 3 秒 GET /ai/qc/query_result?scode=…，status=success 时拿到 bot_info.botid / secret。
 * 拿到后：
 *   - 凭证写入 secrets.env（600，不打印）；
 *   - 扫码接口不返回扫码人的 userid，所以白名单为空时生成一次性 8 位配对码写进 config.json，
 *     daemon 启动后在私聊里给机器人发这个码，发码的人自动进白名单、配对码作废。
 *
 * 注意：这个接口企业微信没写进开发者文档，只有官方 CLI 在用，随时可能变；只能新建机器人。
 * 扫码不可用时，照 README 在企业微信里手动创建（API 模式 → 长连接），把 Bot ID / Secret 写进 secrets.env。
 */
import { readFile, writeFile, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import { makePaths, resolveRoot } from "./paths.js";
import { cleanUserIds, isPlaceholder, newPairCode, parseEnvFile } from "./config.js";
import { atomicWriteJson } from "./fsutil.js";

const BASE = "https://work.weixin.qq.com/ai/qc";
const POLL_MS = 3000;
const TIMEOUT_MS = 5 * 60 * 1000;

export function platCode(p: string = platform()): number {
  return p === "darwin" ? 1 : p === "win32" ? 2 : p === "linux" ? 3 : 0;
}

export interface QrSession {
  scode: string;
  authUrl: string;
}

type Fetch = (url: string) => Promise<unknown>;

const fetchJson: Fetch = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

export async function createQr(get: Fetch = fetchJson): Promise<QrSession> {
  const resp = (await get(`${BASE}/generate?source=wecom-cli&plat=${platCode()}`)) as { data?: { scode?: string; auth_url?: string } };
  const scode = resp?.data?.scode;
  const authUrl = resp?.data?.auth_url;
  if (!scode || !authUrl) throw new Error("获取二维码失败，接口返回格式变了");
  return { scode, authUrl };
}

/** 轮询扫码结果；超时返回 null。 */
export async function pollBot(
  scode: string,
  get: Fetch = fetchJson,
  opts: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ botId: string; secret: string } | null> {
  const pollMs = opts.pollMs ?? POLL_MS;
  const end = Date.now() + (opts.timeoutMs ?? TIMEOUT_MS);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  while (Date.now() < end) {
    let resp: { data?: { status?: string; bot_info?: { botid?: string; secret?: string } } } | undefined;
    try {
      resp = (await get(`${BASE}/query_result?scode=${encodeURIComponent(scode)}`)) as typeof resp;
    } catch {
      resp = undefined; // 网络抖动：继续轮询
    }
    if (resp?.data?.status === "success") {
      const b = resp.data.bot_info;
      if (!b?.botid || !b?.secret) throw new Error("扫码成功但没拿到 Bot ID / Secret");
      return { botId: b.botid, secret: b.secret };
    }
    await sleep(pollMs);
  }
  return null;
}

/** 写回 secrets.env：只替换 WECOM_BOT_ID / WECOM_BOT_SECRET，保留其他行。 */
export function mergeSecrets(existing: string, botId: string, secret: string): string {
  const drop = /^\s*(export\s+)?(WECOM_BOT_ID|WECOM_BOT_SECRET)\s*=/;
  const kept = existing.split(/\r?\n/).filter((l) => !drop.test(l));
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  if (!kept.length) kept.push("# 企业微信智能机器人凭证（npm run onboard 扫码写入；chmod 600，不要提交）");
  return [...kept, `WECOM_BOT_ID=${botId}`, `WECOM_BOT_SECRET=${secret}`, ""].join("\n");
}

/**
 * 合并 config.json：清掉示例占位 userid；白名单为空且没开 allowAll 时写入新配对码。其余键原样保留。
 * 返回新配置和配对码（不需要配对时为 undefined）。
 */
export function mergeConfig(cfg: Record<string, unknown>, code: string = newPairCode()): { config: Record<string, unknown>; pairCode?: string } {
  const out = { ...cfg };
  const list = cleanUserIds(out.allowedUserIds);
  out.allowedUserIds = list;
  delete out.pairCode;
  if (list.length || out.allowAll === true) return { config: out };
  out.pairCode = code;
  return { config: out, pairCode: code };
}

const mask = (s: string) => (s.length <= 8 ? "***" : `${s.slice(0, 6)}…${s.slice(-3)}`);

async function main(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log("用法：npm run onboard    扫码新建企业微信智能机器人，凭证写入 secrets.env");
    return 0;
  }
  if (argv.length) {
    console.error(`不认识的参数：${argv.join(" ")}`);
    return 2;
  }
  const paths = makePaths(resolveRoot());
  const secretsRaw = existsSync(paths.secrets) ? await readFile(paths.secrets, "utf8") : "";
  const oldId = parseEnvFile(secretsRaw).WECOM_BOT_ID || "";
  let cfg: Record<string, unknown> = {};
  if (existsSync(paths.config)) {
    try {
      cfg = JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;
    } catch {
      console.error(`[onboard] ${paths.config} 不是合法 JSON，先修好再扫码（没有改动任何文件）`);
      return 2;
    }
  } else {
    const example = join(paths.root, "config.example.json");
    if (existsSync(example)) cfg = JSON.parse(await readFile(example, "utf8")) as Record<string, unknown>;
  }
  if (oldId && !isPlaceholder(oldId)) console.log(`[onboard] 注意：secrets.env 里已有机器人 ${mask(oldId)}，扫码成功后会被新机器人替换`);

  const qr = await createQr();
  const qrPath = join(paths.root, "onboard-qr.png");
  console.log("[onboard] 用手机企业微信扫下面的二维码，按提示「一键创建智能机器人」：");
  try {
    console.log(await QRCode.toString(qr.authUrl, { type: "terminal", small: true }));
    await QRCode.toFile(qrPath, qr.authUrl, { width: 360, margin: 2 });
    console.log(`[onboard] 二维码图片：${qrPath}`);
  } catch (e) {
    console.log(`[onboard] 生成二维码失败（${String((e as Error).message)}）`);
  }
  console.log(`[onboard] 也可以在电脑浏览器打开这个页面扫码：${BASE}/gen?source=wecom-cli&scode=${qr.scode}`);
  console.log("[onboard] 等待扫码（5 分钟内有效）…");

  const bot = await pollBot(qr.scode);
  await rm(qrPath, { force: true }).catch(() => undefined);
  if (!bot) {
    console.error("[onboard] 扫码超时，重新运行生成新的二维码（没有改动任何文件）");
    return 1;
  }
  await writeFile(paths.secrets, mergeSecrets(secretsRaw, bot.botId, bot.secret), { mode: 0o600 });
  await chmod(paths.secrets, 0o600);
  const { config, pairCode } = mergeConfig(cfg);
  await atomicWriteJson(paths.config, config);

  console.log("[onboard] 成功");
  console.log(`[onboard]   Bot ID：${mask(bot.botId)}（Secret 已写入 secrets.env，不显示）`);
  if (pairCode) {
    console.log(`[onboard]   配对码：${pairCode}`);
    console.log("[onboard]   daemon 启动后，在企业微信里私聊这个机器人发送上面的配对码，你就成了主人（白名单自动写好，配对码作废）");
  } else {
    console.log(`[onboard]   白名单沿用 config.json：${(config.allowedUserIds as string[]).join(",") || "allowAll=true"}`);
  }
  console.log("[onboard] 下一步：npm run check-config && bash keepalive.sh（已在运行的 daemon 要重启才会用新凭证）");
  return 0;
}

const isMain = process.argv[1] && /onboard\.js$/.test(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`[onboard] 失败：${String((e as Error)?.message || e)}`);
      console.error("[onboard] 扫码流程不可用时，按 README 在企业微信里手动创建机器人，把 Bot ID / Secret 写进 secrets.env");
      process.exit(1);
    },
  );
}
