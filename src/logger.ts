/**
 * logger.ts — 结构化 JSONL 日志，带大小轮转（默认 10MB，保留 1 份旧日志 debug.log.1）。
 * 写入串行化，轮转与追加不会交错。日志失败永不抛出。
 */
import { appendFile, rename, stat } from "node:fs/promises";
import { SerialQueue } from "./fsutil.js";

export type LogFn = (event: string, data?: Record<string, unknown>) => void;

export class RotatingLogger {
  private readonly q = new SerialQueue();
  private size = -1;

  constructor(
    private readonly path: string,
    private readonly maxBytes: number = 10 * 1024 * 1024,
  ) {}

  /** 返回一个 fire-and-forget 的日志函数 */
  get fn(): LogFn {
    return (event, data = {}) => void this.write(event, data);
  }

  write(event: string, data: Record<string, unknown> = {}): Promise<void> {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
    return this.q.run(async () => {
      try {
        if (this.size < 0) {
          this.size = await stat(this.path).then((s) => s.size, () => 0);
        }
        const bytes = Buffer.byteLength(line, "utf8");
        if (this.size > 0 && this.size + bytes > this.maxBytes) {
          await rename(this.path, this.path + ".1").catch(() => undefined);
          this.size = 0;
        }
        await appendFile(this.path, line, "utf8");
        this.size += bytes;
      } catch {
        /* 日志失败不影响主流程 */
      }
    });
  }

  /** 等待所有已排队的写入完成（测试与退出前用）。 */
  flush(): Promise<void> {
    return this.q.run(async () => undefined);
  }
}
