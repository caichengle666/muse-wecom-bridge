/**
 * paths.ts — 运行目录（ROOT）与各子路径。
 *
 * ROOT 默认是编译产物 dist/ 的上一级（即仓库目录），可用环境变量 MUSE_WECOM_ROOT 覆盖。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Paths {
  root: string;
  config: string;
  secrets: string;
  state: string;
  heartbeat: string;
  kicked: string;
  pid: string;
  /** 0.2.1：daemon 单实例锁（O_EXCL 创建） */
  lock: string;
  /** 0.2.1：卡片回调去重表 */
  cardEvents: string;
  cards: string;
  debugLog: string;
  inbox: string;
  outbox: string;
  sent: string;
  failed: string;
  expired: string;
  /** 0.2.1：正在发送的回复（outbox → inflight 认领） */
  inflight: string;
  progress: string;
  incoming: string;
  outgoing: string;
  feedbackRaw: string;
}

/** 解析 ROOT：MUSE_WECOM_ROOT 优先，否则 <本文件所在目录>/..（dist/.. = 仓库目录）。 */
export function resolveRoot(env: NodeJS.ProcessEnv = process.env, moduleUrl: string = import.meta.url): string {
  const fromEnv = (env.MUSE_WECOM_ROOT || "").trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(join(dirname(fileURLToPath(moduleUrl)), ".."));
}

export function makePaths(root: string): Paths {
  const r = resolve(root);
  return {
    root: r,
    config: join(r, "config.json"),
    secrets: join(r, "secrets.env"),
    state: join(r, "state.json"),
    heartbeat: join(r, "heartbeat.json"),
    kicked: join(r, "kicked.json"),
    pid: join(r, "daemon.pid"),
    lock: join(r, "daemon.lock"),
    cardEvents: join(r, "card_events.json"),
    cards: join(r, "cards.json"),
    debugLog: join(r, "debug.log"),
    inbox: join(r, "inbox"),
    outbox: join(r, "outbox"),
    sent: join(r, "sent"),
    failed: join(r, "failed"),
    expired: join(r, "expired"),
    inflight: join(r, "inflight"),
    progress: join(r, "progress"),
    incoming: join(r, "incoming"),
    outgoing: join(r, "outgoing"),
    feedbackRaw: join(r, "feedback_raw"),
  };
}
