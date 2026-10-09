/**
 * state.ts — 持久化小状态：去重水位（state.json）、心跳（heartbeat.json）、
 * 卡片登记（cards.json）、pid 文件（daemon.pid）。全部原子写。
 */
import { readFile, rm } from "node:fs/promises";
import { readFileSync, rmSync } from "node:fs";
import { atomicWriteJson, atomicWriteFile, SerialQueue } from "./fsutil.js";
import { formatIdentity, isSameProcessAlive, parseIdentity, type Identity } from "./proc.js";

export const MAX_SEEN = 500;

/** 去重水位：保留最近 MAX_SEEN 个 msgid。save 串行化 + 合并（多次并发调用只写最后状态）。 */
export class SeenStore {
  private seen = new Set<string>();
  private readonly q = new SerialQueue();
  private dirty = false;

  constructor(private readonly path: string, private readonly max: number = MAX_SEEN) {}

  async load(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, "utf8"));
      const arr = (raw as { seen?: unknown })?.seen;
      this.seen = new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
    } catch {
      this.seen = new Set();
    }
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  /** 加入并持久化；返回 false 表示已见过（调用方应丢弃该消息）。 */
  async add(id: string): Promise<boolean> {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.max) {
      const arr = [...this.seen].slice(-this.max);
      this.seen = new Set(arr);
    }
    await this.save();
    return true;
  }

  save(): Promise<void> {
    this.dirty = true;
    return this.q.run(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      await atomicWriteJson(this.path, { seen: [...this.seen].slice(-this.max) });
    });
  }
}

export interface HeartbeatData {
  pid: number;
  ts: number;
  connected: boolean;
  /** 0.2.1：本次启动的随机令牌，与 daemon.pid 中的 token 相同才算"心跳来自这次启动" */
  token?: string;
}

/**
 * 心跳：只在已认证（connected=true）时周期写入 {pid, ts, connected:true}；
 * 断开时立即写一次 {connected:false} 然后停止刷新——keepalive 据此判断"假活"。
 */
export class HeartbeatWriter {
  private connected = false;
  private readonly q = new SerialQueue();

  constructor(
    private readonly path: string,
    private readonly pid: number = process.pid,
    private readonly now: () => number = Date.now,
    private readonly token?: string,
  ) {}

  /** 启动时写一次 {connected:false, token}，让 keepalive 在认证前也能核对 token。 */
  init(): Promise<void> {
    return this.write(false);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  setConnected(v: boolean): Promise<void> {
    const changed = v !== this.connected;
    this.connected = v;
    if (v || changed) return this.write(v);
    return Promise.resolve();
  }

  /** 周期调用：仅在已认证时写。 */
  tick(): Promise<void> {
    if (!this.connected) return Promise.resolve();
    return this.write(true);
  }

  private write(connected: boolean): Promise<void> {
    const data: HeartbeatData = { pid: this.pid, ts: this.now(), connected, ...(this.token ? { token: this.token } : {}) };
    return this.q.run(() => atomicWriteJson(this.path, data)).catch(() => undefined);
  }
}

export interface CardRecord {
  taskId: string;
  cardType: string;
  chatKey: string;
  /** 原卡片（≤8KB 时保存），用于回调时生成同类型的"已收到"卡片 */
  card?: Record<string, unknown>;
  ts: number;
}

/**
 * 已发出模板卡片的登记表：task_id → {card_type, chatKey, 原卡片}，
 * 以及 chatKey → 最近一次 task_id（回调里没给 task_id 时回退用）。
 * chatKey 统一为 "群聊用 chatid、单聊用 userid"（= body.chatid || from.userid）。
 */
export class CardRegistry {
  private byTask = new Map<string, CardRecord>();
  private lastByChat = new Map<string, string>();
  private readonly q = new SerialQueue();

  constructor(private readonly path: string | null, private readonly max = 200) {}

  loadSync(): void {
    if (!this.path) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { cards?: CardRecord[] };
      for (const r of raw.cards || []) {
        if (r && typeof r.taskId === "string") this.remember(r, false);
      }
    } catch {
      /* 无文件或损坏：从空开始 */
    }
  }

  private remember(r: CardRecord, persist: boolean): void {
    this.byTask.delete(r.taskId);
    this.byTask.set(r.taskId, r);
    if (r.chatKey) this.lastByChat.set(r.chatKey, r.taskId);
    while (this.byTask.size > this.max) {
      const first = this.byTask.keys().next().value as string;
      this.byTask.delete(first);
    }
    if (persist) void this.persist();
  }

  register(card: Record<string, unknown>, chatKey: string): void {
    const taskId = typeof card.task_id === "string" ? card.task_id : "";
    if (!taskId) return;
    const cardType = typeof card.card_type === "string" ? card.card_type : "";
    const json = JSON.stringify(card);
    this.remember(
      { taskId, cardType, chatKey, ...(json.length <= 8192 ? { card } : {}), ts: Date.now() },
      true,
    );
  }

  get(taskId: string): CardRecord | undefined {
    return this.byTask.get(taskId);
  }

  lastTaskFor(chatKey: string): string {
    return this.lastByChat.get(chatKey) || "";
  }

  persist(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const path = this.path;
    return this.q.run(() => atomicWriteJson(path, { cards: [...this.byTask.values()] })).catch(() => undefined);
  }
}

/** pid 文件（0.2.1）：一行 `<pid> <starttime> <token>`；只在 token 仍是本次启动时才删除。 */
export async function writePidFile(path: string, id: Identity): Promise<void> {
  await atomicWriteFile(path, formatIdentity(id));
}

export function readPidFile(path: string): Identity | null {
  try {
    return parseIdentity(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export async function removePidFile(path: string, id: Identity): Promise<void> {
  try {
    if (parseIdentity(await readFile(path, "utf8"))?.token === id.token) await rm(path, { force: true });
  } catch {
    /* 不存在 */
  }
}

export function removePidFileSync(path: string, id: Identity): void {
  try {
    if (parseIdentity(readFileSync(path, "utf8"))?.token === id.token) rmSync(path, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 读 pid 文件，若记录的进程仍活着（pid 存在且 starttime 相同——防 pid 复用）且命令行含 daemon.js，返回其 pid。
 * 只是诊断用；真正的单实例保证是 lock.ts 的 daemon.lock。
 */
export function livePeerDaemon(path: string, selfPid: number = process.pid): number | null {
  const id = readPidFile(path);
  if (!id || id.pid === selfPid) return null;
  if (!isSameProcessAlive(id)) return null;
  try {
    const cmd = readFileSync(`/proc/${id.pid}/cmdline`, "utf8").replace(/\0/g, " ");
    return /daemon\.js/.test(cmd) ? id.pid : null;
  } catch {
    return null;
  }
}

/**
 * 卡片回调去重（0.2.1）：键 = task_id + event_key + 会话键（chatid || from.userid），
 * 带 TTL（默认 10 分钟）记在 card_events.json（原子写）。同一键在 TTL 内只入队一次。
 * check-and-add 在内存里同步完成（没有 await），同进程内的并发重复回调也只放过一个。
 */
export class CardEventDedupe {
  private seen = new Map<string, number>();
  private readonly q = new SerialQueue();

  constructor(
    private readonly path: string | null,
    private readonly ttlMs: number = 10 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  loadSync(): void {
    if (!this.path) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { events?: Record<string, unknown> };
      const t = this.now();
      for (const [k, v] of Object.entries(raw.events || {})) {
        if (typeof v === "number" && t - v < this.ttlMs) this.seen.set(k, v);
      }
    } catch {
      /* 无文件或损坏：从空开始 */
    }
  }

  static keyOf(taskId: string, eventKey: string, chatKey: string): string {
    return JSON.stringify([taskId, eventKey, chatKey]);
  }

  private prune(t: number): void {
    for (const [k, v] of this.seen) if (t - v >= this.ttlMs) this.seen.delete(k);
  }

  /** 首次（或 TTL 已过）返回 true 并记下；TTL 内重复返回 false。 */
  firstSeen(key: string): boolean {
    const t = this.now();
    this.prune(t);
    if (this.seen.has(key)) return false;
    this.seen.set(key, t);
    void this.persist();
    return true;
  }

  persist(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const path = this.path;
    return this.q.run(() => atomicWriteJson(path, { events: Object.fromEntries(this.seen) })).catch(() => undefined);
  }
}
