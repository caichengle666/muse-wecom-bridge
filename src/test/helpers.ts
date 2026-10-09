/** 测试辅助：假客户端 + 临时 ROOT 环境。不连接任何网络。 */
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaths, type Paths } from "../paths.js";
import { MuseBackend } from "../muse-backend.js";
import { OutboxStore } from "../outbox.js";
import { CardRegistry, HeartbeatWriter, SeenStore } from "../state.js";
import { createBridge, type BotClient, type Frame } from "../bridge.js";
import type { BridgeConfig } from "../config.js";

export interface Call {
  method: string;
  args: unknown[];
}

/** 假 WSClient：记录调用；可按方法排队注入失败或挂起。 */
export class FakeClient extends EventEmitter implements BotClient {
  calls: Call[] = [];
  private failures = new Map<string, unknown[]>();
  private gates = new Map<string, Promise<void>>();
  /** 0.2.1：只让 method 的第 n 次调用（1 基）挂起在一个可控 Promise 上 */
  private nthGates = new Map<string, Map<number, Promise<void>>>();
  private uploadSeq = 0;

  /** 让 method 接下来的 times 次调用以 err 拒绝 */
  failNext(method: string, err: unknown, times = 1): void {
    const q = this.failures.get(method) || [];
    for (let i = 0; i < times; i++) q.push(err);
    this.failures.set(method, q);
  }

  /** 让 method 的调用挂起，直到返回的 release() 被调用 */
  hold(method: string): () => void {
    let release!: () => void;
    this.gates.set(method, new Promise<void>((r) => (release = r)));
    return () => {
      this.gates.delete(method);
      release();
    };
  }

  /** 让 method 的第 n 次调用挂起，直到返回的 release() 被调用（其余调用不受影响） */
  holdAt(method: string, n: number): () => void {
    let release!: () => void;
    const m = this.nthGates.get(method) || new Map<number, Promise<void>>();
    m.set(n, new Promise<void>((r) => (release = r)));
    this.nthGates.set(method, m);
    return () => release();
  }

  private async rec(method: string, args: unknown[]): Promise<void> {
    this.calls.push({ method, args });
    const nth = this.nthGates.get(method)?.get(this.of(method).length);
    if (nth) await nth;
    const g = this.gates.get(method);
    if (g) await g;
    const q = this.failures.get(method);
    if (q && q.length) throw q.shift();
  }

  of(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  async reply(frame: Frame, body: Record<string, unknown>, cmd?: string) {
    await this.rec("reply", [frame, body, cmd]);
    return { errcode: 0 };
  }
  async replyStream(frame: Frame, streamId: string, content: string, finish?: boolean, msgItem?: unknown[], feedback?: { id: string }) {
    await this.rec("replyStream", [frame, streamId, content, finish, msgItem, feedback]);
    return { errcode: 0 };
  }
  async replyWelcome(frame: Frame, body: Record<string, unknown>) {
    await this.rec("replyWelcome", [frame, body]);
    return { errcode: 0 };
  }
  async replyTemplateCard(frame: Frame, card: unknown, feedback?: { id: string }) {
    await this.rec("replyTemplateCard", [frame, card, feedback]);
    return { errcode: 0 };
  }
  async replyStreamWithCard(frame: Frame, sid: string, content: string, finish?: boolean, options?: unknown) {
    await this.rec("replyStreamWithCard", [frame, sid, content, finish, options]);
    return { errcode: 0 };
  }
  async updateTemplateCard(frame: Frame, card: unknown, userids?: string[]) {
    await this.rec("updateTemplateCard", [frame, card, userids]);
    return { errcode: 0 };
  }
  async sendMessage(chatid: string, body: unknown) {
    await this.rec("sendMessage", [chatid, body]);
    return { errcode: 0 };
  }
  async uploadMedia(buf: Buffer, opts: { type: string; filename: string }) {
    await this.rec("uploadMedia", [buf.length, opts]);
    return { media_id: `m${++this.uploadSeq}`, type: opts.type };
  }
  async downloadFile(url: string, aesKey?: string) {
    await this.rec("downloadFile", [url, aesKey]);
    return { buffer: Buffer.from("hello"), filename: "a.txt" };
  }
}

export interface Env {
  root: string;
  paths: Paths;
  client: FakeClient;
  backend: MuseBackend;
  outbox: OutboxStore;
  seen: SeenStore;
  heartbeat: HeartbeatWriter;
  cards: CardRegistry;
  logs: { event: string; data: Record<string, unknown> }[];
  exits: number[];
  bridge: ReturnType<typeof createBridge>;
}

export async function makeEnv(
  opts: { config?: BridgeConfig; replyTimeoutMs?: number; ackDelayMs?: number; kickExitDelayMs?: number; root?: string } = {},
): Promise<Env> {
  const root = opts.root ?? (await mkdtemp(join(tmpdir(), "mwb-test-")));
  const paths = makePaths(root);
  for (const d of [paths.outgoing, paths.incoming, paths.feedbackRaw]) await mkdir(d, { recursive: true });
  await writeFile(paths.secrets, "WECOM_BOT_ID=real\nWECOM_BOT_SECRET=s3cr3t\n");
  const logs: Env["logs"] = [];
  const log = (event: string, data: Record<string, unknown> = {}) => void logs.push({ event, data });
  const backend = new MuseBackend(
    { inbox: paths.inbox, outbox: paths.outbox, sent: paths.sent, inflight: paths.inflight },
    { replyTimeoutMs: opts.replyTimeoutMs ?? 2000, pollMs: 10, log },
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
  const seen = new SeenStore(paths.state);
  const heartbeat = new HeartbeatWriter(paths.heartbeat);
  const cards = new CardRegistry(paths.cards);
  const client = new FakeClient();
  const exits: number[] = [];
  const bridge = createBridge({
    client,
    paths,
    config: opts.config ?? { allowedUserIds: ["owner"] },
    backend,
    outbox,
    seen,
    heartbeat,
    cards,
    log,
    exit: (c) => void exits.push(c),
    kickExitDelayMs: opts.kickExitDelayMs ?? 20,
    ackDelayMs: opts.ackDelayMs ?? 60_000,
  });
  return { root, paths, client, backend, outbox, seen, heartbeat, cards, logs, exits, bridge };
}

let seq = 0;
export function frame(body: Record<string, unknown>): Frame {
  return { headers: { req_id: `req-${++seq}` }, body };
}

export function textFrame(msgid: string, from: string, text: string, extra: Record<string, unknown> = {}): Frame {
  return frame({ msgid, msgtype: "text", chattype: "single", from: { userid: from }, text: { content: text }, ...extra });
}

export async function writeOutbox(env: Env, id: string, payload: Record<string, unknown> | string): Promise<void> {
  const data = typeof payload === "string" ? payload : JSON.stringify({ messageId: id, ts: "t", ...payload });
  await writeFile(join(env.paths.outbox, `${id}.json`), data);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(5);
  }
  throw new Error("waitFor timeout");
}

export async function ls(dir: string): Promise<string[]> {
  return existsSync(dir) ? (await readdir(dir)).sort() : [];
}

export async function readJson(p: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return JSON.parse(await readFile(p, "utf8"));
}
