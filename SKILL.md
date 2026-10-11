# muse-wecom-bridge

企业微信智能机器人 × Muse 双向桥接：手机上跟企业微信机器人聊天，消息经本地队列转给 Muse 处理，回复发回企业微信。

## 适用场景

- 想在企业微信里直接跟 Muse 对话（文本、语音、图片、文件、视频）
- 需要 Muse 主动推送消息到企业微信（如每日早报、告警）
- 需要模板卡片交互（按钮确认、投票等）

## 运行要求

- Node.js 18+
- 企业微信管理后台建**智能机器人**（工作台 → 智能机器人 → API 模式 → 长连接），拿到 BotID 和 Secret
- 机器人可见范围内的人才能用；`config.json` 的 `allowedUserIds` 白名单 fail-closed（为空拒绝启动，除非在等配对码）

## 部署

```bash
git clone https://github.com/caichengle666/muse-wecom-bridge && cd muse-wecom-bridge
npm install
npm run build && npm test
npm run onboard   # 终端出二维码，让用户用手机企业微信扫码「一键创建智能机器人」；自动写 secrets.env，并在 config.json 生成 8 位配对码
# 扫码不可用时手动：cp secrets.env.example secrets.env 填 WECOM_BOT_ID/SECRET（chmod 600）；cp config.example.json config.json 填 allowedUserIds
bash keepalive.sh --install-cron && bash keepalive.sh   # 常驻
# 注册 hook（见下文「消息处理 hook」）后：
npm run doctor   # 只读自检，全部 OK 才算部署完成；FAIL 项按提示修
```

部署收尾：`npm run doctor` 没有 FAIL 后，请用户**关掉 Muse 网页、只用手机企业微信**私聊机器人：扫码建的先发 onboard 打印的配对码（回"配对成功"即进白名单），再随便发一条，收到回复才算真的通了。

## 扫码失败时

`npm run onboard` 用的是企业微信官方 CLI 的扫码接口（未写进文档），失效时让用户在手机企业微信 **工作台 → 智能机器人 → 创建机器人 → 手动创建 → API 模式 → 长连接** 建好，把 Bot ID / Secret 告诉你写进 `secrets.env`；白名单填用户的企业微信 userid（管理后台通讯录「账号」栏）。

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
- `/stop`（`@机器人 /stop` 也行）：daemon 直接处理，中断本会话所有没回完的消息——inbox 文件移到 `expired/` 并留 `<id>.stopped`、等待立即结束、写墓碑（迟到的回复不发）、写 `stop/<会话>.json`；worker 每步动手前检查自己的 `.claimed` 是否还在，不在就停；脚本收割时把被中断的那条记成"被中断"一轮，之后第一条新消息的上下文带 `after_stop: true`
- `/clear`（群里 `@机器人 /clear` 也行）：脚本认领时直接把历史归档（保留 30 天），这条和同会话更早没回完的都不进新历史；用户用自然语言说换话题时，worker 写 `wecom-ctx-<ctx_key>.clear.json`：`{messageId}`，效果相同
- `/compact [重点]`（群里 `@机器人 /compact` 也行）：手动压缩，这条本身不进历史；上下文带 `compact: true`、`compact_hint`、`size_bytes`，并强制 `compress_needed: true`，worker 把 summary 和除最近 2 轮外的带 seq 的轮压成摘要，照常写 `wecom-ctx-<ctx_key>.summary.json`；还在处理中的任务（没 seq 的）不动，回复后照常入历史
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
