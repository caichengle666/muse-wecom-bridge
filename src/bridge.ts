/**
 * bridge.ts — 企业微信事件 → 文件队列 → 回复 的全部业务逻辑。
 *
 * 不直接 new WSClient：客户端由调用方注入（daemon.ts 传真实 WSClient，测试传假客户端），
 * 因而所有路由、白名单、投递、排空、卡片回调、被顶号处理都可以离线测试。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { MuseBackend, InboxItem } from "./muse-backend.js";
import type { BridgeConfig } from "./config.js";
import { makeIsAllowed } from "./config.js";
import type { Paths } from "./paths.js";
import type { LogFn } from "./logger.js";
import { CardEventDedupe, type SeenStore, type HeartbeatWriter, type CardRegistry, type CardRecord } from "./state.js";
import { atomicWriteJson, errText, pruneOldFiles } from "./fsutil.js";
import { chunkByBytes } from "./chunk.js";
import { resolveAllowedRoots, type MediaType } from "./files.js";
import {
  OutboxDrainer,
  runDelivery,
  type Channel,
  type DeliveryResult,
  type EngineOptions,
  type OutboxStore,
  type ReplyPayload,
} from "./outbox.js";

/** 回调帧的最小形状（与 SDK 的 WsFrame 兼容）。 */
export interface Frame {
  headers: { req_id: string; [k: string]: unknown };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: any;
}

/** 本桥接用到的 SDK 客户端方法子集。WSClient 结构上满足它；测试用假实现。 */
export interface BotClient {
  on(event: string, fn: (...args: any[]) => void): unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
  reply(frame: Frame, body: Record<string, unknown>, cmd?: string): Promise<unknown>;
  replyStream(
    frame: Frame,
    streamId: string,
    content: string,
    finish?: boolean,
    msgItem?: unknown[],
    feedback?: { id: string },
  ): Promise<unknown>;
  replyWelcome(frame: Frame, body: Record<string, unknown>): Promise<unknown>;
  replyTemplateCard(frame: Frame, card: any, feedback?: { id: string }): Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
  replyStreamWithCard(
    frame: Frame,
    streamId: string,
    content: string,
    finish?: boolean,
    options?: { msgItem?: unknown[]; streamFeedback?: { id: string } },
  ): Promise<unknown>;
  updateTemplateCard(frame: Frame, card: any, userids?: string[]): Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
  sendMessage(chatid: string, body: any): Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
  uploadMedia(buf: Buffer, opts: { type: MediaType; filename: string }): Promise<{ media_id: string; type?: string }>;
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>;
}

export interface BridgeDeps {
  client: BotClient;
  paths: Paths;
  config: BridgeConfig;
  backend: MuseBackend;
  outbox: OutboxStore;
  seen: SeenStore;
  heartbeat: HeartbeatWriter;
  cards: CardRegistry;
  /** 0.2.1：卡片回调去重（缺省：持久化到 paths.cardEvents，TTL 10 分钟） */
  cardEvents?: CardEventDedupe;
  log: LogFn;
  /** 被顶号后退出（默认 process.exit）——测试注入 */
  exit?: (code: number) => void;
  kickExitDelayMs?: number;
  ackDelayMs?: number;
  maxAttempts?: number;
}

export const DEMO_KEYS = new Set(["demo_confirm", "demo_cancel"]);
/** 点了"已收到/已确认"这类收尾按钮：原地更新，不进 inbox */
export const DONE_KEYS = new Set(["demo_done", "muse_ack_done"]);

export const WELCOME_TEXT = `你好呀，我是你的智能助手 🤖

我能陪你聊天、查资料、写东西、跑任务。
发语音、图片、文件给我也行，我看得懂。
直接发消息开聊吧！`;

export function newStreamId(): string {
  return `stream_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

/** 点赞/点踩反馈 ID（≤256 字节）：收到 feedback_event 后凭此关联原消息。 */
export function feedbackId(tag: string): string {
  return `fb-${tag}-${Date.now().toString(36)}`.slice(0, 200);
}

/** 会话键：群聊用 chatid、单聊用 userid（与 outbox 的 chatId、卡片登记表保持一致）。 */
export function chatKeyOf(body: { chatid?: unknown; from?: { userid?: unknown } } | undefined): string {
  return String(body?.chatid || body?.from?.userid || "");
}

function safeIdPart(s: string): string {
  return s.replace(/[^A-Za-z0-9_@.-]/g, "_").slice(0, 80);
}

/** 用户引用某条消息时，把被引用的原文拼进 inbox，回复能接得上话 */
export function extractQuote(body: { quote?: { msgtype?: unknown; text?: { content?: unknown } } } | undefined): string {
  const q = body?.quote;
  if (!q) return "";
  if (q.msgtype === "text" && q.text?.content) {
    const c = String(q.text.content).trim().slice(0, 200);
    return c ? `[引用] ${c}` : "";
  }
  const labels: Record<string, string> = { image: "图片", voice: "语音", file: "文件", mixed: "图文混排" };
  return `[引用了一条${labels[String(q.msgtype)] || "消息"}]`;
}

/**
 * 卡片点击后的通用"已收到"卡片：与原卡片同 card_type（官方要求，否则 42045）。
 * 有原卡片快照时在其基础上改标题/按钮，保留类型特有的必填字段（card_action、checkbox…）。
 */
export function buildAckCard(
  rec: CardRecord | undefined,
  taskId: string,
  eventKey: string,
  fallbackType: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = rec?.card
    ? (JSON.parse(JSON.stringify(rec.card)) as Record<string, unknown>)
    : { card_type: rec?.cardType || fallbackType || "button_interaction" };
  delete base.feedback;
  const type = String(base.card_type || "button_interaction");
  base.card_type = type;
  if (taskId) base.task_id = taskId;
  if (!base.source) base.source = { desc: "Muse 助手" };
  base.main_title = { title: "✅ 已收到", desc: `你的选择：${eventKey || "（空）"}，正在处理…` };
  if (type === "button_interaction") {
    base.button_list = [{ text: "已收到", style: 2, key: "muse_ack_done" }];
    delete base.button_selection;
  }
  if ((type === "text_notice" || type === "news_notice") && !base.card_action) {
    base.card_action = { type: 1, url: "https://work.weixin.qq.com/" };
  }
  return base;
}

/**
 * 卡片事件的 inbox messageId（0.2.1）：由去重键（+ 回调 msgid，若有）确定性地派生，不再用 Date.now()。
 * 若同一 id 之前的一轮已经结束（sent/failed/expired 里有），追加 -r<n>，避免 TTL 过后再次点击被当成"已发送"。
 */
export function cardEventMessageId(key: string, evMsgid: string, taken: (id: string) => boolean = () => false): string {
  const base = `card-${createHash("sha256").update(`${key}|${evMsgid}`).digest("hex").slice(0, 24)}`;
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const id = `${base}-r${n}`;
    if (!taken(id)) return id;
  }
  return `${base}-r${randomBytes(4).toString("hex")}`;
}

export function createBridge(d: BridgeDeps) {
  const { client, paths, config, backend, outbox, seen, heartbeat, cards, log } = d;
  const cardEvents =
    d.cardEvents ??
    (() => {
      const c = new CardEventDedupe(paths.cardEvents);
      c.loadSync();
      return c;
    })();
  const isAllowed = makeIsAllowed(config);
  const exit = d.exit ?? ((code: number) => process.exit(code));
  const kickExitDelayMs = d.kickExitDelayMs ?? 1500;
  const ackDelayMs = d.ackDelayMs ?? 8000;
  const logText = config.logMessageText === true;

  const engine: EngineOptions = {
    root: paths.root,
    allowedRoots: resolveAllowedRoots(paths.root, config.allowedFileRoots),
    maxAttempts: d.maxAttempts ?? 5,
    log,
  };

  /** 正在等待/发送回复的消息 ID。排空时跳过这些；直到归档/失败完成才移除（finally）。 */
  const activeWaits = new Set<string>();

  // ------------------------------------------------------------ 发送原语

  /**
   * 长文本：每 20000 字节一段，每段是一个独立 streamId、finish=true 的流式消息。
   * （企业微信同一 streamId 的 content 是"整体覆盖"语义，增量分块只会显示最后一块。）
   * feedback 只挂在第一段。
   */
  async function replyStreamText(frame: Frame, text: string): Promise<void> {
    const chunks = chunkByBytes(text);
    for (let i = 0; i < chunks.length; i++) {
      const sid = newStreamId();
      await client.replyStream(frame, sid, chunks[i], true, undefined, i === 0 ? { id: feedbackId(sid) } : undefined);
    }
  }

  function mediaBody(type: MediaType, mediaId: string, filename: string, fb: string): Record<string, unknown> {
    return {
      msgtype: type,
      [type]: type === "video" ? { media_id: mediaId, title: filename } : { media_id: mediaId },
      feedback: { id: fb },
    };
  }

  function passiveChannel(frame: Frame, msgid: string, chatKey: string): Channel {
    return {
      kind: "passive",
      imagesBatch: true,
      async sendText(chunk, i) {
        const sid = newStreamId();
        await client.replyStream(frame, sid, chunk, true, undefined, i === 0 ? { id: feedbackId(sid) } : undefined);
      },
      async sendFile(f) {
        const buf = await readFile(f.realPath);
        log("daemon.file_uploading", { msgid, filename: f.filename, bytes: f.size, mediaType: f.mediaType });
        const up = await client.uploadMedia(buf, { type: f.mediaType, filename: f.filename });
        // replyMedia 不支持 feedback，直调 reply 透传
        await client.reply(frame, mediaBody(f.mediaType, up.media_id, f.filename, feedbackId(`fr-${msgid}`)));
        log("daemon.file_replied", { msgid, filename: f.filename, mediaType: f.mediaType });
      },
      async sendImages(items) {
        const sid = newStreamId();
        await client.replyStreamWithCard(frame, sid, "", true, {
          msgItem: items.map((x) => ({ msgtype: "image", image: { base64: x.base64, md5: x.md5 } })),
          streamFeedback: { id: feedbackId(sid) },
        });
        log("daemon.images_replied", { msgid, count: items.length });
      },
      async sendCard(card) {
        await client.replyTemplateCard(frame, card, { id: feedbackId(`card-${msgid}`) });
        cards.register(card, chatKey);
        log("daemon.card_replied", { msgid });
      },
      async notify(text) {
        await replyStreamText(frame, text);
      },
    };
  }

  function proactiveChannel(chatId: string, msgid: string): Channel {
    return {
      kind: "proactive",
      imagesBatch: false,
      async sendText(chunk, i) {
        await client.sendMessage(chatId, {
          msgtype: "markdown",
          markdown: { content: chunk },
          ...(i === 0 ? { feedback: { id: feedbackId(`pro-${msgid}`) } } : {}),
        });
      },
      async sendFile(f) {
        const buf = await readFile(f.realPath);
        const up = await client.uploadMedia(buf, { type: f.mediaType, filename: f.filename });
        await client.sendMessage(chatId, mediaBody(f.mediaType, up.media_id, f.filename, feedbackId(`pro-${msgid}`)));
      },
      async sendImages(items) {
        for (const it of items) {
          const up = await client.uploadMedia(it.buf, { type: "image", filename: it.filename });
          await client.sendMessage(chatId, mediaBody("image", up.media_id, it.filename, feedbackId(`pro-${msgid}`)));
        }
      },
      async sendCard(card) {
        await client.sendMessage(chatId, {
          msgtype: "template_card",
          template_card: card,
          feedback: { id: feedbackId(`pro-${msgid}`) },
        });
        cards.register(card, chatId);
        log("daemon.drain_card_sent", { msgid, chatId });
      },
      async notify(text) {
        await client.sendMessage(chatId, { msgtype: "markdown", markdown: { content: text } });
      },
    };
  }

  const drainer = new OutboxDrainer({
    store: outbox,
    activeWaits,
    makeChannel: (p: ReplyPayload) => proactiveChannel(p.chatId, p.messageId),
    engine,
  });

  // ------------------------------------------------------------ 回复流程

  type DeliverOutcome = DeliveryResult | { status: "timeout" };

  async function deliverReply(frame: Frame, msgid: string, chatKey: string): Promise<DeliverOutcome> {
    activeWaits.add(msgid);
    try {
      const reply = await backend.waitReply(msgid);
      if (reply === null) {
        // 写墓碑：之后迟到的 outbox 文件会被排空移到 expired/，不再主动补发过时回复
        const owner = await outbox.tombstone(msgid).catch((e) => {
          log("daemon.tombstone_error", { msgid, error: errText(e) });
          return "error";
        });
        log("daemon.reply_timeout", { msgid, owner });
        await replyStreamText(frame, "刚才处理超时了，麻烦再发一次吧。").catch(() => undefined);
        return { status: "timeout" };
      }
      const res = await runDelivery(outbox, reply, passiveChannel(frame, msgid, chatKey), engine);
      if (res.status !== "sent") log("daemon.reply_not_archived", { msgid, ...res });
      return res;
    } finally {
      activeWaits.delete(msgid);
    }
  }

  /** 8 秒内正式回复没来，先发一条"收到，正在处理"。 */
  async function deliverReplyWithAck(frame: Frame, msgid: string, chatKey: string): Promise<DeliverOutcome> {
    let ackSent = false;
    const t = setTimeout(() => {
      ackSent = true;
      log("daemon.ack_sent", { msgid });
      replyStreamText(frame, "收到，正在处理，稍等…").catch(() => undefined);
    }, ackDelayMs);
    t.unref?.();
    try {
      return await deliverReply(frame, msgid, chatKey);
    } finally {
      clearTimeout(t);
      if (ackSent) log("daemon.ack_then_replied", { msgid });
    }
  }

  /** 去重：首次见到返回 true。 */
  async function firstSeen(msgid: string): Promise<boolean> {
    if (!msgid || seen.has(msgid)) return false;
    await seen.add(msgid).catch((e) => log("daemon.seen_save_error", { error: errText(e) }));
    return true;
  }

  async function handleText(frame: Frame, textOverride?: string, isVoice?: boolean): Promise<DeliverOutcome | null> {
    const body = frame.body || {};
    const msgid = String(body.msgid || "");
    if (!(await firstSeen(msgid))) return null;
    const sender = String(body.from?.userid || "");
    const chatType = String(body.chattype || "single");
    const chatId = chatKeyOf(body);
    const text = (textOverride ?? String(body.text?.content || "")).trim();
    log("daemon.msg", { msgid, sender, chatType, len: text.length, ...(logText ? { text: text.slice(0, 300) } : {}) });

    if (!isAllowed(sender)) {
      log("daemon.blocked_not_allowed", { msgid, sender });
      await replyStreamText(frame, "抱歉，这个机器人只服务它的主人。").catch(() => undefined);
      return null;
    }
    if (!text) return null;

    const quoteCtx = extractQuote(body);
    const item: InboxItem = {
      messageId: msgid,
      chatId,
      chatType,
      senderUserId: sender,
      text: (quoteCtx ? quoteCtx + "\n" : "") + (isVoice ? `(语音转写) ${text}` : text),
      ts: new Date().toISOString(),
      status: "new",
      ...(isVoice ? { isVoice: true } : {}),
    };
    await backend.enqueue(item);
    return deliverReplyWithAck(frame, msgid, chatId);
  }

  async function handleVoice(frame: Frame): Promise<DeliverOutcome | null> {
    const body = frame.body || {};
    const transcribed = String(body.voice?.content || "").trim();
    if (transcribed) return handleText(frame, transcribed, true);
    const msgid = String(body.msgid || "");
    if (!(await firstSeen(msgid))) return null;
    const sender = String(body.from?.userid || "");
    if (!isAllowed(sender)) {
      log("daemon.blocked_not_allowed", { msgid, sender, kind: "voice" });
      return null;
    }
    await replyStreamText(frame, "没听清，再说一遍？").catch(() => undefined);
    return null;
  }

  async function handleMixed(frame: Frame): Promise<void> {
    const body = frame.body || {};
    const msgid = String(body.msgid || "");
    if (!(await firstSeen(msgid))) return;
    const sender = String(body.from?.userid || "");
    if (!isAllowed(sender)) {
      log("daemon.blocked_not_allowed", { msgid, sender, kind: "mixed" });
      return;
    }
    await replyStreamText(frame, "图文混排的消息我还看不太懂，分开发送试试。").catch(() => undefined);
  }

  /** 用户发来的媒体：下载链接 5 分钟过期，立即下载解密到 incoming/。 */
  async function downloadIncoming(msgid: string, url: string, aeskey?: string): Promise<{ path: string; filename: string } | null> {
    try {
      const { buffer, filename } = await client.downloadFile(url, aeskey);
      await mkdir(paths.incoming, { recursive: true });
      const ext = (String(filename || "").split(".").pop() || "bin").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "bin";
      const name = `${safeIdPart(msgid)}.${ext}`;
      const full = join(paths.incoming, name);
      await writeFile(full, buffer);
      log("daemon.media_downloaded", { msgid, file: name, bytes: buffer.length });
      return { path: full, filename: String(filename || name) };
    } catch (e) {
      log("daemon.media_download_error", { msgid, error: errText(e) });
      return null;
    }
  }

  async function handleMedia(frame: Frame, kind: "image" | "file" | "video"): Promise<DeliverOutcome | null> {
    const body = frame.body || {};
    const msgid = String(body.msgid || "");
    if (!(await firstSeen(msgid))) return null;
    const sender = String(body.from?.userid || "");
    const chatType = String(body.chattype || "single");
    const chatId = chatKeyOf(body);
    if (!isAllowed(sender)) {
      log("daemon.blocked_not_allowed", { msgid, sender, kind });
      return null;
    }
    const media = body[kind] || {};
    const url = String(media.url || "");
    const saved = url ? await downloadIncoming(msgid, url, media.aeskey ? String(media.aeskey) : undefined) : null;
    const quoteCtx = extractQuote(body);
    const label = kind === "image" ? "[图片]" : kind === "video" ? "[视频]" : `[文件]${saved ? " " + saved.filename : ""}`;
    const item: InboxItem = {
      messageId: msgid,
      chatId,
      chatType,
      senderUserId: sender,
      text: (quoteCtx ? quoteCtx + "\n" : "") + (saved ? label : `${label}（下载失败，请重发一次）`),
      ts: new Date().toISOString(),
      status: "new",
      ...(saved && kind === "image" ? { imagePath: saved.path } : {}),
      ...(saved && kind === "file" ? { filePath: saved.path } : {}),
      ...(saved && kind === "video" ? { videoPath: saved.path } : {}),
    };
    await backend.enqueue(item);
    log("daemon.msg", { msgid, sender, chatType, kind });
    return deliverReplyWithAck(frame, msgid, chatId);
  }

  // ------------------------------------------------------------ 事件

  async function onEnterChat(frame: Frame): Promise<void> {
    const from = String(frame.body?.from?.userid || "");
    log("daemon.enter_chat", { from });
    if (!isAllowed(from)) {
      log("daemon.blocked_not_allowed", { sender: from, kind: "enter_chat" });
      return;
    }
    await client
      .replyWelcome(frame, { msgtype: "text", text: { content: WELCOME_TEXT } })
      .catch((e) => log("daemon.welcome_error", { error: errText(e) }));
  }

  async function onFeedback(frame: Frame): Promise<void> {
    const body = frame.body || {};
    const ev = body.event || {};
    const from = String(body.from?.userid || "");
    log("daemon.feedback", { from, body: JSON.stringify(body).slice(0, 2000) });
    await mkdir(paths.feedbackRaw, { recursive: true })
      .then(() => writeFile(join(paths.feedbackRaw, `${Date.now()}.json`), JSON.stringify(body, null, 2)))
      .catch(() => undefined);
    if (!isAllowed(from)) {
      log("daemon.blocked_not_allowed", { sender: from, kind: "feedback" });
      return;
    }
    // 真实 payload：event.feedback_event.{id,type}；type 1=👍 2=👎（3 待确认）
    const fb = ev.feedback_event || ev.feedback || ev.data || {};
    const ftype: unknown = fb.type ?? fb.feedback_type ?? ev.type;
    const mark = ftype === 2 ? "👎" : ftype === 1 ? "👍" : `（type=${JSON.stringify(ftype)}）`;
    // sendMessage 走 aibot_respond_msg 通道，text 类型会被 40008 打回，用 markdown
    await client
      .sendMessage(from, { msgtype: "markdown", markdown: { content: `收到你的反馈 ${mark}，已记录。` } })
      .catch((e) => log("daemon.feedback_ack_error", { error: errText(e) }));
  }

  /**
   * 模板卡片按钮回调（必须 5 秒内 updateTemplateCard）：
   *  - demo_confirm / demo_cancel：验收用的演示卡片，原地处理；
   *  - demo_done / muse_ack_done：收尾按钮，原地更新，不进 inbox；
   *  - 其它 key：先把卡片更新为同 card_type 的"已收到"，再往 inbox 投一条
   *    {type:"card_event", eventKey, taskId, text:"[卡片点击] <key>"} 交给助手处理
   *    （助手的回复走主动推送：outbox/<该条 messageId>.json + chatId）。
   */
  async function onCardEvent(frame: Frame): Promise<void> {
    const body = frame.body || {};
    const ev = body.event || {};
    const inner = ev.template_card_event || ev.data || {};
    const eventKey = String(inner.event_key ?? ev.event_key ?? ev.key ?? "");
    let taskId = String(inner.task_id ?? ev.task_id ?? "");
    const from = String(body.from?.userid || "");
    const chatKey = chatKeyOf(body);
    log("daemon.card_event", { eventKey, taskId, from, chatKey });
    if (!isAllowed(from)) {
      log("daemon.blocked_not_allowed", { sender: from, kind: "card_event" });
      return;
    }
    if (!taskId) taskId = cards.lastTaskFor(chatKey);
    const rec = taskId ? cards.get(taskId) : undefined;
    const fallbackType = String(inner.card_type || ev.card_type || "button_interaction");

    const demoCard = (patch: Record<string, unknown>): Record<string, unknown> => ({
      card_type: rec?.cardType || "button_interaction",
      source: { desc: "Muse 助手" },
      ...(taskId ? { task_id: taskId } : {}),
      ...patch,
    });

    let card: Record<string, unknown>;
    let forward = false;
    if (eventKey === "demo_confirm") {
      card = demoCard({
        main_title: { title: "✅ 已确认执行", desc: "你的确认已收到，正在执行…" },
        button_list: [{ text: "已确认", style: 1, key: "demo_done" }],
      });
    } else if (eventKey === "demo_cancel") {
      card = demoCard({
        main_title: { title: "❌ 已取消", desc: "操作已取消" },
        button_list: [{ text: "已取消", style: 3, key: "demo_done" }],
      });
    } else if (DONE_KEYS.has(eventKey)) {
      card = buildAckCard(rec, taskId, eventKey, fallbackType);
      card.main_title = { title: "✅ 已处理", desc: "这张卡片已经处理过了" };
    } else {
      card = buildAckCard(rec, taskId, eventKey, fallbackType);
      forward = true;
    }

    try {
      await client.updateTemplateCard(frame, card);
      log("daemon.card_updated", { eventKey, taskId, from });
    } catch (e) {
      log("daemon.card_update_error", { eventKey, taskId, from, error: errText(e) });
    }

    if (!forward) return;
    // 0.2.1：去重键 = task_id + event_key + 会话键（chatid || from），TTL 内重复回调只入队一次（卡片照样更新）
    const dedupeKey = CardEventDedupe.keyOf(taskId, eventKey, chatKey || from);
    if (!cardEvents.firstSeen(dedupeKey)) {
      log("daemon.card_event_duplicate", { eventKey, taskId, from });
      return;
    }
    const evMsgid = String(body.msgid || "");
    const done = (id: string) =>
      existsSync(join(paths.inbox, `${id}.json`)) || ["sent", "failed", "expired"].includes(outbox.locate(id));
    const messageId = cardEventMessageId(dedupeKey, evMsgid, done);
    const item: InboxItem = {
      messageId,
      chatId: chatKey,
      chatType: String(body.chattype || "single"),
      senderUserId: from,
      text: `[卡片点击] ${eventKey}`,
      ts: new Date().toISOString(),
      status: "new",
      type: "card_event",
      eventKey,
      taskId,
    };
    await backend.enqueue(item);
    log("daemon.card_event_enqueued", { messageId, eventKey, taskId });
  }

  /**
   * 被顶号：同一 BotID 只允许一条长连接。SDK 收到 disconnected_event 后置 isManualClose、
   * 永不重连——进程会变成"活着但没连接"的僵尸。这里写 kicked.json 后短暂延迟退出(1)，
   * 交给 keepalive 重新拉起（拉起后认证成功会通知主人）。
   */
  async function onDisconnectedEvent(): Promise<void> {
    log("daemon.kicked", { at: new Date().toISOString() });
    await heartbeat.setConnected(false);
    await atomicWriteJson(paths.kicked, { at: new Date().toISOString(), pid: process.pid }).catch(() => undefined);
    setTimeout(() => exit(1), kickExitDelayMs);
  }

  async function onAuthenticated(): Promise<void> {
    await heartbeat.setConnected(true);
    log("daemon.authenticated", {});
    if (existsSync(paths.kicked)) {
      await rm(paths.kicked, { force: true }).catch(() => undefined);
      const owner = (config.allowedUserIds || [])[0] || "";
      if (owner) {
        await client
          .sendMessage(owner, { msgtype: "markdown", markdown: { content: "⚠️ 刚才我在别处被顶下线了，已重连回来。" } })
          .catch(() => undefined);
      }
      log("daemon.kicked_notified", { owner: !!owner });
    }
    // 排空孤儿 outbox（上次 daemon 在等回复时被重启，worker 写好的回复没人发）
    await drain();
  }

  async function onDisconnected(reason: unknown): Promise<void> {
    log("daemon.disconnected", { reason: String(reason) });
    await heartbeat.setConnected(false);
  }

  async function drain() {
    try {
      return await drainer.drain();
    } catch (e) {
      log("daemon.drain_error", { error: errText(e) });
      return null;
    }
  }

  /** 有界增长：incoming/ feedback_raw/ 7 天；sent/ expired/ failed/ 30 天。 */
  async function prune(now: number = Date.now()): Promise<Record<string, number>> {
    const DAY = 86400_000;
    const res: Record<string, number> = {
      incoming: await pruneOldFiles(paths.incoming, 7 * DAY, now),
      feedback_raw: await pruneOldFiles(paths.feedbackRaw, 7 * DAY, now),
      sent: await pruneOldFiles(paths.sent, 30 * DAY, now),
      expired: await pruneOldFiles(paths.expired, 30 * DAY, now),
      failed: await pruneOldFiles(paths.failed, 30 * DAY, now),
    };
    if (Object.values(res).some((n) => n > 0)) log("daemon.pruned", res);
    return res;
  }

  const wrap = (name: string, fn: () => Promise<unknown>) => {
    fn().catch((e) => log("daemon.handle_error", { where: name, error: errText(e) }));
  };

  /** 把所有处理器挂到客户端上。 */
  function attach(): void {
    client.on("authenticated", () => {
      console.log("muse-wecom daemon 已认证，长连接就绪。");
      wrap("authenticated", onAuthenticated);
    });
    client.on("disconnected", (reason: unknown) => wrap("disconnected", () => onDisconnected(reason)));
    client.on("reconnecting", (attempt: unknown) => log("daemon.reconnecting", { attempt }));
    client.on("error", (err: unknown) => log("daemon.error", { error: errText(err) }));
    client.on("message", (f: Frame) => log("daemon.frame.message", { msgtype: String(f.body?.msgtype || "?") }));
    client.on("event", (f: Frame) =>
      log("daemon.frame.event", {
        event: String(f.body?.event?.eventtype || f.body?.msgtype || "?"),
        from: String(f.body?.from?.userid || "?"),
      }),
    );
    client.on("message.text", (f: Frame) => wrap("text", () => handleText(f)));
    client.on("message.voice", (f: Frame) => wrap("voice", () => handleVoice(f)));
    client.on("message.image", (f: Frame) => wrap("image", () => handleMedia(f, "image")));
    client.on("message.file", (f: Frame) => wrap("file", () => handleMedia(f, "file")));
    client.on("message.video", (f: Frame) => wrap("video", () => handleMedia(f, "video")));
    client.on("message.mixed", (f: Frame) => wrap("mixed", () => handleMixed(f)));
    client.on("event.enter_chat", (f: Frame) => wrap("enter_chat", () => onEnterChat(f)));
    client.on("event.feedback_event", (f: Frame) => wrap("feedback", () => onFeedback(f)));
    client.on("event.template_card_event", (f: Frame) => wrap("card_event", () => onCardEvent(f)));
    client.on("event.disconnected_event", () => wrap("disconnected_event", onDisconnectedEvent));
  }

  /** 周期任务：心跳 30s（仅已认证时写）、排空 60s、清理 1h。返回停止函数。 */
  function startTimers(): () => void {
    const timers = [
      setInterval(() => void heartbeat.tick(), 30_000),
      setInterval(() => void drain(), 60_000),
      setInterval(() => void prune(), 3600_000),
    ];
    for (const t of timers) t.unref();
    void prune();
    return () => timers.forEach(clearInterval);
  }

  return {
    activeWaits,
    engine,
    cardEvents,
    attach,
    startTimers,
    drain,
    prune,
    handleText,
    handleVoice,
    handleMixed,
    handleMedia,
    deliverReply,
    onEnterChat,
    onFeedback,
    onCardEvent,
    onDisconnectedEvent,
    onAuthenticated,
    onDisconnected,
    replyStreamText,
  };
}

export type Bridge = ReturnType<typeof createBridge>;
