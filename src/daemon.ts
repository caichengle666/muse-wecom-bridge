#!/usr/bin/env node
/**
 * daemon.ts — WeCom (企业微信) 智能机器人长连接 daemon for the Muse platform.
 *
 * 只负责进程级胶水：加载配置/凭证、校验（白名单 fail-closed）、pid 文件、
 * 创建真实 WSClient 并注入 bridge.ts（全部业务逻辑在 bridge.ts，可离线测试）。
 *
 * Secrets: secrets.env (600) with WECOM_BOT_ID / WECOM_BOT_SECRET.
 * Get them at: 企业微信管理后台 → 工作台 → 智能机器人 → 新建 → API 模式 → 长连接.
 */
import { mkdir } from "node:fs/promises";
import tls from "node:tls";
import { WSClient } from "@wecom/aibot-node-sdk";
import { MuseBackend } from "./muse-backend.js";
import { makePaths, resolveRoot } from "./paths.js";
import { isPlaceholder, loadConfig, loadSecrets, validateConfig, type BridgeConfig } from "./config.js";
import { RotatingLogger } from "./logger.js";
import { CardEventDedupe, CardRegistry, HeartbeatWriter, SeenStore, removePidFileSync, writePidFile } from "./state.js";
import { selfIdentity } from "./proc.js";
import { acquireInstanceLock, releaseInstanceLock } from "./lock.js";
import { OutboxStore } from "./outbox.js";
import { createBridge, type BotClient } from "./bridge.js";
import { resolveAllowedRoots } from "./files.js";

/** TLS reachability probe for the WeCom long-connection gateway. */
function probeGateway(wsUrl: string, timeoutMs = 8000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const m = wsUrl.match(/^wss:\/\/([^/:]+)(?::(\d+))?/);
    if (!m) return resolve({ ok: false, detail: "wsUrl 格式无法解析" });
    const host = m[1], port = Number(m[2] || 443);
    const s = tls.connect(port, host, { servername: host }, () => {
      const subject = s.getPeerCertificate()?.subject as { CN?: string } | undefined;
      s.end();
      resolve({ ok: true, detail: `TLS 握手成功（证书 CN=${subject?.CN || "?"}）` });
    });
    s.on("error", (e) => resolve({ ok: false, detail: `连接失败: ${e.message}` }));
    s.setTimeout(timeoutMs, () => {
      s.destroy();
      resolve({ ok: false, detail: "连接超时" });
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check-config");
  const paths = makePaths(resolveRoot());

  const fail = (msg: string, code = 2): never => {
    console.error(`${checkOnly ? "配置检查失败" : "daemon 启动失败"}: ${msg}`);
    process.exit(code);
  };

  let cfg: BridgeConfig = {};
  try {
    cfg = await loadConfig(paths.config);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  const wsUrl = cfg.wsUrl || "wss://openws.work.weixin.qq.com";

  let secrets = { botId: "", botSecret: "" };
  try {
    secrets = await loadSecrets(paths.secrets);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  if (isPlaceholder(secrets.botId) || isPlaceholder(secrets.botSecret)) {
    fail("WECOM_BOT_ID / WECOM_BOT_SECRET 还是占位符，请填入真实的智能机器人凭证");
  }

  const check = validateConfig(cfg);
  for (const w of check.warnings) console.warn(`警告: ${w}`);
  if (check.errors.length) fail(check.errors.join("；"));

  if (checkOnly) {
    const list = cfg.allowedUserIds || [];
    console.log("配置检查通过: config.json 与 secrets.env 有效（未连接企业微信）。");
    console.log(`  ROOT=${paths.root}`);
    console.log(`  wsUrl=${wsUrl}`);
    console.log(`  白名单: ${list.length ? list.join(",") : "allowAll=true（对所有人开放）"}`);
    console.log(`  允许外发文件目录: ${resolveAllowedRoots(paths.root, cfg.allowedFileRoots).join(", ")}`);
    const probe = await probeGateway(wsUrl);
    console.log(`  网关连通性: ${probe.ok ? "OK" : "FAIL"}（${probe.detail}）`);
    process.exit(probe.ok ? 0 : 3);
  }

  // 同一 ROOT 只允许一个 daemon（同一 BotID 只许一条长连接，两个实例会互相顶号）。
  // 0.2.1：daemon 自己用 O_EXCL 创建 daemon.lock（pid + starttime + token），陈旧锁安全回收；
  // 不再依赖 keepalive 的"先检查再拉起"。
  await mkdir(paths.root, { recursive: true });
  const self = selfIdentity();
  const lock = acquireInstanceLock(paths.lock, self);
  if (!lock.ok) return fail(`${lock.reason}（见 ${paths.lock}）`, 1);
  process.on("exit", () => {
    removePidFileSync(paths.pid, self);
    releaseInstanceLock(paths.lock, self);
  });
  // 启动期间收到 SIGTERM/SIGINT 也要走 exit 钩子释放锁（默认动作会直接终止、留下陈旧锁）
  const earlyExit = () => process.exit(0);
  process.on("SIGINT", earlyExit);
  process.on("SIGTERM", earlyExit);
  await writePidFile(paths.pid, self);

  const logger = new RotatingLogger(paths.debugLog);
  const log = logger.fn;
  if (lock.reclaimed) log("daemon.lock_reclaimed", { lock: paths.lock });

  const backend = new MuseBackend(
    { inbox: paths.inbox, outbox: paths.outbox, sent: paths.sent, inflight: paths.inflight },
    { replyTimeoutMs: (cfg.replyTimeoutMin ?? 20) * 60 * 1000, log },
  );
  await backend.init();
  const outbox = new OutboxStore({
    outbox: paths.outbox,
    sent: paths.sent,
    failed: paths.failed,
    expired: paths.expired,
    progress: paths.progress,
    inflight: paths.inflight,
  });
  await outbox.init();
  // 崩溃恢复（已持有单实例锁，没有别的实例在发）：inflight/* 移回 outbox/ 续发，有墓碑的移到 expired/
  const recovered = await outbox.recoverInflight();
  const seen = new SeenStore(paths.state);
  await seen.load();
  const cards = new CardRegistry(paths.cards);
  cards.loadSync();
  const cardEvents = new CardEventDedupe(paths.cardEvents);
  cardEvents.loadSync();
  const heartbeat = new HeartbeatWriter(paths.heartbeat, process.pid, Date.now, self.token);
  await heartbeat.init();

  const sdkLog = (level: string) => (m: string, ...a: unknown[]) =>
    log(`sdk.${level}`, { m, a: a.map(String).slice(0, 3) });
  const wsClient = new WSClient({
    botId: secrets.botId,
    secret: secrets.botSecret,
    wsUrl,
    maxReconnectAttempts: -1, // 网络断开无限重连（被顶号 SDK 不会重连，由 bridge 退出交给 keepalive）
    logger: { debug: () => undefined, info: sdkLog("info"), warn: sdkLog("warn"), error: sdkLog("error") },
  });

  const bridge = createBridge({
    client: wsClient as unknown as BotClient,
    paths,
    config: cfg,
    backend,
    outbox,
    seen,
    heartbeat,
    cards,
    cardEvents,
    log,
    exit: (code) => {
      void logger.flush().finally(() => process.exit(code));
    },
  });
  if (recovered.requeued.length || recovered.expired.length) log("daemon.inflight_recovered", recovered);
  bridge.attach();
  bridge.startTimers();

  const shutdown = () => {
    log("daemon.shutdown", {});
    try {
      wsClient.disconnect();
    } catch {
      /* ignore */
    }
    void logger.flush().finally(() => process.exit(0));
  };
  process.off("SIGINT", earlyExit);
  process.off("SIGTERM", earlyExit);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  wsClient.connect();
  log("daemon.started", { at: new Date().toISOString(), wsUrl, pid: process.pid });
  console.log(`muse-wecom daemon 已启动（pid ${process.pid}），正在连接 ${wsUrl} …`);
}

main().catch((err: unknown) => {
  console.error("daemon 启动失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
