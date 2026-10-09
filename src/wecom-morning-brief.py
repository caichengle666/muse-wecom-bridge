#!/usr/bin/env python3
"""DPMC 每日早报 → 企业微信主动推送。

每天 08:05 由 cron 运行：拉取 DPMC 资讯面板近 24 小时资讯，
排成微信友好的早报，写入 <ROOT>/outbox/proactive-<ts>.json，
daemon 的 drainOutbox（每 60 秒）会主动推送给用户。

环境变量：
  WECOM_OWNER_USERID  推送目标（机器人主人的企业微信 userid，必填）
  MUSE_WECOM_ROOT     桥接运行目录；默认本脚本所在目录的上一级（即仓库目录）
  DPMC_CLI            dpmc_news.py 路径；默认 ~/workspace/skills/dpmc/bin/dpmc_news.py

时区：DPMC 的 published_at 是不带时区的 "YYYY-MM-DD HH:MM:SS"，
按 Asia/Shanghai（UTC+8）解释；"近 24 小时"用带时区的时间比较，
与运行机器的本地时区无关（沙箱/服务器常是 UTC）。
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from zoneinfo import ZoneInfo

    SHANGHAI = ZoneInfo("Asia/Shanghai")
except Exception:  # 无 tzdata 时退回固定 +8（上海无夏令时，等价）
    SHANGHAI = timezone(timedelta(hours=8), "Asia/Shanghai")

WINDOW_HOURS = 24
ROOT = Path(os.environ.get("MUSE_WECOM_ROOT") or Path(__file__).resolve().parent.parent)
OUTBOX = ROOT / "outbox"
USERID = os.environ.get("WECOM_OWNER_USERID", "")
CLI = Path(os.environ.get("DPMC_CLI") or (Path.home() / "workspace" / "skills" / "dpmc" / "bin" / "dpmc_news.py"))


def fetch_news(limit: int = 20):
    r = subprocess.run(
        [sys.executable, str(CLI), "list", str(limit)],
        capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        raise RuntimeError(f"dpmc list failed: {r.stderr[:200]}")
    data = json.loads(r.stdout)
    return data["body"]["items"]


def parse_published(s: str):
    """把 DPMC 的无时区时间按上海时间解释为 aware datetime；格式不对返回 None。"""
    try:
        return datetime.strptime(s or "", "%Y-%m-%d %H:%M:%S").replace(tzinfo=SHANGHAI)
    except ValueError:
        return None


def filter_fresh(items, now=None, hours: int = WINDOW_HOURS, top: int = 10):
    """取 published_at ≥ now-hours 的资讯，按 priority 降序取前 top 条。now 须为 aware datetime。"""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=hours)
    fresh = []
    for it in items:
        pub = parse_published(it.get("published_at", ""))
        if pub is not None and pub >= cutoff:
            fresh.append(it)
    fresh.sort(key=lambda x: -(x.get("priority") or 0))
    return fresh[:top]


def build_text(fresh, now=None) -> str:
    now = now or datetime.now(timezone.utc)
    today = now.astimezone(SHANGHAI).strftime("%m月%d日")
    lines = [f"☀️ **DPMC 早报**（{today}）", ""]
    if not fresh:
        lines.append(f"过去 {WINDOW_HOURS} 小时无新资讯。")
    else:
        for it in fresh:
            title = (it.get("title") or "").strip()
            # 标题自带 🔴/🟠 标签，直接用
            lines.append(f"• {title}")
        lines += ["", f"共 {len(fresh)} 条，完整版见 DPMC 资讯面板。"]
    return "\n".join(lines)


def main() -> int:
    if not USERID:
        print("WECOM_OWNER_USERID 未设置", file=sys.stderr)
        return 2
    try:
        items = fetch_news(20)
    except Exception as e:
        print(f"fetch failed: {e}", file=sys.stderr)
        return 1

    now = datetime.now(timezone.utc)
    fresh = filter_fresh(items, now)
    text = build_text(fresh, now)

    OUTBOX.mkdir(parents=True, exist_ok=True)
    # 原子写：先写 tmp 再 rename，避免 daemon 读到半截文件（.tmp 不以 .json 结尾，排空不会读它）
    fname = f"proactive-{int(time.time())}.json"
    tmp = OUTBOX / (fname + ".tmp")
    payload = {
        "messageId": fname[: -len(".json")],
        "chatId": USERID,
        "text": text,
        "ts": now.astimezone(SHANGHAI).isoformat(),
    }
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp.rename(OUTBOX / fname)
    print(f"wrote {fname} ({len(fresh)} items)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
