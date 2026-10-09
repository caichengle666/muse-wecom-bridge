/**
 * outbox.ts — 回复投递引擎（被动回复与排空补发共用）。
 *
 * 一条回复（outbox/<id>.json）拆成若干"部件"依次发送：
 *   text:0..n（每 20000 字节一段）→ file → images（被动：一次性；主动：image:<i> 逐张）→ card
 * 每发完一个部件就把进度写进 progress/<id>.json，所以：
 *   - 已发出的部件永远不会被重发（被动发了文本、文件失败 → 排空只补发文件）；
 *   - 永久错误（本地校验失败、errcode ∈ NON_RETRYABLE_ERRCODES）→ 该部件记为失败、通知用户、
 *     其余部件照发，最后整条移到 failed/<id>.json（附 failed/<id>.reason.json）；
 *   - 临时错误（限频、断线、回执超时…）→ attempts+1，留在 outbox 等下次排空；
 *     达到 maxAttempts（默认 5）→ failed/。
 * 超时的消息写墓碑 expired/<id>.tombstone，之后迟到的 outbox 文件直接移到 expired/，不再补发。
 *
 * 0.2.1：
 *   - 同一 id 进程内互斥（Map<id, Promise>）：并发调用拿到同一个进行中的结果，被动回复与排空都只走 runDelivery；
 *   - 发送前先认领：rename outbox/<id>.json → inflight/<id>.json，归档/失败/过期都从 inflight 移走；
 *     超时路径先写墓碑再尝试 rename outbox → expired（谁 rename 成功谁拥有该文件）；
 *     若已被认领（在 inflight），发送方在部件之间检查墓碑，停止剩余部件，移到 expired/ 并写 <id>.partial.json；
 *   - 崩溃恢复：daemon 拿到单实例锁后 recoverInflight()：inflight/* 移回 outbox/（凭 progress 续发，已发部件不重发），
 *     有墓碑的移到 expired/；
 *   - 临时错误按部件、按时间窗口计数（默认 1 小时内 5 次），部件成功即清零。
 */
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteJson, atomicWriteFile, moveFile, errText } from "./fsutil.js";
import { chunkByBytes, STREAM_CHUNK_BYTES } from "./chunk.js";
import { checkOutgoingFile, detectMediaType, type MediaType } from "./files.js";
import type { LogFn } from "./logger.js";

export interface ReplyPayload {
  messageId: string;
  chatId: string;
  text: string;
  file?: string;
  card?: Record<string, unknown>;
  images?: string[];
}

/** 解析 outbox JSON。非法 JSON / 顶层不是对象 → 抛错（调用方决定重试还是失败）。 */
export function parseOutboxPayload(raw: string, fallbackId: string): ReplyPayload {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("outbox 顶层必须是 JSON 对象");
  const o = parsed as Record<string, unknown>;
  const out: ReplyPayload = {
    messageId: typeof o.messageId === "string" && o.messageId ? o.messageId : fallbackId,
    chatId: typeof o.chatId === "string" ? o.chatId : "",
    text: typeof o.text === "string" ? o.text : o.text == null ? "" : String(o.text),
  };
  if (typeof o.file === "string" && o.file) out.file = o.file;
  if (o.card && typeof o.card === "object" && !Array.isArray(o.card)) out.card = o.card as Record<string, unknown>;
  if (Array.isArray(o.images)) {
    const imgs = o.images.filter((p): p is string => typeof p === "string" && !!p);
    if (imgs.length) out.images = imgs;
  }
  return out;
}

// ---------------------------------------------------------------- errors

/** 企业微信回执里的不可重试错误码（重发也不会成功）。 */
export const NON_RETRYABLE_ERRCODES = new Set<number>([40008, 42044, 42045, 40058]);

/** 本地校验失败等永久错误。 */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

const ERRCODE_RE = /["']?errcode["']?\s*[=:]\s*["']?(\d+)/i;
const SDK_CODE_RE = /\(code:\s*(\d+)\)/i;

function numOrUndef(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

function codeFromText(t: string): number | undefined {
  const m = t.match(ERRCODE_RE) || t.match(SDK_CODE_RE);
  return m ? Number(m[1]) : undefined;
}

/**
 * 从各种形状的错误里取企业微信 errcode（0.2.1 加强）：
 *   1. e.errcode（Error 或普通对象）；
 *   2. message 里的 `errcode=40008` / `"errcode":40008` / `'errcode': 40008` / SDK 的 `(code: 40008)`；
 *   3. e.cause 链（递归，最多 depth 层，防环）；
 *   4. 兜底 JSON.stringify(e, Object.getOwnPropertyNames(e))（能看到 Error 的不可枚举属性）再匹配。
 */
export function errcodeOf(e: unknown, depth = 5): number | undefined {
  const seen = new Set<unknown>();
  const walk = (x: unknown, d: number): number | undefined => {
    if (x == null || d < 0 || seen.has(x)) return undefined;
    if (typeof x === "string") return codeFromText(x);
    if (typeof x !== "object") return undefined;
    seen.add(x);
    const o = x as Record<string, unknown>;
    const direct = numOrUndef(o.errcode);
    if (direct !== undefined) return direct;
    const msg = typeof o.message === "string" ? o.message : "";
    const fromMsg = msg ? codeFromText(msg) : undefined;
    if (fromMsg !== undefined) return fromMsg;
    if ("cause" in o) {
      const c = walk(o.cause, d - 1);
      if (c !== undefined) return c;
    }
    return undefined;
  };
  const r = walk(e, depth);
  if (r !== undefined) return r;
  if (e && typeof e === "object") {
    try {
      const viaReplacer = codeFromText(JSON.stringify(e, Object.getOwnPropertyNames(e)));
      if (viaReplacer !== undefined) return viaReplacer;
      // 数组型 replacer 也会过滤嵌套对象的键（嵌套的 errcode 会被丢掉），再把自有属性展开成普通对象序列化一次
      const flat: Record<string, unknown> = {};
      for (const k of Object.getOwnPropertyNames(e)) flat[k] = (e as Record<string, unknown>)[k];
      return codeFromText(JSON.stringify(flat));
    } catch {
      /* 循环引用等 */
    }
  }
  return undefined;
}

export function isPermanentError(e: unknown): boolean {
  if (e instanceof PermanentError) return true;
  const c = errcodeOf(e);
  return c !== undefined && NON_RETRYABLE_ERRCODES.has(c);
}

// ---------------------------------------------------------------- store

export interface Progress {
  done: string[];
  failedParts: { part: string; reason: string }[];
  /** 当前失败部件在时间窗口内的临时失败次数（报告用） */
  attempts: number;
  /** 0.2.1：每个部件的临时失败时间戳（只保留窗口内），部件成功即删除 */
  partFailures: Record<string, number[]>;
  lastError?: string;
  updatedAt?: string;
}

export interface OutboxDirs {
  outbox: string;
  sent: string;
  failed: string;
  expired: string;
  progress: string;
  /** 0.2.1：认领中的回复；缺省为 <outbox>/../inflight */
  inflight?: string;
}

export type ClaimResult = "claimed" | "already_inflight" | "missing";
export type Location = "outbox" | "inflight" | "sent" | "failed" | "expired" | "none";

async function tryRename(src: string, dst: string): Promise<boolean> {
  try {
    await rename(src, dst);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      if (!existsSync(src)) return false; // 源已不在（被别人拿走）
      await mkdir(join(dst, ".."), { recursive: true });
      try {
        await rename(src, dst);
        return true;
      } catch {
        return false;
      }
    }
    throw e;
  }
}

export class OutboxStore {
  readonly dirs: Required<OutboxDirs>;
  /** 0.2.1：同一 id 的进程内互斥——进行中的投递 */
  readonly runs = new Map<string, Promise<DeliveryResult>>();

  constructor(dirs: OutboxDirs) {
    this.dirs = { ...dirs, inflight: dirs.inflight ?? join(dirs.outbox, "..", "inflight") };
  }

  async init(): Promise<void> {
    for (const d of Object.values(this.dirs)) await mkdir(d, { recursive: true });
  }

  outboxPath(id: string): string {
    return join(this.dirs.outbox, `${id}.json`);
  }

  inflightPath(id: string): string {
    return join(this.dirs.inflight, `${id}.json`);
  }

  async loadProgress(id: string): Promise<Progress> {
    try {
      const p = JSON.parse(await readFile(join(this.dirs.progress, `${id}.json`), "utf8")) as Partial<Progress>;
      const pf: Record<string, number[]> = {};
      if (p.partFailures && typeof p.partFailures === "object") {
        for (const [k, v] of Object.entries(p.partFailures)) {
          if (Array.isArray(v)) pf[k] = v.filter((x): x is number => typeof x === "number");
        }
      }
      return {
        done: Array.isArray(p.done) ? p.done : [],
        failedParts: Array.isArray(p.failedParts) ? p.failedParts : [],
        attempts: typeof p.attempts === "number" ? p.attempts : 0,
        partFailures: pf,
        ...(p.lastError ? { lastError: p.lastError } : {}),
      };
    } catch {
      return { done: [], failedParts: [], attempts: 0, partFailures: {} };
    }
  }

  async saveProgress(id: string, p: Progress): Promise<void> {
    await mkdir(this.dirs.progress, { recursive: true });
    await atomicWriteJson(join(this.dirs.progress, `${id}.json`), { ...p, updatedAt: new Date().toISOString() });
  }

  async clearProgress(id: string): Promise<void> {
    await rm(join(this.dirs.progress, `${id}.json`), { force: true }).catch(() => undefined);
  }

  /** 认领：outbox → inflight（原子 rename）。 */
  async claim(id: string): Promise<ClaimResult> {
    if (await tryRename(this.outboxPath(id), this.inflightPath(id))) return "claimed";
    // 同进程同 id 有互斥、跨进程有单实例锁，所以 inflight 里的文件只可能是本进程上次中断的（如抛异常），可直接续发
    return existsSync(this.inflightPath(id)) ? "already_inflight" : "missing";
  }

  /** 临时失败：inflight → outbox，等下次排空。 */
  async release(id: string): Promise<void> {
    await tryRename(this.inflightPath(id), this.outboxPath(id));
  }

  /** 从 inflight（优先）或 outbox 移到 dst */
  private async moveOut(id: string, dst: string): Promise<boolean> {
    if (await tryRename(this.inflightPath(id), dst)) return true;
    return tryRename(this.outboxPath(id), dst);
  }

  locate(id: string): Location {
    if (existsSync(this.outboxPath(id))) return "outbox";
    if (existsSync(this.inflightPath(id))) return "inflight";
    if (existsSync(join(this.dirs.sent, `${id}.json`))) return "sent";
    if (existsSync(join(this.dirs.failed, `${id}.json`))) return "failed";
    if (existsSync(join(this.dirs.expired, `${id}.json`))) return "expired";
    return "none";
  }

  /** 发送完成：inflight → sent/ */
  async archive(id: string): Promise<void> {
    await this.moveOut(id, join(this.dirs.sent, `${id}.json`)).catch(() => undefined);
    await this.clearProgress(id);
  }

  /** 永久失败：inflight（或 outbox）→ failed/<id>.json，并写 failed/<id>.reason.json */
  async fail(id: string, reason: string, progress?: Progress): Promise<void> {
    await this.moveOut(id, join(this.dirs.failed, `${id}.json`)).catch(() => undefined);
    await mkdir(this.dirs.failed, { recursive: true });
    await atomicWriteJson(join(this.dirs.failed, `${id}.reason.json`), {
      messageId: id,
      reason,
      ...(progress ? { done: progress.done, failedParts: progress.failedParts, attempts: progress.attempts } : {}),
      at: new Date().toISOString(),
    }).catch(() => undefined);
    await this.clearProgress(id);
  }

  tombstonePath(id: string): string {
    return join(this.dirs.expired, `${id}.tombstone`);
  }

  hasTombstone(id: string): boolean {
    return existsSync(this.tombstonePath(id));
  }

  /**
   * 超时：先写墓碑，再尝试 rename outbox → expired。返回谁拥有文件：
   *   "expired"  — 超时路径赢了（文件在 outbox，已移到 expired/，不会发送）；
   *   "inflight" — 已被发送方认领：墓碑已记下，发送方会在部件之间看到并停止剩余部件；
   *   "none"     — 文件还没出现（迟到的 outbox 文件之后会被直接移到 expired/）。
   */
  async tombstone(id: string): Promise<"expired" | "inflight" | "none"> {
    await mkdir(this.dirs.expired, { recursive: true });
    await atomicWriteFile(this.tombstonePath(id), new Date().toISOString() + "\n");
    if (await tryRename(this.outboxPath(id), join(this.dirs.expired, `${id}.json`))) {
      await this.clearProgress(id);
      return "expired";
    }
    return existsSync(this.inflightPath(id)) ? "inflight" : "none";
  }

  /** outbox/inflight → expired/<id>.json（不发送） */
  async expire(id: string): Promise<void> {
    await this.moveOut(id, join(this.dirs.expired, `${id}.json`)).catch(() => undefined);
    await this.clearProgress(id);
  }

  /** 发了一部分后发现墓碑：inflight → expired/，并写 expired/<id>.partial.json 说明已发/未发部件 */
  async expirePartial(id: string, prog: Progress, remaining: string[], note: string): Promise<void> {
    await this.moveOut(id, join(this.dirs.expired, `${id}.json`)).catch(() => undefined);
    await atomicWriteJson(join(this.dirs.expired, `${id}.partial.json`), {
      messageId: id,
      note,
      done: prog.done,
      failedParts: prog.failedParts,
      notSent: remaining,
      at: new Date().toISOString(),
    }).catch(() => undefined);
    await this.clearProgress(id);
  }

  isSent(id: string): boolean {
    return existsSync(join(this.dirs.sent, `${id}.json`));
  }

  /**
   * 崩溃恢复（必须在拿到单实例锁之后调用）：inflight/* → outbox/（续发时凭 progress 跳过已发部件）；
   * 有墓碑的 → expired/（附 partial 说明）。
   */
  async recoverInflight(): Promise<{ requeued: string[]; expired: string[] }> {
    const out = { requeued: [] as string[], expired: [] as string[] };
    let names: string[];
    try {
      names = (await readdir(this.dirs.inflight)).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return out;
    }
    for (const f of names) {
      const id = f.slice(0, -".json".length);
      if (this.hasTombstone(id)) {
        const prog = await this.loadProgress(id);
        await this.expirePartial(id, prog, [], "崩溃恢复：已有超时墓碑，不再续发");
        out.expired.push(id);
      } else if (await tryRename(this.inflightPath(id), this.outboxPath(id))) {
        out.requeued.push(id);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- engine

export interface ImageItem {
  realPath: string;
  filename: string;
  buf: Buffer;
  base64: string;
  md5: string;
}

export interface OutgoingFile {
  realPath: string;
  filename: string;
  size: number;
  mediaType: MediaType;
}

/** 发送通道：被动（基于原消息帧回复）或主动（sendMessage 推送）。 */
export interface Channel {
  kind: "passive" | "proactive";
  /** true：所有图片一次发出（被动 msg_item）；false：逐张作为独立部件 */
  imagesBatch: boolean;
  sendText(chunk: string, index: number): Promise<void>;
  sendFile(f: OutgoingFile): Promise<void>;
  sendImages(items: ImageItem[]): Promise<void>;
  sendCard(card: Record<string, unknown>): Promise<void>;
  /** 尽力通知用户（失败忽略） */
  notify(text: string): Promise<void>;
}

export interface EngineOptions {
  root: string;
  allowedRoots: string[];
  maxAttempts?: number;
  maxFileBytes?: number;
  maxImages?: number;
  /** 所有图片 base64 合计上限，默认 10MB */
  maxImagesBase64Bytes?: number;
  chunkBytes?: number;
  /** 临时错误计数窗口，默认 1 小时（窗口内同一部件失败 maxAttempts 次 → failed/） */
  attemptWindowMs?: number;
  /** 时钟（测试注入） */
  now?: () => number;
  log?: LogFn;
}

export type DeliveryResult =
  | { status: "sent" }
  | { status: "failed"; reason: string }
  | { status: "retry"; reason: string; attempts: number }
  /** 0.2.1：超时墓碑生效，未发（或只发了一部分，partial=true） */
  | { status: "expired"; partial?: boolean }
  /** 0.2.1：outbox/inflight 都没有该文件（且不在 sent/failed/expired） */
  | { status: "missing" };

/**
 * 记一次临时失败（按部件、按时间窗口）。返回窗口内次数。
 */
export function recordTransientFailure(prog: Progress, key: string, now: number, windowMs: number): number {
  const arr = (prog.partFailures[key] || []).filter((t) => now - t < windowMs);
  arr.push(now);
  prog.partFailures[key] = arr;
  prog.attempts = arr.length;
  return arr.length;
}

interface Part {
  key: string;
  label: string;
  run: () => Promise<void>;
}

export async function prepareImages(
  paths: string[],
  opts: EngineOptions,
): Promise<{ index: number; item: ImageItem }[]> {
  const log = opts.log || (() => undefined);
  const maxImages = opts.maxImages ?? 10;
  const cap = opts.maxImagesBase64Bytes ?? 10 * 1024 * 1024;
  const out: { index: number; item: ImageItem }[] = [];
  let total = 0;
  for (let i = 0; i < paths.length; i++) {
    if (i >= maxImages) {
      log("daemon.images_skipped", { index: i, reason: `超过 ${maxImages} 张上限` });
      continue;
    }
    const chk = await checkOutgoingFile(paths[i], {
      root: opts.root,
      allowedRoots: opts.allowedRoots,
      maxBytes: opts.maxFileBytes ?? 10 * 1024 * 1024,
      exts: [".jpg", ".jpeg", ".png"],
    });
    if (!chk.ok) {
      log("daemon.images_skipped", { index: i, reason: chk.reason });
      continue;
    }
    const b64Len = Math.ceil(chk.size / 3) * 4;
    if (total + b64Len > cap) {
      log("daemon.images_skipped", { index: i, reason: "图片合计超过 base64 总量上限" });
      continue;
    }
    let buf: Buffer;
    try {
      buf = await readFile(chk.realPath);
    } catch {
      log("daemon.images_skipped", { index: i, reason: "读取失败" });
      continue;
    }
    total += b64Len;
    out.push({
      index: i,
      item: {
        realPath: chk.realPath,
        filename: chk.filename,
        buf,
        base64: buf.toString("base64"),
        md5: createHash("md5").update(buf).digest("hex"),
      },
    });
  }
  return out;
}

async function buildParts(p: ReplyPayload, ch: Channel, opts: EngineOptions): Promise<Part[]> {
  const parts: Part[] = [];
  const text = p.text.trim() ? p.text : "";
  chunkByBytes(text, opts.chunkBytes ?? STREAM_CHUNK_BYTES).forEach((c, i) =>
    parts.push({ key: `text:${i}`, label: "文本", run: () => ch.sendText(c, i) }),
  );
  if (p.file) {
    const path = p.file;
    parts.push({
      key: "file",
      label: "文件",
      run: async () => {
        const chk = await checkOutgoingFile(path, {
          root: opts.root,
          allowedRoots: opts.allowedRoots,
          maxBytes: opts.maxFileBytes ?? 10 * 1024 * 1024,
        });
        if (!chk.ok) throw new PermanentError(chk.reason);
        await ch.sendFile({ ...chk, mediaType: detectMediaType(chk.filename) });
      },
    });
  }
  if (p.images && p.images.length) {
    const imgs = await prepareImages(p.images, opts);
    if (ch.imagesBatch) {
      if (imgs.length) parts.push({ key: "images", label: "图片", run: () => ch.sendImages(imgs.map((x) => x.item)) });
    } else {
      for (const x of imgs) parts.push({ key: `image:${x.index}`, label: "图片", run: () => ch.sendImages([x.item]) });
    }
  }
  if (p.card) {
    const card = p.card;
    parts.push({
      key: "card",
      label: "卡片",
      run: async () => {
        if (typeof card.card_type !== "string" || !card.card_type) throw new PermanentError("card 缺少 card_type");
        await ch.sendCard(card);
      },
    });
  }
  return parts;
}

/**
 * 按部件投递一条回复并落盘进度。返回 sent / failed / retry / expired / missing。
 *
 * 0.2.1：唯一入口，同一 id 进程内互斥——已有进行中的投递就直接返回它的 Promise（不会重复发送），
 * 被动回复（deliverReply）与排空（drain）都走这里，消除二者之间的检查-再执行竞态。
 */
export function runDelivery(
  store: OutboxStore,
  payload: ReplyPayload,
  ch: Channel,
  opts: EngineOptions,
): Promise<DeliveryResult> {
  const id = payload.messageId;
  const inFlight = store.runs.get(id);
  if (inFlight) {
    (opts.log || (() => undefined))("daemon.delivery_joined", { msgid: id, channel: ch.kind });
    return inFlight;
  }
  const p = runDeliveryLocked(store, payload, ch, opts).finally(() => {
    if (store.runs.get(id) === p) store.runs.delete(id);
  });
  store.runs.set(id, p);
  return p;
}

async function runDeliveryLocked(
  store: OutboxStore,
  payload: ReplyPayload,
  ch: Channel,
  opts: EngineOptions,
): Promise<DeliveryResult> {
  const id = payload.messageId;
  const log = opts.log || (() => undefined);
  const maxAttempts = opts.maxAttempts ?? 5;
  const windowMs = opts.attemptWindowMs ?? 3600_000;
  const now = opts.now ?? Date.now;

  if (store.hasTombstone(id)) {
    await store.expire(id);
    log("daemon.delivery_expired", { msgid: id, channel: ch.kind, stage: "before_claim" });
    return { status: "expired" };
  }
  const claim = await store.claim(id);
  if (claim === "missing") {
    const loc = store.locate(id);
    if (loc === "sent") return { status: "sent" };
    if (loc === "expired") return { status: "expired" };
    if (loc === "failed") return { status: "failed", reason: "已在 failed/" };
    return { status: "missing" };
  }

  const prog = await store.loadProgress(id);
  try {
    const parts = await buildParts(payload, ch, opts);
    const skip = new Set([...prog.done, ...prog.failedParts.map((f) => f.part)]);
    const todo = parts.filter((p) => !skip.has(p.key));

    for (let i = 0; i < todo.length; i++) {
      const part = todo[i];
      // 部件之间检查墓碑：超时路径没抢到文件（已在 inflight）时只能靠这里停下
      if (store.hasTombstone(id)) {
        const remaining = todo.slice(i).map((p) => p.key);
        await store.expirePartial(id, prog, remaining, "发送途中收到超时墓碑，停止剩余部件");
        log("daemon.delivery_expired", { msgid: id, channel: ch.kind, stage: "between_parts", done: prog.done, remaining });
        return { status: "expired", partial: prog.done.length > 0 };
      }
      try {
        await part.run();
        prog.done.push(part.key);
        delete prog.partFailures[part.key]; // 成功即清零
        prog.attempts = 0;
        await store.saveProgress(id, prog);
      } catch (e) {
        const reason = errText(e);
        if (isPermanentError(e)) {
          prog.failedParts.push({ part: part.key, reason });
          delete prog.partFailures[part.key];
          await store.saveProgress(id, prog);
          log("daemon.part_failed", { msgid: id, part: part.key, channel: ch.kind, reason, permanent: true });
          if (part.key === "file" || part.key === "card") {
            await ch.notify(`${part.label}发送失败：${reason}`).catch(() => undefined);
          }
          continue;
        }
        const n = recordTransientFailure(prog, part.key, now(), windowMs);
        prog.lastError = `${part.key}: ${reason}`;
        log("daemon.part_failed", { msgid: id, part: part.key, channel: ch.kind, reason, attempts: n });
        if (n >= maxAttempts) {
          const why = `临时错误在 ${Math.round(windowMs / 60000)} 分钟内重试 ${n} 次仍失败：${prog.lastError}`;
          await store.fail(id, why, prog);
          return { status: "failed", reason: why };
        }
        await store.saveProgress(id, prog);
        await store.release(id);
        return { status: "retry", reason, attempts: n };
      }
    }
  } catch (e) {
    // 意外异常（磁盘满等）：放回 outbox，别让文件卡在 inflight
    await store.release(id).catch(() => undefined);
    throw e;
  }

  if (prog.failedParts.length) {
    const why = prog.failedParts.map((f) => `${f.part}: ${f.reason}`).join("; ");
    await store.fail(id, why, prog);
    return { status: "failed", reason: why };
  }
  await store.archive(id);
  return { status: "sent" };
}

// ---------------------------------------------------------------- drain

export interface DrainDeps {
  store: OutboxStore;
  activeWaits: Set<string>;
  makeChannel: (p: ReplyPayload) => Channel;
  engine: EngineOptions;
}

export interface DrainReport {
  skipped: boolean;
  sent: string[];
  failed: string[];
  retry: string[];
  expired: string[];
}

function bucketOf(res: DeliveryResult): "sent" | "failed" | "retry" | "expired" | null {
  switch (res.status) {
    case "sent":
    case "failed":
    case "retry":
    case "expired":
      return res.status;
    default:
      return null;
  }
}

/**
 * 排空 outbox：把无人认领（不在 activeWaits）的回复主动推送出去。
 * 进程内互斥：已有一次排空在跑时直接跳过（返回 skipped:true）。
 */
export class OutboxDrainer {
  private running = false;
  constructor(private readonly d: DrainDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  async drain(): Promise<DrainReport> {
    const rep: DrainReport = { skipped: false, sent: [], failed: [], retry: [], expired: [] };
    if (this.running) return { ...rep, skipped: true };
    this.running = true;
    try {
      await this.drainOnce(rep);
    } finally {
      this.running = false;
    }
    return rep;
  }

  private async drainOnce(rep: DrainReport): Promise<void> {
    const { store, activeWaits, engine } = this.d;
    const log = engine.log || (() => undefined);
    let files: string[];
    try {
      files = (await readdir(store.dirs.outbox)).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return;
    }
    if (!files.length) return;
    log("daemon.drain_start", { count: files.length });
    for (const f of files) {
      const id = f.slice(0, -".json".length);
      if (activeWaits.has(id)) continue;
      const path = store.outboxPath(id);
      if (store.runs.has(id)) continue; // 正在被（被动回复）投递
      try {
        if (store.hasTombstone(id)) {
          await store.expire(id);
          rep.expired.push(id);
          log("daemon.drain_expired", { msgid: id });
          continue;
        }
        if (store.isSent(id)) {
          await rm(path, { force: true }).catch(() => undefined);
          await store.clearProgress(id);
          continue;
        }
        let raw: string;
        try {
          raw = await readFile(path, "utf8");
        } catch {
          continue; // 刚被别人移走
        }
        let payload: ReplyPayload;
        try {
          payload = parseOutboxPayload(raw, id);
        } catch (e) {
          // 可能是非原子写入的半截文件：按临时错误计次，超限进 failed/
          const prog = await store.loadProgress(id);
          recordTransientFailure(prog, "parse", (engine.now ?? Date.now)(), engine.attemptWindowMs ?? 3600_000);
          prog.lastError = `JSON 解析失败: ${errText(e)}`;
          if (prog.attempts >= (engine.maxAttempts ?? 5)) {
            await store.fail(id, prog.lastError, prog);
            rep.failed.push(id);
          } else {
            await store.saveProgress(id, prog);
            rep.retry.push(id);
          }
          log("daemon.drain_parse_error", { msgid: id, attempts: prog.attempts });
          continue;
        }
        payload.messageId = id; // 以文件名为准，进度/归档都按它
        if (!payload.chatId) {
          await store.fail(id, "缺少 chatId，无法主动推送");
          rep.failed.push(id);
          continue;
        }
        const res = await runDelivery(store, payload, this.d.makeChannel(payload), engine);
        const b = bucketOf(res);
        if (b) rep[b].push(id);
        log("daemon.drain_result", { msgid: id, chatId: payload.chatId, ...res });
      } catch (e) {
        log("daemon.drain_error", { msgid: id, error: errText(e) });
      }
    }
  }
}
