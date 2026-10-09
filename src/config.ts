/** config.ts — config.json / secrets.env 的加载与校验（白名单 fail-closed）。 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export interface BridgeConfig {
  wsUrl?: string;
  /**
   * 允许与机器人对话的企业微信 userid。
   * 0.2.0 起 fail-closed：为空时 daemon 拒绝启动，除非显式设置 allowAll: true。
   */
  allowedUserIds?: string[];
  /** 显式放开给所有人（仅当 allowedUserIds 为空时生效；不推荐）。 */
  allowAll?: boolean;
  /** 等待助手回复的分钟数，默认 20。 */
  replyTimeoutMin?: number;
  /**
   * 允许发出的本机文件根目录（file / images 字段）。
   * 默认 [<ROOT>/outgoing, os.tmpdir()]（以及 /tmp）。会做 realpath（跟随符号链接）后再比对。
   */
  allowedFileRoots?: string[];
  /** 为 true 时 debug.log 里记录消息原文（截断 300 字）；默认不记。 */
  logMessageText?: boolean;
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
  if (ids !== undefined && (!Array.isArray(ids) || ids.some((x) => typeof x !== "string" || !x.trim()))) {
    errors.push("allowedUserIds 必须是非空字符串数组");
  }
  const list = Array.isArray(ids) ? ids.filter((x) => typeof x === "string" && x.trim()) : [];
  if (cfg.allowAll !== undefined && typeof cfg.allowAll !== "boolean") {
    errors.push("allowAll 必须是 true/false");
  }
  if (!list.length && cfg.allowAll !== true) {
    errors.push(
      '白名单为空：请在 config.json 的 allowedUserIds 填入允许使用的企业微信 userid；' +
        '确实要对所有人开放，需显式设置 "allowAll": true',
    );
  }
  if (list.length && cfg.allowAll === true) {
    warnings.push("allowedUserIds 非空时以白名单为准，allowAll 被忽略");
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

/** 白名单判定：列表非空 → 只认列表；列表为空 → 仅当 allowAll === true 放行。 */
export function makeIsAllowed(cfg: BridgeConfig): (userid: string) => boolean {
  const list = new Set((cfg.allowedUserIds || []).filter((x) => typeof x === "string" && x.trim()));
  if (list.size > 0) return (u) => list.has(u);
  if (cfg.allowAll === true) return () => true;
  return () => false;
}
