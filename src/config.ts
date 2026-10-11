/** config.ts — config.json / secrets.env 的加载与校验（白名单 fail-closed）。 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

export interface BridgeConfig {
  wsUrl?: string;
  /** 出网代理："auto"（默认，读 HTTPS_PROXY / NO_PROXY）、"off"（强制直连）或代理 URL */
  proxy?: string;
  /**
   * 允许与机器人对话的企业微信 userid。
   * 0.2.0 起 fail-closed：为空时 daemon 拒绝启动，除非显式设置 allowAll: true。
   */
  allowedUserIds?: string[];
  /**
   * 授权群的 chatid：这些群里所有成员 @机器人 都能用（私聊和别的群不受影响）。
   * 主人在群里发「/授权本群」「/取消授权本群」维护；必须先有主人（allowedUserIds 非空）才生效。
   */
  allowedChatIds?: string[];
  /** 显式放开给所有人（仅当 allowedUserIds 为空时生效；不推荐）。 */
  allowAll?: boolean;
  /**
   * 一次性配对码（npm run onboard 生成）。白名单为空时，第一个在私聊里发出这个码的人
   * 被写进 allowedUserIds，然后配对码作废。扫码接口不返回扫码人 userid，所以靠它补上主人。
   */
  pairCode?: string;
  /** 等待助手回复的分钟数，默认 20。 */
  replyTimeoutMin?: number;
  /**
   * 允许发出的本机文件根目录（file / images 字段）。
   * 默认 [<ROOT>/outgoing, os.tmpdir()]（以及 /tmp）。会做 realpath（跟随符号链接）后再比对。
   */
  allowedFileRoots?: string[];
  /** 为 true 时 debug.log 里记录消息原文（截断 300 字）；默认不记。 */
  logMessageText?: boolean;
  /** 流式输出：worker 往 stream/<messageId>.jsonl 边写边追加，daemon 推成企业微信的流式消息（打字机效果），默认 true。 */
  streamReplies?: boolean;
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function isPlaceholder(v: string): boolean {
  return !v || /^(your|test|xxx|placeholder|change)/i.test(v);
}

export async function loadSecrets(path: string): Promise<{ botId: string; botSecret: string }> {
  if (!existsSync(path)) {
    throw new Error(`缺少 ${path}，请复制 secrets.env.example 并填入 BotID / Secret`);
  }
  const env = parseEnvFile(await readFile(path, "utf8"));
  return { botId: env.WECOM_BOT_ID || "", botSecret: env.WECOM_BOT_SECRET || "" };
}

/** 读 config.json。文件不存在 → {}；JSON 损坏 → 抛错（不要静默当成空配置，那会绕过白名单校验的提示）。 */
export async function loadConfig(path: string): Promise<BridgeConfig> {
  if (!existsSync(path)) return {};
  const raw = await readFile(path, "utf8");
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("顶层必须是对象");
    return v as BridgeConfig;
  } catch (e) {
    throw new Error(`config.json 解析失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface ConfigCheck {
  errors: string[];
  warnings: string[];
}

/** 校验配置。errors 非空时 daemon 拒绝启动、check-config 失败。 */
export function validateConfig(cfg: BridgeConfig): ConfigCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = cfg.allowedUserIds;
  if (ids !== undefined) {
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string" || !x.trim())) {
      errors.push("allowedUserIds 必须是非空字符串数组");
    } else {
      if (ids.includes(EXAMPLE_USERID)) errors.push(`allowedUserIds 里还是示例占位「${EXAMPLE_USERID}」：换成真实 userid，或删掉它后运行 npm run onboard 配对`);
      const spaced = ids.filter((x) => x !== x.trim());
      if (spaced.length) errors.push(`allowedUserIds 里的 userid 前后有空格：${spaced.map((x) => JSON.stringify(x)).join("、")}`);
    }
  }
  const chats = cfg.allowedChatIds;
  if (chats !== undefined) {
    if (!Array.isArray(chats) || chats.some((x) => typeof x !== "string" || !x.trim())) {
      errors.push("allowedChatIds 必须是非空字符串数组");
    } else if (chats.some((x) => x !== x.trim())) {
      errors.push("allowedChatIds 里的 chatid 前后有空格");
    }
  }
  const list = cleanUserIds(ids);
  const groups = cleanIds(chats);
  if (cfg.allowAll !== undefined && typeof cfg.allowAll !== "boolean") {
    errors.push("allowAll 必须是 true/false");
  }
  const pairing = isValidPairCode(cfg.pairCode);
  if (cfg.pairCode !== undefined && !pairing) errors.push("pairCode 必须是 8 位大写字母/数字（重新运行 npm run onboard 生成）");
  if (pairing && list.length) warnings.push("allowedUserIds 已有人，pairCode 不再生效，可以删掉");
  if (!list.length && cfg.allowAll !== true && !pairing) {
    errors.push(
      '白名单为空：请在 config.json 的 allowedUserIds 填入允许使用的企业微信 userid；' +
        '确实要对所有人开放，需显式设置 "allowAll": true' +
        (groups.length ? "（allowedChatIds 只放行群，还必须有主人）" : ""),
    );
  }
  if (!list.length && pairing && groups.length) warnings.push("配对完成前 allowedChatIds 不生效");
  if (list.length && cfg.allowAll === true) {
    warnings.push("allowedUserIds 非空时以白名单为准，allowAll 被忽略");
  }
  if (cfg.proxy !== undefined && cfg.proxy !== "auto" && cfg.proxy !== "off" && !/^https?:\/\/[^\s]+$/i.test(String(cfg.proxy))) {
    errors.push('proxy 只能是 "auto"、"off" 或 http(s):// 开头的代理地址');
  }
  if (cfg.replyTimeoutMin !== undefined && !(typeof cfg.replyTimeoutMin === "number" && cfg.replyTimeoutMin > 0)) {
    errors.push("replyTimeoutMin 必须是正数");
  }
  if (cfg.allowedFileRoots !== undefined) {
    if (!Array.isArray(cfg.allowedFileRoots) || cfg.allowedFileRoots.some((x) => typeof x !== "string" || !x)) {
      errors.push("allowedFileRoots 必须是路径字符串数组");
    }
  }
  return { errors, warnings };
}

const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function isValidPairCode(v: unknown): v is string {
  return typeof v === "string" && /^[A-HJ-NP-Z2-9]{8}$/.test(v);
}

/** 8 位配对码（去掉易混的 0/O/1/I），约 40 bit。 */
export function newPairCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join("");
}

/** config.example.json 里的占位 userid */
export const EXAMPLE_USERID = "你的企业微信userid";

/** 列表里真正可用的 id：字符串、去掉首尾空白后非空；去重 */
export function cleanIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const t = typeof x === "string" ? x.trim() : "";
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 白名单里真正可用的 userid：同 cleanIds，再去掉示例占位 */
export function cleanUserIds(v: unknown): string[] {
  return cleanIds(v).filter((x) => x !== EXAMPLE_USERID);
}

/** 配对是否在等待中：白名单为空、未 allowAll、配对码有效。 */
export function pairingPending(cfg: BridgeConfig): boolean {
  return !cleanUserIds(cfg.allowedUserIds).length && cfg.allowAll !== true && isValidPairCode(cfg.pairCode);
}

export type IsAllowed = (userid: string, chatType: string, chatId: string) => boolean;

/**
 * 白名单判定：列表非空 → 列表里的人，或授权群（allowedChatIds）里的任何人；
 * 列表为空 → 仅当 allowAll === true 放行（没有主人时授权群不生效）。
 */
export function makeIsAllowed(cfg: BridgeConfig): IsAllowed {
  const list = new Set(cleanUserIds(cfg.allowedUserIds));
  const groups = new Set(cleanIds(cfg.allowedChatIds));
  if (list.size > 0) return (u, type, chat) => list.has(u) || (type === "group" && groups.has(chat));
  if (cfg.allowAll === true) return () => true;
  return () => false;
}
