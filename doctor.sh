#!/usr/bin/env bash
# doctor.sh — 只读自检（npm run doctor）。不改任何文件、不打印密钥。
#   [OK] 正常  [WARN] 能用但有隐患  [FAIL] 必须修
# 退出码：有 FAIL 为 1，否则 0。
# 最终验收标准：关掉 Muse 网页，只用手机企业微信给机器人发消息，能收到回复才算部署完成。
set -u
CODE="$(cd "$(dirname "$0")" && pwd)"   # 代码目录（本脚本所在的仓库副本）
# 运行（数据）目录：与 daemon / keepalive 一致，MUSE_WECOM_ROOT 优先，默认就是代码目录
ROOT_RAW="${MUSE_WECOM_ROOT:-$CODE}"
ROOT="$(realpath -m -- "$ROOT_RAW" 2>/dev/null || echo "$ROOT_RAW")"
cd "$ROOT" || { echo "[FAIL] 进不去运行目录 $ROOT"; exit 2; }
FAILS=0 WARNS=0
ok()   { echo "[OK]   $*"; }
warn() { echo "[WARN] $*"; WARNS=$((WARNS + 1)); }
fail() { echo "[FAIL] $*"; FAILS=$((FAILS + 1)); }
now="$(date +%s)"
mtime() { stat -c %Y "$1" 2>/dev/null || echo 0; }
HOOK_ID="wecom-inbox-watch"

# ---- 运行环境 ----
if command -v node >/dev/null 2>&1; then
  # npm test 用到 node --test --test-concurrency（20.10 起才有）
  if node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=10)?0:1)' 2>/dev/null; then
    ok "Node.js $(node -v)"
  else
    fail "Node.js 版本过低（$(node -v)），需要 20.10+"
  fi
else
  fail "找不到 node"
fi
[ -d "$CODE/node_modules/@wecom/aibot-node-sdk" ] && ok "依赖已安装" || fail "依赖没装：npm ci"
if [ -f "$CODE/dist/daemon.js" ]; then
  newest_src="$(find "$CODE/src" -name '*.ts' -newer "$CODE/dist/daemon.js" 2>/dev/null | head -1)"
  if [ -n "$newest_src" ]; then warn "源码比编译产物新（如 $newest_src）：更新后要 npm run build 并重启 daemon"; else ok "已编译（dist/daemon.js）"; fi
else
  fail "没编译：npm run build"
fi
command -v jq >/dev/null 2>&1 && ok "jq 可用（hook 需要）" || fail "找不到 jq，hook 脚本跑不起来"

# ---- 凭证与配置 ----
if [ -f secrets.env ]; then
  perm="$(stat -c %a secrets.env 2>/dev/null || echo '?')"
  [ "$perm" = "600" ] && ok "secrets.env 权限 600" || warn "secrets.env 权限是 $perm，建议 chmod 600"
  if grep -Eq '^\s*WECOM_BOT_ID\s*=\s*\S+' secrets.env && grep -Eq '^\s*WECOM_BOT_SECRET\s*=\s*\S+' secrets.env; then
    ok "secrets.env 有 Bot ID / Secret（不显示）"
  else
    fail "secrets.env 缺 WECOM_BOT_ID / WECOM_BOT_SECRET"
  fi
else
  fail "没有 secrets.env（cp secrets.env.example secrets.env 后填 Bot ID / Secret）"
fi
if [ -f config.json ]; then
  if jq -e . config.json >/dev/null 2>&1; then
    # 与 check-config 同一规则：示例占位、空白、前后带空格的 userid 都算错
    bad="$(jq '[.allowedUserIds // [] | .[] | select(type != "string" or test("^\\s*$") or test("^\\s|\\s$") or . == "你的企业微信userid")] | length' config.json 2>/dev/null || echo 1)"
    n="$(jq '[.allowedUserIds // [] | .[] | select(type == "string" and (test("^\\s*$") or test("^\\s|\\s$") or . == "你的企业微信userid" | not))] | unique | length' config.json 2>/dev/null || echo 0)"
    if [ "${bad:-0}" -gt 0 ]; then fail "config.json 的 allowedUserIds 里有 $bad 个无效 userid（示例占位「你的企业微信userid」或前后有空格）：daemon 会拒绝启动，npm run check-config 看详情"
    elif [ "${n:-0}" -gt 0 ]; then ok "白名单 $n 人"
    elif [ "$(jq -r '.allowAll // false' config.json)" = "true" ]; then warn "allowAll=true：所有人都能用这个机器人"
    elif jq -e '.pairCode | type == "string" and test("^[A-HJ-NP-Z2-9]{8}$")' config.json >/dev/null 2>&1; then warn "白名单等待配对：在企业微信里私聊机器人发送 config.json 里的 pairCode"
    else fail "config.json 的 allowedUserIds 为空（daemon 会拒绝启动）"; fi
    gbad="$(jq '[.allowedChatIds // [] | .[] | select(type != "string" or test("^\\s*$") or test("^\\s|\\s$"))] | length' config.json 2>/dev/null || echo 1)"
    gn="$(jq '[.allowedChatIds // [] | .[] | select(type == "string" and (test("^\\s*$") or test("^\\s|\\s$") | not))] | unique | length' config.json 2>/dev/null || echo 0)"
    if [ "${gbad:-0}" -gt 0 ]; then fail "config.json 的 allowedChatIds 里有 $gbad 个无效 chatid（空白或前后有空格）：daemon 会拒绝启动"
    else ok "授权群 ${gn:-0} 个（群里所有成员 @机器人 都能用；主人在群里发 /授权本群 添加）"; fi
    [ "$(jq -r '.streamReplies // true' config.json)" = "false" ] && warn "streamReplies=false：流式打字机已关闭"
  else
    fail "config.json 不是合法 JSON"
  fi
else
  fail "没有 config.json"
fi

# ---- daemon ----
if MUSE_WECOM_ROOT="$ROOT" bash "$CODE/keepalive.sh" --status >/dev/null 2>&1; then
  ok "daemon 健康（身份核实 + 长连接已连接）"
else
  if [ -f heartbeat.json ]; then
    hb_ts="$(jq -r '((.ts // 0) / 1000 | floor)' heartbeat.json 2>/dev/null || echo 0)"
    hb_conn="$(jq -r '.connected // false' heartbeat.json 2>/dev/null || echo false)"
    fail "daemon 不健康：心跳 $(( (now - hb_ts) / 60 )) 分钟前，connected=$hb_conn。运行 bash keepalive.sh 拉起，再看 daemon.log"
  else
    fail "daemon 没在运行（没有心跳文件）：bash keepalive.sh"
  fi
fi
if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF "muse-wecom-bridge keepalive ($ROOT)"; then
  crontab -l 2>/dev/null | grep -F "muse-wecom-bridge keepalive ($ROOT)" | grep -q "NODE_BIN=" ||
    warn "cron 条目没写 node 路径（cron 的 PATH 里可能找不到 node）：重新运行 bash keepalive.sh --install-cron"
  if pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1; then ok "cron 保活已安装且 cron 在运行"; else warn "cron 条目在但 cron 服务没运行（hook 会兜底拉起，但最好 service cron start）"; fi
else
  warn "没装 cron 保活（bash keepalive.sh --install-cron）；hook 每 5 秒会兜底拉起"
fi

# ---- Muse hook ----
HOOK_SH="$HOME/hooks/scripts/$HOOK_ID.sh"
HOOK_DEF="$HOME/hooks/definitions/$HOOK_ID.json"
if [ -f "$HOOK_SH" ]; then
  hook_note=""
  if grep -q '^resolve_bridge_root()' "$HOOK_SH"; then
    # 新版 hook 自动定位桥接目录：用 hook 自己的函数算一遍（只定义函数，不跑轮询）
    hook_err="$(mktemp 2>/dev/null || echo /tmp/.wecom-doctor.$$)"
    hook_root="$(bash -c 'eval "$(sed -n "/^DEFAULT_BRIDGE_ROOT=/,/^BRIDGE_ROOT=/p" "$1" | sed "\$d")"; resolve_bridge_root' _ "$HOOK_SH" 2>"$hook_err")"
    hook_note="$(cat "$hook_err" 2>/dev/null)"; rm -f "$hook_err"
  else
    hook_root="$(sed -n 's/^BRIDGE_ROOT="\(.*\)".*/\1/p' "$HOOK_SH" | head -1)"
    hook_root="${hook_root//\$HOME/$HOME}"
  fi
  [ -n "$hook_note" ] && warn "${hook_note#wecom-inbox-watch: }"
  if [ -n "$hook_root" ] && [ "$(realpath -m -- "$hook_root" 2>/dev/null || echo "$hook_root")" != "$ROOT" ]; then
    fail "hook 定位到的桥接目录（$hook_root）不是本目录（$ROOT）：消息会没人处理（装了多份时设 MUSE_WECOM_ROOT 或改 hook 脚本里的 DEFAULT_BRIDGE_ROOT）"
  else
    ok "hook 脚本存在：$HOOK_SH（桥接目录 $ROOT）"
  fi
  if ! cmp -s "$HOOK_SH" "$CODE/hooks/$HOOK_ID.sh"; then
    warn "hook 脚本和仓库里的不一致（更新后没复制？）：cp $CODE/hooks/$HOOK_ID.sh $HOOK_SH"
  fi
else
  fail "hook 脚本不存在：$HOOK_SH（cp hooks/$HOOK_ID.sh 过去）"
fi
if [ -f "$HOOK_DEF" ]; then
  if [ "$(jq -r '.enabled // false' "$HOOK_DEF" 2>/dev/null)" = "true" ]; then
    ok "hook $HOOK_ID 已注册并启用"
    jq -r '.prompt // ""' "$HOOK_DEF" 2>/dev/null | grep -q '<bridge_root>' ||
      warn "hook 定义是旧版（prompt 里路径写死 ~/workspace/muse-wecom-bridge）：用 $CODE/hooks/$HOOK_ID.json 重新注册（保留自己的 delivery.to）"
  else
    fail "hook $HOOK_ID 注册了但没启用：消息只会躺在 inbox 里没人唤醒，让 Muse 启用它"
  fi
else
  fail "hook $HOOK_ID 没注册（$HOOK_DEF 不存在）：只有脚本不会唤醒任何人，按 SKILL.md 用 hooks.add 注册"
fi

# ---- 积压 ----
count_older() { find "$1" -maxdepth 1 -name "$2" -mmin "+$3" 2>/dev/null | wc -l; }
if [ -d inbox ]; then
  c="$(count_older inbox '*.json' 1)"
  [ "$c" -gt 0 ] && fail "inbox 有 $c 条消息超过 1 分钟没被 hook 认领：hook 没在跑或没启用"
  c="$(count_older inbox '*.json.claimed' 10)"
  [ "$c" -gt 0 ] && warn "有 $c 条消息认领超过 10 分钟还没处理完（worker 慢或崩了；超过回复超时会提醒用户）"
fi
if [ -d outbox ]; then
  c="$(count_older outbox '*.json' 3)"
  [ "$c" -gt 0 ] && fail "outbox 有 $c 条回复超过 3 分钟没发出：daemon 投递卡住，看 daemon.log"
fi
if [ -d failed ]; then
  c="$(find failed -maxdepth 1 -name '*.reason.json' -mmin -1440 2>/dev/null | wc -l)"
  [ "$c" -gt 0 ] && warn "最近 24 小时有 $c 条回复发送失败（failed/*.reason.json 里有原因）"
fi
[ "$FAILS" -eq 0 ] && [ "$WARNS" -eq 0 ] && ok "没发现问题"

echo
echo "结果：$FAILS 项必须修，$WARNS 项提醒。"
echo "最终验收：关掉 Muse 网页，只用手机企业微信给机器人发一条消息，收到回复才算真的通了。"
[ "$FAILS" -eq 0 ]
