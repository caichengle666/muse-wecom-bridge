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

## 外部影响

- 本机主动向外建 WebSocket 长连接（`wss://openws.work.weixin.qq.com`），无需公网回调地址
- 收到的图片/文件/视频会下载解密存到本地 `incoming/`
- 同一 BotID 只允许一条长连接；多开会互顶，被顶掉的实例自动退出由保活重拉

## 重要边界

- 这是**企业微信智能机器人**方案，不是微信个人号——不要跟 iLink/个人号方案混淆
- 消息处理逻辑（AI 后端）由部署者自己接 `inbox/`/`outbox/` 文件队列实现，本仓库只提供桥接层
- `secrets.env` 含机器人密钥，绝不提交；外发文件白名单仅限 `outgoing/` 与 `/tmp`，拒绝 `*.env` 等敏感文件
- 语音消息用的是企业微信自带的转写文本，不另做语音识别
