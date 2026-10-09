/**
 * muse-backend.ts — inbox/outbox file-queue bridge between the WeCom daemon
 * and the Muse agent.
 *
 * Flow:
 *   WeCom message -> daemon -> backend.enqueue()  (writes inbox/<messageId>.json)
 *   hook wakes the Muse agent -> agent processes -> writes outbox/<messageId>.json
 *   backend.waitReply() picks it up and returns the parsed reply (daemon archives after sending)
 *
 * All writes are atomic (tmp + rename) so the hook never sees a half file.
 * 发送、归档、失败、过期由 outbox.ts 负责；这里只管入队与等待。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseOutboxPayload, type ReplyPayload } from "./outbox.js";
import type { LogFn } from "./logger.js";

export interface InboxItem {
  messageId: string;
  chatId: string;
  chatType: string;
  senderUserId: string;
  text: string;
  ts: string;
  status: "new";
  /** 用户发来的语音：text 为企业微信转写后的文本 */
  isVoice?: boolean;
  /** 用户发来的图片：daemon 已下载解密到本机，worker 可直接查看 */
  imagePath?: string;
  /** 用户发来的文件：已下载到本机 */
  filePath?: string;
  /** 用户发来的视频：已下载到本机 */
  videoPath?: string;
  /** 条目类型：普通消息（缺省）或模板卡片点击事件 */
  type?: "message" | "card_event";
  /** card_event：被点击按钮的 key */
  eventKey?: string;
  /** card_event：卡片 task_id */
  taskId?: string;
}

export interface OutboxItem {
  messageId: string;
  chatId: string;
  text: string;
  ts: string;
  /**
   * 可选：要随回复一起发给用户的文件（本机绝对路径）。
   * daemon 会走 SDK 的 uploadMedia → replyMedia（被动回复通道）把它发出去。
   * 兼容旧格式：只有 text 时就是纯文本回复。
   */
  file?: string;
  /**
   * 可选：模板卡片对象（TemplateCard），daemon 用 replyTemplateCard 发出。
   * 与 text/file 可组合：先发文本/文件，再发卡片。
   */
  card?: Record<string, unknown>;
  /**
   * 可选：要附在回复里的本机图片（JPG/PNG，单张 ≤10MB，最多 10 张）。
   * daemon 走 replyStreamWithCard 的 msgItem 直接显示在对话里，适合图文并茂的回复。
   */
  images?: string[];
}

/** waitReply 的返回：即解析后的 outbox 内容（见 outbox.ts ReplyPayload）。 */
export type ReplyResult = ReplyPayload;

export interface BackendOptions {
  /** How long to wait for the agent's reply before giving up. Default 20 min. */
  replyTimeoutMs?: number;
  /** Outbox poll interval. Default 2 s. */
  pollMs?: number;
  /** 结构化日志（可选） */
  log?: LogFn;
}

export class MuseBackend {
  private readonly replyTimeoutMs: number;
  private readonly pollMs: number;
  private readonly log: LogFn;

  constructor(
    private readonly dirs: { inbox: string; outbox: string; sent: string; inflight?: string },
    opts: BackendOptions = {},
  ) {
    this.replyTimeoutMs = opts.replyTimeoutMs ?? 20 * 60 * 1000;
    this.pollMs = opts.pollMs ?? 2000;
    this.log = opts.log ?? (() => undefined);
  }

  async init(): Promise<void> {
    for (const d of Object.values(this.dirs)) {
      await mkdir(d, { recursive: true });
    }
  }

  /** Hand a WeCom message to the Muse agent via the inbox queue. */
  async enqueue(item: InboxItem): Promise<void> {
    const tmp = join(this.dirs.inbox, `${item.messageId}.tmp`);
    const fin = join(this.dirs.inbox, `${item.messageId}.json`);
    await writeFile(tmp, JSON.stringify(item, null, 2), "utf8");
    await rename(tmp, fin);
  }

  /**
   * Wait for the agent to drop outbox/<messageId>.json and return the parsed reply.
   * Returns null on timeout. Does NOT remove the file: the caller archives it
   * only after the reply was actually sent (see outbox.ts runDelivery).
   *
   * 0.2.0：JSON 解析失败不再返回 {text:""}（那会把空回复归档、真回复丢失），
   * 而是继续轮询（只记一次日志）——worker 可能正在非原子地写，或稍后会改正；
   * 到超时仍无合法 JSON 就按超时处理（返回 null）。
   */
  async waitReply(messageId: string): Promise<ReplyResult | null> {
    const deadline = Date.now() + this.replyTimeoutMs;
    const path = join(this.dirs.outbox, `${messageId}.json`);
    // 0.2.1：排空可能已先一步把它认领到 inflight/（甚至已发完到 sent/）。也读这两处，
    // 让调用方的 runDelivery 通过同 id 互斥拿到同一个结果，而不是等到超时写墓碑。
    const alt = [this.dirs.inflight, this.dirs.sent].filter((d): d is string => !!d).map((d) => join(d, `${messageId}.json`));
    let parseErrorLogged = false;
    while (Date.now() < deadline) {
      let raw: string | null = null;
      for (const p of [path, ...alt]) {
        try {
          raw = await readFile(p, "utf8");
          break;
        } catch {
          // ENOENT 或临时读错误：继续
        }
      }
      if (raw !== null) {
        try {
          const r = parseOutboxPayload(raw, messageId);
          r.messageId = messageId;
          return r;
        } catch (e) {
          if (!parseErrorLogged) {
            parseErrorLogged = true;
            this.log("backend.outbox_parse_error", { msgid: messageId, error: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      await delay(Math.max(1, Math.min(this.pollMs, deadline - Date.now())));
    }
    return null;
  }

  /** Archive outbox/<messageId>.json to sent/ after successful delivery. */
  async archiveReply(messageId: string): Promise<void> {
    await rename(
      join(this.dirs.outbox, `${messageId}.json`),
      join(this.dirs.sent, `${messageId}.json`)
    ).catch(() => undefined);
  }
}
