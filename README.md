# 企业微信 × Muse 智能助手桥接

把企业微信**智能机器人**（API 模式 + WebSocket 长连接）和 Muse 接起来：
你在企业微信里跟机器人聊天，消息经本地队列转给 Muse 处理，回复再发回企业微信。
支持文本、语音、图片、文件、视频、模板卡片、点赞反馈、主动推送。

## 最快部署：把 SKILL.md 丢给 Muse

不用读下面的文档。在 Muse App 里开启浏览器操作模式，把这个链接发给它：

```
https://github.com/caichengle666/muse-wecom-bridge/blob/main/SKILL.md
请按这个 skill 帮我部署企业微信桥
```

Muse 会照着 SKILL.md 自己走完：创建企业微信智能机器人、拿 BotID 和 Secret，写好密钥、装依赖、编译、注册 hook、跑起来。你只需要在登录、扫码这类环节接管一下浏览器，最后给机器人发一条消息让 Muse 填好你的白名单 userid。

下面是给想自己动手或想了解原理的人看的。

## 功能清单

| 方向 | 能力 |
|------|------|
| 接收 | 文本、语音（企业微信已转写）、图片/文件/视频（自动下载解密）、引用消息 |
| 回复 | 流式打字机（边生成边显示）、流式文本、文件/图片/视频（按扩展名原生发出）、模板卡片（5 种类型）、流式配图（最多 10 张） |
| 交互 | 模板卡片按钮回调 + 5 秒内动态更新卡片、进入会话欢迎语、点赞/点踩反馈、被顶号感知 |
| 主动 | 定时/事件触发主动推送（文本、卡片、文件、图片），如每日 DPMC 早报 |
| 可靠 | 孤儿回复排空补发（按部件记进度，绝不重发已发部分）、失败/过期分流、inbox 原子认领、心跳 + 保活脚本（cron + hook 兜底拉起）、被顶号自动退出由保活拉起、回复积压告警、`npm run doctor` 自检 |
| 安全 | 白名单 fail-closed、外发文件 realpath + 允许目录 + 敏感文件名拒绝、默认不记录消息原文 |

## 准备工作

**最省事：扫码建机器人**。装好依赖后运行 `npm run build && npm run onboard`，终端会打出二维码（同时存一张 `onboard-qr.png`），用手机企业微信扫码、点「一键创建智能机器人」即可：

- Bot ID / Secret 自动写进 `secrets.env`（600，不在终端显示）；
- 扫码接口拿不到扫码人的 userid，所以白名单为空时会生成一个 8 位**配对码**写进 `config.json`。daemon 启动后，在企业微信里**私聊**机器人发送这个配对码，你就自动进了白名单，配对码随即作废；配对前别人发消息只会收到"还没绑定主人"的提示；
- 只能新建机器人。这个扫码接口是企业微信官方 CLI（`@wecom/wecom-openclaw-cli`）在用的，没写进开发者文档，哪天失效就按下面手动建。

手动建：

1. 企业微信 → **工作台 → 智能机器人**（注意不是「自建应用」，两者名字可以一样，聊错对象是第一大坑）
2. 创建机器人 → 手动创建 → **API 模式** → 连接方式选 **长连接**
3. 可见范围按需设置（仅自己用就选仅自己）
4. 从机器人详情页拿到 **BotID** 和 **Secret**


## 部署步骤

```bash
# 1. 克隆
git clone <你的仓库地址> muse-wecom-bridge && cd muse-wecom-bridge

# 2. 安装依赖（需要 Node.js 20+；测试用到 node --test）
npm ci

# 3. 配凭证和白名单（扫码建的跳过这步，onboard 已写好 secrets.env 和 config.json）
cp secrets.env.example secrets.env
# 编辑 secrets.env，填入 WECOM_BOT_ID 和 WECOM_BOT_SECRET
chmod 600 secrets.env

# 4. 配 config.json（已在 .gitignore 中）
cp config.example.json config.json
# allowedUserIds 填允许使用的企业微信 userid（通讯录"账号"栏）。
# 白名单 fail-closed：为空时 daemon 拒绝启动、check-config 失败；
# 确实要对所有人开放，必须显式写 "allowAll": true（allowedUserIds 非空时以列表为准，allowAll 被忽略）。

# 5. 编译
npm run build

# 6. 检查配置
npm run check-config

# 7. 启动
npm start
# 看到 "已认证，长连接就绪" 即成功

# 8. 跑测试（离线，不连企业微信；需要 Linux /proc 与 python3）
npm test
```

### config.json 字段

| 字段 | 默认 | 说明 |
|------|------|------|
| `allowedUserIds` | （必填） | 允许对话的 userid 列表；为空则拒绝启动，除非 `allowAll: true` 或有待配对的 `pairCode` |
| `pairCode` | — | `npm run onboard` 生成的一次性配对码；白名单为空时第一个私聊发出它的人进白名单，随后自动删除 |
| `allowAll` | `false` | 显式对所有人开放（仅当列表为空时生效，不推荐） |
| `replyTimeoutMin` | `20` | 等助手回复的分钟数，超时后写墓碑、迟到回复不再补发 |
| `wsUrl` | `wss://openws.work.weixin.qq.com` | 长连接网关 |
| `allowedFileRoots` | `[<ROOT>/outgoing, os.tmpdir(), /tmp]` | outbox `file`/`images` 允许的目录（支持 `~/`）；realpath 后比对 |
| `logMessageText` | `false` | 为 `true` 时 debug.log 记录消息原文（截断 300 字） |
| `streamReplies` | `true` | 流式打字机，见"流式输出" |

环境变量 `MUSE_WECOM_ROOT` 可覆盖运行目录（默认是仓库目录，即 `dist/` 的上一级）；daemon、keepalive.sh、早报脚本都认它。

### 常驻运行（保活）

同一 BotID 只允许**一条**长连接。daemon 启动时自己用 O_EXCL 创建 `daemon.lock`（同 ROOT 已有存活 daemon 则拒绝启动，
已死进程留下的陈旧锁会被安全回收），并写 `daemon.pid`。两者内容都是一行 `<pid> <starttime> <token>`：starttime 是
`/proc/<pid>/stat` 第 22 字段（防 pid 复用），token 是每次启动随机生成的令牌。`heartbeat.json` 为
`{pid, ts, connected, token}`：启动即写一次 `connected:false`，认证成功后每 30 秒写 `connected:true`，断线时立即写一次 `connected:false` 并停止刷新。

`keepalive.sh` 以**脚本所在目录**为 ROOT（可用 `MUSE_WECOM_ROOT` 覆盖，一律 realpath 规范化）。认定"是我们的 daemon"需要同时满足：
pid 存在、当前 starttime 与 pid 文件相同、心跳的 pid 与 token 与 pid 文件相同、命令行里的 `daemon.js`（相对路径按进程 cwd 解析）
realpath 后就是 `$ROOT/dist/daemon.js`。**只有身份完全核实才会 kill**；pid 被复用的无关进程绝不会被误杀。判定健康的条件：

- 身份核实，且
- 进程启动不足 90 秒（给认证机会），或 `connected:true` 且 90 秒内更新，
  或 `connected:false` 但断线不足 90 秒（SDK 正在自动重连）。

其余情况（被顶号后的僵尸、长时间断线、心跳停滞）杀掉重拉；拉起后等到身份核实且 `connected:true` 的心跳才算成功。
keepalive 自身用 flock 防并发（拿不到锁会在 daemon.log 记一行）；系统没有 flock 时警告并退回 mkdir 锁。

```bash
bash keepalive.sh            # 检查并在需要时拉起
bash keepalive.sh --status   # 只检查，健康 exit 0 / 不健康 exit 1

bash keepalive.sh --install-cron    # 一键装 cron：每 5 分钟检查 + 开机 30 秒后拉起（可重复执行）
bash keepalive.sh --uninstall-cron
```

被顶号后 daemon 会主动退出、等保活拉起。此外：

- **hook 兜底拉起**：hook 每 5 秒轮询时顺便看心跳，超过 90 秒没更新就直接调用 `keepalive.sh`（最多每 2 分钟一次），不依赖 cron——Muse 虚拟机重启后 cron 不一定在
- **静默断线**：SDK 每 30 秒发心跳，连续 2 次没收到回应就判定断线并自动重连
- **积压告警**：回复在 `outbox/` 里超过 3 分钟没发出，hook 会唤醒 Muse 排查（同一故障每小时最多提醒一次）

### 自检（npm run doctor）

只读检查，不改文件、不显示密钥：Node/依赖/编译是否最新、secrets.env 权限与凭证、白名单、daemon 健康、cron、hook 脚本是否存在且指向本目录、**hook 定义是否注册并启用**（只复制脚本不会唤醒任何人）、inbox/outbox 积压、最近失败。有 FAIL 退出码为 1。

最终验收：关掉 Muse 网页，只用手机企业微信给机器人发一条消息，收到回复才算真的通了。

可调环境变量：`MUSE_WECOM_GRACE_SEC`（断线宽限，默认 90）、`MUSE_WECOM_START_GRACE_SEC`（新进程宽限，默认同前）、
`MUSE_WECOM_STALE_SEC`（心跳停滞阈值，默认 90）、`MUSE_WECOM_WAIT_SEC`（拉起后等待认证，默认 45）、
`MUSE_WECOM_FLOCK_BIN`（flock 路径；设为空串强制走 mkdir 锁）。`source keepalive.sh` 只定义函数不执行（测试用）。

> 如果你的环境有 systemd user，可自行写 service；本项目默认用 keepalive.sh + cron 方案。

## 消息是怎么流转的

```
企业微信用户
  → daemon（WebSocket 长连接，dist/daemon.js）
  → inbox/<消息id>.json          ← 你的 AI 处理程序从这里取消息
  → outbox/<消息id>.json         ← 你的 AI 把回复写到这里
  → daemon 发回企业微信
  → sent/<消息id>.json           ← 已发送归档
```

- **inbox**：daemon 收到的每条消息。文本直接是 `text`；图片/文件/视频会被 daemon 立刻下载解密到 `incoming/`，inbox 里带 `imagePath` / `filePath` / `videoPath` 本机路径；语音的 `text` 开头带 `(语音转写)`；引用消息的 `text` 开头带 `[引用] 原文`。
- **outbox**：回复写成 JSON：`{"messageId","chatId","text","ts"}`（**先写 `.tmp` 再 rename**），可选加：
  - `"file"`: 本机文件**绝对路径**，≤10MB，按扩展名原生发出。只允许 `allowedFileRoots`（默认 `<ROOT>/outgoing`、
    系统临时目录、`/tmp`）之下；会先 realpath（跟随符号链接）再判断；项目目录内只允许 `outgoing/`；
    敏感文件名（`*.env`、`.env*`、`secrets*`、`state.json`、`heartbeat.json`、`config.json`、`cards.json`、
    `daemon.pid`、`id_rsa*`/`id_ed25519*`、`*.pem`、`*.key`、`.ssh/` 下等）一律拒绝。
  - `"card"`: 企业微信 TemplateCard 对象（模板卡片，需带 `card_type`；要接收按钮回调请带唯一 `task_id`）
  - `"images"`: 本机图片路径数组（JPG/PNG、单张 ≤10MB、最多 10 张、base64 合计 ≤10MB，超出的跳过并记日志；校验规则同 `file`）
- **JSON 写坏了**：daemon 不会把它当空回复；会继续等到超时（被动）或按临时错误重试（排空）。
- **投递与归档**：一条回复按"文本分段 → 文件 → 图片 → 卡片"逐部件发送，每发完一个部件记入 `progress/<id>.json`，
  已发部件**永不重发**。结果分流：
  - 全部成功 → `sent/<id>.json`；
  - 永久错误（本地校验失败，或 errcode 40008/42044/42045/40058）→ 其余部件照发，整条移到 `failed/<id>.json`，
    原因写在 `failed/<id>.reason.json`；文件/卡片失败会给用户发一条"xx发送失败：原因"；
  - 临时错误（限频、断线、回执超时…）→ 留在 outbox，排空时重试，最多 5 次后进 `failed/`；
  - 等回复超时 → 写墓碑 `expired/<id>.tombstone`，之后迟到的 outbox 文件直接移到 `expired/`，不再补发。
- **卡片点击**：演示按钮（`demo_confirm`/`demo_cancel`）daemon 原地处理；其它按钮 daemon 先把卡片更新为
  **同 card_type** 的"✅ 已收到"（基于原卡片快照，保留类型必填字段），再往 inbox 写一条
  `{"type":"card_event","eventKey","taskId","text":"[卡片点击] <key>", ...}`，messageId 形如 `card-<事件msgid>`。
  助手处理后照常写 `outbox/<该 messageId>.json`（带 `chatId`），由排空**主动推送**。
- **防重**：`sent/` 里有就说明已回过，处理程序应跳过。

`src/` 下有三个独立小脚本（都会顶掉 daemon 连接，用完记得重启 daemon）：

| 脚本 | 用途 |
|------|------|
| `send-test.mjs <userid> <文字>` | 发文字冒烟测试 |
| `send-file.mjs <userid> <文件>` | 发文件冒烟测试 |
| `send-card-demo.mjs <userid>` | 发按钮交互卡片冒烟测试 |

## 消息处理 hook 与多轮上下文

`hooks/` 里是 Muse 侧的轮询脚本和 hook 定义模板（安装见 SKILL.md），机制与 muse-feishu-bridge 相同：回复真正发出后记一轮，唤醒时把本会话的摘要 + 历史轮写进上下文文件、payload 带路径；每个会话上限 512KB（UTF-8），超了由 worker 压缩成摘要交给脚本合并；发 `/clear` 开始新话题；发 `/compact`（可带重点）手动压缩，保留最近 2 轮原文、进行中的任务不受影响；发 `/stop` 立刻中断本会话进行中的任务（daemon 直接处理，旧回复不再发出，worker 每步检查自己的 `.claimed` 不在就停），之后直接发新指令。没有新消息时 hook 还会看 `heartbeat.json`，超过 10 分钟没更新（daemon 挂了/一直连不上，keepalive 也没救回来）就唤醒 worker 去拉起、修复并报告，同一个故障每小时最多提醒一次。

## 主动推送

往 `outbox/` 写一个 `proactive-<时间戳>.json`（先写 `.tmp` 再 rename，原子操作）：

```json
{
  "messageId": "proactive-1699999999",
  "chatId": "目标用户userid",
  "text": "早报内容（支持 markdown）",
  "ts": "2026-10-10T08:05:00"
}
```

daemon 认证成功时 + 每 60 秒排空一次（进程内互斥，不会并发跑两遍），无人等待的 outbox 会走**主动推送**发出。
长文本按 20000 字节分成多条 markdown 发送。`src/wecom-morning-brief.py` 是个例子：
每天 08:05 拉 DPMC 资讯面板近 24 小时资讯（`published_at` 按 Asia/Shanghai 解释、带时区比较，与机器时区无关），
生成早报写入 `<ROOT>/outbox`，配个 cron 就行。
用前先设置推送目标：`export WECOM_OWNER_USERID=你的企业微信userid`；ROOT 默认为脚本上一级目录，可用 `MUSE_WECOM_ROOT` 覆盖，
DPMC CLI 路径可用 `DPMC_CLI` 覆盖。

## 流式输出（打字机效果）

worker 写长回复时边写边往 `stream/<id>.jsonl` 追加，每次一整行 `{"text":"<这一段>"}`，各段原样拼接。daemon 把累计内容推到这条消息的企业微信流式消息上（同一 streamId 整体覆盖，每 3 秒最多刷新一次，照顾会话 30 条/分钟的限频）：

- "收到，正在处理"就是这条流式消息本身，后续内容直接在上面长出来；正式回复（`outbox/<id>.json`）到达后第一段定格在这条消息上，超长部分照常另发
- 流式消息从首次发送起 10 分钟内必须结束：快到 9 分钟还没写完就先收尾（注明"完成后另发"），正式回复另发新消息；刷新失败也自动改为另发
- 被 `/stop`、超时、出错时流式消息会收尾，不会一直显示"生成中"
- `config.json` 设 `"streamReplies": false` 关闭

## 排障手册（都是真踩过的坑）

先跑 `npm run doctor`，按 FAIL 项修。

1. **聊错对象**：去「工作台 → 智能机器人」栏目进聊天，别去「自建应用」。
2. **单连接限制**：同一 BotID 一条长连接。调试脚本运行前先停 daemon，跑完重启；保活拉起前双重确认。
3. **846607 限频**：新机器人主动推送可能第一次就报频率限制，被动回复不受影响，养一段时间就好。
4. **媒体类型别写死**：`uploadMedia` 的 type 按扩展名识别（mp4→video、png/jpg→image、mp3→voice），写死 `"file"` 会导致视频只能当附件收。
5. **收文件的链接 5 分钟过期**：收到图片/文件/视频立即 `downloadFile` 解密存本地。
6. **两个 5 秒红线**：欢迎语必须在 `enter_chat` 后 5 秒内发出；卡片按钮回调后 5 秒内必须 `updateTemplateCard`。这两处不能走排队，daemon 里直接处理，文案预生成。
7. **news_notice 卡片强制字段**：`card_action` 必填（缺了报 42045），`card_image.url` 必须真实可访问（缺了报 42044）。先拿 `button_interaction` 验证链路。
8. **发出消息带 feedback.id**：企业微信只给带了 `feedback: {id}` 的消息显示点赞按钮并推送 `feedback_event`。长文本拆成多条时只在第一条带。
8a. **流式是"整体覆盖"**：同一 streamId 的 `content` 每次都是全量覆盖，增量分块只会显示最后一块。长文本拆成多条独立流式消息（各自 streamId、`finish=true`），单条 ≤20000 字节（上限 20480）。
9. **点赞自动回复别用 text 类型**：`sendMessage` 走 `aibot_respond_msg` 通道时 `msgtype: "text"` 会被 40008 打回，用 `markdown`。
10. **SDK 类型不可全信**：拿真实 payload 转储说话（如 `event.template_card_event.{event_key,task_id}`、`event.feedback_event.{id,type}`）。
11. **保活别误杀刚启动的进程**：keepalive 对 90 秒内的新进程给宽限期；心跳只在认证成功后写。
12. **被顶号 = 僵尸**：SDK 收到 `disconnected_event` 后永不重连。daemon 写 `kicked.json` 后约 1.5 秒退出（exit 1），由 keepalive 拉起，重连成功后通知主人。注意：如果是你自己用 send-*.mjs 顶的号，保活下次运行会把 daemon 拉回来。
13. **识别进程靠 pid 文件**：不再用 pgrep 匹配路径，`npm start`（相对路径）和绝对路径启动都能被 keepalive 正确识别。
14. **锁文件残留**：`daemon.lock` 残留（例如 `kill -9`）无需手动删除，下次启动会自动回收。
15. **回复投递状态**：`outbox/`（待发）→ `inflight/`（发送中）→ `sent/` / `failed/` / `expired/`。daemon 崩溃后重启会把 `inflight/`
    里的回复移回 `outbox/` 续发（已发的部分不重发）；超时后才到的回复进 `expired/`，发了一半被超时打断的会有 `expired/<id>.partial.json`。
16. **硬链接的文件发不出去**：外发文件有多个硬链接（`nlink > 1`）会被拒绝（防止 `ln secrets.env /tmp/x.txt` 绕过），请复制一份再发。

## 待实测（离线开发，未在真实企业微信验证）

- 流式打字机：同一 streamId 每 3 秒刷新一次、9 分钟窗口收尾，在真实企业微信上的显示与限频表现。
- 同一 `req_id` 下发**多条**独立流式消息（长文本分段、"收到，正在处理"+正式回复）是否都能显示、顺序是否稳定。
- 被动回复的时间窗口（文档口径 24 小时内可回复，流式消息是否有更短的窗口）；超出窗口的被动发送失败会转为排空主动推送。
- 流式 `msg_item` 图片的单帧大小上限（目前按 base64 合计 ≤10MB 截断）。
- 主动推送 markdown 的单条长度上限（目前同样按 20000 字节分段）。
- 卡片回调的"已收到"更新：vote_interaction / multiple_interaction 等类型基于原卡片快照更新是否被接受；daemon 重启后
  `cards.json` 里没有快照的卡片只能按 card_type 构造最小卡片。
- `feedback_event` 的 type=3 语义。

## 文件结构

```
muse-wecom-bridge/
├── src/
│   ├── daemon.ts            # 进程胶水：配置校验、pid 文件、创建 WSClient 注入 bridge
│   ├── onboard.ts           # npm run onboard：扫码建机器人，写 secrets.env 和配对码
│   ├── bridge.ts            # 业务逻辑：消息路由、白名单、被动回复、卡片回调、被顶号、定时任务
│   ├── outbox.ts            # 投递引擎：按部件记进度、失败/过期分流、排空互斥
│   ├── muse-backend.ts      # inbox 入队 / 等 outbox 回复
│   ├── files.ts             # 外发文件安全校验、媒体类型识别
│   ├── state.ts             # 去重水位、心跳、卡片登记表、卡片回调去重、pid 文件
│   ├── proc.ts              # 进程身份：/proc/<pid>/stat starttime、启动令牌
│   ├── lock.ts              # daemon 单实例锁 daemon.lock（O_EXCL + 陈旧锁回收）
│   ├── config.ts / paths.ts / chunk.ts / logger.ts / fsutil.ts
│   ├── test/                # node --test 离线测试（假客户端，不连网）
│   ├── wecom-morning-brief.py # DPMC 早报生成（主动推送示例）
│   ├── send-test.mjs / send-file.mjs / send-card-demo.mjs  # 冒烟测试脚本
├── keepalive.sh             # 保活脚本（ROOT = 脚本所在目录）
├── DESIGN.md                # 架构设计说明
├── README.md                # 本文件
├── package.json
├── tsconfig.json
├── config.example.json      # 配置模板
├── secrets.env.example      # 凭证模板（真实 secrets.env 不要提交！）
├── .gitignore
├── inbox/ outbox/ sent/     # 消息队列目录（运行时生成）
├── failed/ expired/ progress/ # 永久失败 / 超时过期 / 投递进度
├── inflight/                # 正在发送的回复（崩溃后重启自动移回 outbox/）
├── incoming/ outgoing/      # 收到的媒体 / 待发出的文件（外发文件放 outgoing/）
├── feedback_raw/            # 点赞回调原始 payload 转储
└── state.json heartbeat.json cards.json card_events.json daemon.pid daemon.lock debug.log  # 运行时状态（均不提交）

运行时清理（每小时）：`incoming/`、`feedback_raw/` 保留 7 天；`sent/`、`expired/`、`failed/` 保留 30 天；
`debug.log` 超过 10MB 轮转为 `debug.log.1`（只保留 1 份）。
```

## 许可证

MIT（SDK `@wecom/aibot-node-sdk` 同为 MIT）
