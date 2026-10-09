# muse-wecom 桥接 · 设计说明

目标：在企业微信里直接跟 Muse（本平台助手）聊天，国内免代理可用。

## 为什么是企业微信智能机器人（长连接）

- 官方 SDK `@wecom/aibot-node-sdk`（1.0.7，MIT），企业微信官方出品。
- **WebSocket 长连接**：本机主动向外连 `wss://openws.work.weixin.qq.com`，
  **不需要公网 IP、回调域名、可信 IP** —— 和飞书桥接同构，沙箱已验证 TLS 可达。
- BotID + Secret 认证；断线指数退避重连；流式回复（Markdown）；支持主动推送。
- 对比备选：
  - 个人微信 iLink/ClawBot：官方但 2026-10-09 已被用户叫停（见 skill `weixin-ilink`，已封存）。
  - 企业微信自建应用（回调模式）：需要公网可达的回调地址，本沙箱做不到。
  - 第三方 pad 协议 / PC Hook：封号风险或需 Windows 机器，不考虑。

## 架构

```
企业微信平台
  │  WSS 长连接（本机主动向外建连，无需公网回调）
  ▼
daemon.js（Node 常驻进程，@wecom/aibot-node-sdk WSClient）
  │  文本/语音/图片/文件/视频 → 去重（state.json，近 500）→ 白名单（fail-closed）
  │  → 写 inbox/<msgid>.json → 等 outbox/<msgid>.json → 按部件投递（outbox.ts）回企业微信
  │  卡片点击 → 同类型"已收到"更新 + inbox card_event；被顶号 → 写 kicked.json 后退出
  ▼
hook（`wecom-inbox-watch`，15 秒轮询 inbox/，wake/silent 双路径已验证，保持禁用直到联调通过）
  │  有新文件 → wake 唤醒助手
  ▼
Muse 助手（被唤醒后）
   读 inbox → 思考/调工具 → 写 outbox/<msgid>.json → 删 inbox/<msgid>.json
```

关键点：

- "智能"不在 daemon 里，daemon 只负责企业微信传输 + 文件队列；真正的回答由被 hook 唤醒的助手产生。
- inbox/outbox/sent 三个目录解耦两端，任何一端崩溃重启都不丢消息。
- 同一 BotID 同一时刻只允许**一个**有效长连接：不要在别处同时用这组凭证建连，否则互相顶替。
- 0.2.0 起代码分层：`daemon.ts` 只做进程胶水（配置校验、pid 文件、创建 WSClient）；业务逻辑全部在
  `bridge.ts`，客户端通过 `BotClient` 接口注入，测试用假客户端离线跑（`npm test`）。

## 目录

```
muse-wecom-bridge/
  src/daemon.ts        进程胶水：配置/凭证加载与校验、pid 文件、创建 WSClient 注入 bridge
  src/bridge.ts        WS 事件路由、白名单、被动回复、卡片回调、被顶号、定时任务（心跳/排空/清理）
  src/outbox.ts        投递引擎：部件进度、永久/临时错误分流、墓碑、排空互斥
  src/muse-backend.ts  inbox 入队（原子写）、长轮询等 outbox 回复
  src/files.ts         外发文件校验（realpath、允许目录、敏感文件名）、媒体类型识别
  src/state.ts         去重水位、心跳、卡片登记表、pid 文件
  src/config.ts paths.ts chunk.ts logger.ts fsutil.ts
  src/test/            node --test 离线测试
  dist/                tsc 编译产物（node 直接运行）
  config.json          非密钥配置：wsUrl/allowedUserIds/allowAll/回复超时/allowedFileRoots/logMessageText
  secrets.env          BotID/Secret（600 权限，不提交；复制 secrets.env.example）
  inbox/ outbox/ sent/ 消息队列目录
  failed/ expired/     永久失败（附 .reason.json）/ 超时过期（含 .tombstone 墓碑）
  progress/            每条回复的部件投递进度
  state.json           去重水位（近 500 msgid）
  heartbeat.json       {pid, ts, connected}，仅已认证时刷新
  cards.json           已发卡片登记：task_id → card_type/会话/原卡片快照（近 200）
  daemon.pid           daemon 进程号（keepalive 用它 + /proc 识别进程）
  debug.log(.1)        SDK/daemon 结构化日志，10MB 轮转
```

## 用户侧待办（卡点，需用户在自己企业微信里操作）

1. 有企业微信组织（个人可免费注册）并是管理员。
2. 管理后台 → 工作台 → 智能机器人 → 创建机器人 → **API 模式** → 连接方式选**长连接**。
3. 机器人详情页拿到 **BotID** 和 **Secret**，通过安全方式发给助手（不要直接贴聊天里）。
4. 可见范围包含自己；私聊建议配白名单（`config.json` → `allowedUserIds` 填自己的 userid）；
   群聊里 @ 机器人触发（注意：@ 是消息路由不是鉴权，群成员控制靠可见范围/群成员管理）。

## 联调步骤（凭证到位后）

1. `cp secrets.env.example secrets.env`，填入真实 BotID/Secret，`chmod 600 secrets.env`。
2. `npm run check-config`：应显示"配置检查通过" + "网关连通性: OK"。
3. `npm start`：看到"已认证，长连接就绪"。
4. 在企业微信里给机器人发一句话 → daemon 写 inbox → hook 唤醒助手 → 助手回 outbox →
   daemon 流式回企业微信。
5. 建 hook（复用 `feishu-inbox-watch`，改目录为 `~/workspace/muse-wecom/inbox`）并启用，
   再启用 systemd 单元常驻。

## 已知约束

- 单聊 + 群 @ 触发；暂不支持外部群/客户群（官方限制）。
- 回复/推送合计约 30 条/分钟、1000 条/小时（第三方文档口径，实际以官方为准）。
- 消息回调后 24 小时内可回复（第三方口径，待实测）；欢迎语需在 `enter_chat` 后 5 秒内发送（已实现，仅对白名单用户）。
- 流式单条上限 20480 字节；流式 content 是整体覆盖语义，所以长文本拆成多条独立流式消息（每条 ≤20000 字节、
  各自 streamId、finish=true，feedback 只挂第一条）。同一 req_id 发多条流式消息的表现**待实测**。
- **文件发送（2026-10-09 已打通）**：两种路
  1. **被动回复**：outbox 加 `file` 字段（本机绝对路径，0.2.0 起只允许 `<ROOT>/outgoing`、系统临时目录、`/tmp`
     或 config `allowedFileRoots`，realpath 后判断、拒绝敏感文件名，≤10MB），
     daemon 走 `uploadMedia` → `replyMedia` 随当前会话发回。`text` 照常发。
     媒体类型按扩展名自动识别（mp4→video、png/jpg→image、mp3→voice），原生形式发出可直接播放/查看。
  2. **主动推送**：`src/send-file.mjs <userid> <文件路径>` 走 `uploadMedia` → `sendMediaMessage`（0.2.0 起按扩展名识别类型）
     （注意会把 daemon 顶下线——同一 BotID 只许一条长连接，跑完用 `keepalive.sh` 拉回；
     早前见过的 846607 限频在 10-09 16:10 的实测中未再出现）。

## 可靠性设计（2026-10-09 事故后补强）

背景：实测中丢过一条消息——daemon 在等回复时被重启，worker 写好的 outbox 成了孤儿，
新 daemon 只对新消息调用 waitReply，孤儿回复永远没人发。另发现多 worker 可能并发抢同一条 inbox。

1. **outbox 排空（drainOutbox）**：daemon 认证成功时 + 每 60 秒，扫描 `outbox/*.json`，
   对没有活跃等待者（activeWaits）的 ID，用 `sendMessage`/`sendMediaMessage` 主动发出去再归档。
   成功才归档，限频等失败留待下次。
2. **先发后归档**：`waitReply` 只读不删；`handleText` 发送成功后才 `archiveReply`，
   超时则 `discardReply`（避免半小时后补发过时回复）。崩溃窗口只剩"发送成功→归档"之间几毫秒，
   可接受（最坏多发一条，不丢）。
3. **inbox 原子认领**：hook 轮询脚本用 `mv` 把 `inbox/<id>.json` 原子改名为
   `<id>.json.claimed`，同一时刻只有一个轮询能抢到；worker 读 `.claimed`、处理完删除。
   认领超 25 分钟（> 回复超时 20 分钟）视为 worker 崩溃，重新认领。
4. **心跳**：daemon 认证成功后每 30 秒写 `heartbeat.json`（`connected:true`），断线立即写 `connected:false`
   并停止刷新；`keepalive.sh` 要求 pid 文件指向的进程是本 ROOT 的 daemon，且心跳 pid 相符、已连接、90 秒内新鲜
   （或刚断线/刚启动不足 90 秒）才算健康，否则杀掉重拉（防假死）。

## 0.2.0 可靠性 / 安全修订

1. **被顶号僵尸**：SDK 收到 `disconnected_event` 后设置 `isManualClose`、永不重连，而旧版心跳定时器照写，
   保活以为健康。现在：写 `kicked.json` → 心跳置 `connected:false` → 约 1.5 秒后 `exit(1)`，交给 keepalive 拉起；
   重新认证后通知主人。恢复时延取决于 cron 间隔（建议 5 分钟）。
2. **部件级投递进度**（`outbox.ts`）：一条回复 = `text:0..n` → `file` → `images`（主动推送时 `image:<i>` 逐张）→ `card`。
   每个部件成功后写 `progress/<id>.json`，被动回复与排空共用同一引擎和进度，所以"文本发了、文件失败"
   之后只补发文件。错误分两类：
   - 永久：本地校验失败（路径不允许/不存在/过大/卡片缺 card_type）、errcode ∈ {40008, 42044, 42045, 40058}
     → 记为失败部件，其余照发，最后移到 `failed/` 并写原因；
   - 临时：其它（限频 846607、回执超时、断线…）→ attempts+1 留在 outbox，第 5 次仍失败移到 `failed/`。
3. **activeWaits 生命周期**：从开始等回复到归档/失败完成（finally）都占着，排空不会与被动发送并发。
4. **超时墓碑**：等回复超时写 `expired/<id>.tombstone`；迟到的 outbox 文件被排空直接移到 `expired/`，不再补发过时回复。
5. **waitReply 解析失败**：继续轮询（只记一次日志），超时按超时处理——不再把空回复归档、把真回复弄丢。
6. **排空互斥**：进程内互斥，认证时与 60 秒定时器同时触发也只跑一遍。
7. **原子写**：state.json / heartbeat.json / kicked.json / cards.json / progress 一律 tmp+rename；去重水位保存串行化。
8. **有界增长**：debug.log 10MB 轮转（留 1 份）；incoming/、feedback_raw/ 7 天，sent/、expired/、failed/ 30 天，每小时清理；
   默认不记录消息原文（`logMessageText: true` 才记）。
9. **白名单 fail-closed**：`allowedUserIds` 为空且未显式 `allowAll: true` 时拒绝启动；白名单同样作用于空语音提示、
   图文混排提示、点赞回执、进入会话欢迎语、卡片回调。
10. **卡片回调**：只有演示 key 在 daemon 内处理；其它 key 更新为同 card_type 的"已收到"（基于 `cards.json` 里的原卡片快照），
    再把 `{type:"card_event"}` 投进 inbox 交给助手。task_id 回退表统一按会话键（群聊 chatid、单聊 userid）登记与查找。

## 0.2.1 并发 / 身份修订

1. **进程身份**：`daemon.pid` 与 `daemon.lock` 内容相同，一行 `<pid> <starttime> <token>`。
   - starttime = `/proc/<pid>/stat` 第 22 字段（开机以来的时钟滴答）。stat 格式为 `pid (comm) state ...`，comm 可含空格与 `)`，
     必须截到**最后一个** `)` 之后再切分：剩余部分第 1 个字段是总字段 3，所以总字段 N = 剩余部分 0 基下标 N-3，第 22 字段 = 下标 19
     （shell 里 `set -- $rest` 的 `${20}`）。实现：`src/proc.ts` 的 `parseProcStat`、keepalive.sh 的 `proc_starttime`，测试用复制成
     `a b) c` 的 sleep 进程验证，并与 `uptime - starttime/CLK_TCK ≈ etimes` 交叉核对。
   - token 每次启动随机生成，`heartbeat.json` 也写它（启动即写一次 `connected:false`）。
   - keepalive 认定"是我们的 daemon"= pid 存在 ∧ starttime 相同 ∧ 心跳 pid、token 与 pid 文件相同 ∧ 命令行脚本 realpath = `$ROOT/dist/daemon.js`。
     只有这时才会 kill；身份不符（pid 复用等）只记日志、不杀，直接拉新实例（新实例若撞上真正存活的旧实例，会被 daemon.lock 拒绝）。
2. **单实例锁**（`src/lock.ts`）：`open(daemon.lock, "wx")`。已存在时：持有者存活（pid + starttime）→ 拒绝启动；否则视为陈旧，
   `rename` 到唯一的 `daemon.lock.stale.<rand>` 后核对 inode 与判定时 stat 的相同（不同说明拿走的是别人刚建的新锁，用不覆盖的 `link()` 放回），再重试 O_EXCL。
   残余风险：三个实例在毫秒级同时回收同一陈旧锁、且放回时原处又被第三方占用，理论上可能出现两个持锁者；cron 5 分钟一次的 keepalive 下可忽略。
   TS 侧判断锁持有者存活只用 pid + starttime（锁本身就是 token 的权威来源，不再读心跳）。
3. **投递状态机**（`src/outbox.ts`）：`outbox/` →（认领 rename）→ `inflight/` → `sent/` | `failed/` | `expired/`；临时失败 `inflight/ → outbox/`。
   - 同 id 进程内互斥 `OutboxStore.runs: Map<id, Promise>`，`runDelivery` 是被动回复与排空的唯一入口；
   - 超时：先写墓碑，再 `rename outbox → expired`。rename 成功 = 超时方拥有（不发送）；失败且文件在 inflight = 发送方拥有，
     发送方每个部件之前检查墓碑，命中则停止剩余部件、移到 `expired/` 并写 `<id>.partial.json`（done / notSent）；
   - 崩溃恢复：拿到单实例锁之后 `recoverInflight()`：`inflight/*` → `outbox/`（凭 progress 跳过已发部件），有墓碑的 → `expired/`。
     仍有"部件已发出、progress 未落盘"的毫秒级窗口，崩溃时该部件会重发一次（至少一次语义）。
4. **重试计数**：`progress.partFailures[part] = [失败时间戳…]`，只保留窗口内（默认 1 小时），窗口内达 5 次 → `failed/`；部件成功即删除。
5. **卡片回调去重**：键 `[task_id, event_key, chatid||from]`，TTL 10 分钟，`card_events.json` 原子写；内存里同步 check-and-add，同进程并发重复也只放过一个。
   inbox messageId = `card-` + sha256(键 + 回调 msgid) 前 24 位；若该 id 上一轮已结束（在 sent/failed/expired 或 inbox 里），追加 `-r2`、`-r3`…
6. **硬链接**：`lstat` 拒绝 `nlink > 1`；dev+ino 与 ROOT 下敏感文件比对（纵深防御）。注意这会拒绝所有带多个硬链接的正常文件。
7. **keepalive 锁**：优先 flock（拿不到写日志）；无 flock 退回 `mkdir .keepalive.lock.d`（owner = pid + starttime，陈旧可 rename 回收）。
   拉起 daemon 时 `9>&-`，避免 daemon 继承 flock 的 fd。

## 待实测

- 同一 req_id 下多条独立流式消息的显示与顺序；被动回复的时间窗口；流式 msg_item 图片单帧大小上限（目前 base64 合计 ≤10MB）；
  主动 markdown 单条上限（目前 20000 字节分段）；非 button_interaction 卡片的"已收到"更新是否被服务端接受。
