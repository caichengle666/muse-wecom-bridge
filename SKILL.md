# muse-wecom-bridge

企业微信智能机器人 × Muse 双向桥接：手机上跟企业微信机器人聊天，消息经本地队列转给 Muse 处理，回复发回企业微信。

## 适用场景

- 想在企业微信里直接跟 Muse 对话（文本、语音、图片、文件、视频）
- 需要 Muse 主动推送消息到企业微信（如每日早报、告警）
- 需要模板卡片交互（按钮确认、投票等）

## 运行要求

- Node.js 18+
- 企业微信管理后台建**智能机器人**（工作台 → 智能机器人 → API 模式 → 长连接），拿到 BotID 和 Secret
- 机器人可见范围内的人才能用；`config.json` 的 `allowedUserIds` 白名单 fail-closed（为空拒绝启动）

## 部署

```bash
git clone https://github.com/caichengle666/muse-wecom-bridge && cd muse-wecom-bridge
npm install
cp secrets.env.example secrets.env   # 填入 WECOM_BOT_ID / WECOM_BOT_SECRET，chmod 600
cp config.example.json config.json   # 填 allowedUserIds（企业微信 userid）
npm run build && npm test
npm start                            # 或用 keepalive.sh + cron 常驻
```

## 不会申请机器人？让 Muse 代办

没操作过企业微信管理后台不用自己研究——直接在 **Muse App 里开启浏览器操作模式**，跟 Muse 说：

> "帮我在企业微信创建一个 Muse 智能机器人"

Muse 会在浏览器里帮你走完：

1. 进入企业微信管理后台，创建智能机器人并切换到 API 模式 + 长连接
2. 取出 BotID 和 Secret，帮你写好 `secrets.env`（密钥只存你本地，不会外传）

你只需要在登录、扫码验证这类环节接管一下浏览器。

白名单要填你自己的企业微信 userid（一般在管理后台通讯录里能看到，不知道的话让 Muse 帮你找），填进 `config.json` 的 `allowedUserIds` 后重启。

## 消息处理 hook（部署时必建）

inbox 里的消息不会自己处理——部署完 daemon 后要在 Muse 里建一个轮询 hook。`hooks/` 目录已备好：

- `hooks/wecom-inbox-watch.sh` → 复制到 `~/hooks/scripts/wecom-inbox-watch.sh`，`chmod +x`；桥接没装在 `~/workspace/muse-wecom-bridge` 的话改脚本里的 `BRIDGE_ROOT`（hook 定义 prompt 里的路径也一起改）
- `hooks/wecom-inbox-watch.json` → 用 `hooks.add` 注册，把 `delivery.to` 换成自己的 side chat ID；`poll_interval_secs` 用 5（hook 允许的最小值）
- 轮询脚本原子认领（`<id>.json` → `<id>.json.claimed`）后 `wake`；worker 读 claimed → 写 outbox（先 `.tmp` 再 mv）→ 删 claimed
- claimed 25 分钟没被消费会被重新认领

### 多轮上下文（hook 自带，无需改桥接代码）

每次 wake 都是全新的 worker，默认没有上文。轮询脚本自动维护每个会话（单聊按对方 userid、群按 chatid）的历史，**历史文件只由脚本写**：

- 认领时记下用户原文（附件记文件名）→ 回复归档到 `sent/` 后 → 追加一轮到 `~/hooks/state/wecom-ctx-<key>.json`
- 唤醒时按 messageId 写进上下文文件 `~/hooks/state/wecom-wake-*.json`：`{messageId: {ctx_key, summary, turns, compress_needed}}`，payload 只带 `context_file` 路径（上下文可能很大，不塞进 wake 参数）；同一会话里还没回完的前几条也会带上；文件一天后自动删
- 只按大小限制（512KB，UTF-8 字节，含摘要），不按轮数。超限时给最新那条标 `compress_needed`，worker 回复完后把最旧的几轮压缩成摘要，写 `wecom-ctx-<ctx_key>.summary.json`：`{summary, upto_seq}`，脚本下一轮合并（删掉 seq ≤ upto_seq 的轮）
- worker 一直没压缩、涨到 2 倍上限时，脚本兜底从最旧的开始丢
- `/clear`（群里 `@机器人 /clear` 也行）：脚本认领时直接把历史归档（保留 30 天），这条和同会话更早没回完的都不进新历史；用户用自然语言说换话题时，worker 写 `wecom-ctx-<ctx_key>.clear.json`：`{messageId}`，效果相同
- 普通历史 7 天没动自动删；state 全部原子写入；轮询脚本加了 flock，同一时刻只跑一个
- 单聊和每个群各自一份；群里多人说话时不区分是谁

## 外部影响

- 本机主动向外建 WebSocket 长连接（`wss://openws.work.weixin.qq.com`），无需公网回调地址
- 收到的图片/文件/视频会下载解密存到本地 `incoming/`
- 同一 BotID 只允许一条长连接；多开会互顶，被顶掉的实例自动退出由保活重拉

## 重要边界

- 这是**企业微信智能机器人**方案，不是微信个人号——不要跟 iLink/个人号方案混淆
- 消息处理逻辑（AI 后端）由部署者自己接 `inbox/`/`outbox/` 文件队列实现，本仓库只提供桥接层
- `secrets.env` 含机器人密钥，绝不提交；外发文件白名单仅限 `outgoing/` 与 `/tmp`，拒绝 `*.env` 等敏感文件
- 语音消息用的是企业微信自带的转写文本，不另做语音识别
