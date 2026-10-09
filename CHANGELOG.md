# 更新日志

## 0.1.0

修复（P1）
- **pid 复用误判 / 误杀**：`daemon.pid` 改为一行 `<pid> <starttime> <token>`（starttime 为 `/proc/<pid>/stat` 第 22 字段，token 为每次启动随机生成）；`heartbeat.json` 也带 `token`，daemon 启动即写一次（`connected:false`）。keepalive 只有在 pid 存在、starttime 相同、心跳 token 与 pid 文件一致、命令行脚本就是本 ROOT 的 `dist/daemon.js` 时才认为是自己的 daemon，也只有这时才会 kill。`/proc/<pid>/stat` 截到最后一个 `)` 再取字段（comm 可含空格和括号），TS 与 shell 同一算法，已用名为 `a b) c` 的进程验证。
- **同一回复重复发送**：`runDelivery` 加同 id 进程内互斥（`Map<id, Promise>`），并发调用返回同一个进行中的结果；被动回复与排空都只走这一个入口，消除二者的检查-再执行竞态；`waitReply` 也会看到已被排空认领（`inflight/`）或已发完（`sent/`）的回复。
- **墓碑与发送不原子**：发送前先 `rename outbox/<id>.json → inflight/<id>.json` 认领；超时路径先写墓碑再尝试 `rename outbox → expired`，谁 rename 成功谁拥有文件；若已被认领，发送方在部件之间检查墓碑，停止剩余部件，移到 `expired/` 并写 `<id>.partial.json`。临时失败时文件移回 `outbox/`。
- **崩溃恢复**：daemon 拿到单实例锁后把 `inflight/*` 移回 `outbox/`，凭 `progress/<id>.json` 续发（已发部件不重发）；有墓碑的移到 `expired/`。
- **errcode 识别**：支持 `errcode=40008`、`"errcode":40008`、`'errcode': '40008'`、SDK 的 `(code: 40008)`、`e.errcode`、递归 `cause` 链（深度上限、防环）以及 `JSON.stringify(e, Object.getOwnPropertyNames(e))` 兜底。
- **卡片回调重复入队**：去重键改为 `task_id + event_key + 会话键（chatid || from）`，TTL 10 分钟，持久化到 `card_events.json`（原子写）；重复回调照样更新卡片但不再入队。inbox 的 messageId 由去重键（+ 回调 msgid）确定性派生，不再用 `Date.now()`。

修复（P2）
- **单实例**：daemon 自己用 O_EXCL 创建 `daemon.lock`（pid + starttime + token），持有者存活则拒绝启动；持有者已死 / starttime 不符 / 内容损坏的陈旧锁通过 rename + inode 核对安全回收；正常退出（含启动期间收到 SIGTERM）释放锁。不再依赖 keepalive 的"先检查再拉起"。
- **keepalive ROOT 规范化**：ROOT 一律 realpath；命令行里的 daemon.js 路径（相对路径按 `realpath(/proc/<pid>/cwd)` 解析）realpath 后与 `$ROOT/dist/daemon.js` 比较，经符号链接的目录也能识别。
- **flock**：拿不到锁时写一行日志再退出；没有 flock 时警告并退回 mkdir 锁（记录 pid + starttime，持有者已死可回收，EXIT 时释放）。另外：拉起 daemon 时关闭 fd 9，daemon 不再继承并永久持有 keepalive 的 flock（0.2.0 中这会让之后的 keepalive 全部静默跳过）。
- **重试计数**：临时错误按部件计数、该部件成功即清零；只统计时间窗口内的失败（默认 1 小时内 5 次 → `failed/`），不再是终身累计。
- **硬链接绕过**：外发文件 `lstat` 后拒绝 `nlink > 1`；并与 ROOT 下敏感文件（`secrets.env`、`config.json`、`state.json`… 及顶层命中敏感名规则的文件）的 dev+ino 比对。`daemon.lock`、`card_events.json` 加入敏感文件名。

其它
- 新增 `src/proc.ts`（进程身份）、`src/lock.ts`（单实例锁）；keepalive.sh 可被 `source`（只定义函数），测试直接调用其中的 shell 函数。
- 新增 21 个回归测试（`src/test/v021.test.ts`），共 65 个。
- .gitignore 补充 `daemon.lock`、`daemon.lock.stale.*`、`card_events.json`、`inflight/`、`.keepalive.lock.d/`。


修复（P0）
- **被顶号后变僵尸**：收到 `disconnected_event` 后写 `kicked.json` 并在约 1.5 秒后 `exit(1)`，由 keepalive 拉起；心跳只在已认证时刷新并带 `connected:true`，断线写 `connected:false`；keepalive 把断线超过宽限 / 心跳停滞判为不健康。
- **waitReply 解析失败丢消息**：非法 JSON 不再返回空回复，继续轮询，到时按超时处理。
- **排空无限重发**：新增按部件的投递进度（`progress/<id>.json`），已发部件永不重发；永久错误（校验失败、errcode 40008/42044/42045/40058）移入 `failed/` 并记录原因；临时错误最多重试 5 次。
- **activeWaits 过早删除**：保持到归档/失败完成（finally），排空不会与被动发送重复。
- **被动回复部分失败**：与排空共用部件进度，文本成功、文件失败时只补发文件。
- **超时后迟到回复被补发**：超时写墓碑 `expired/<id>.tombstone`，迟到的 outbox 文件移到 `expired/`。
- **文件外泄**：外发文件 realpath 后判断；默认只允许 `<ROOT>/outgoing`、系统临时目录、`/tmp`（可用 `allowedFileRoots` 配置）；项目目录内只允许 `outgoing/`；拒绝 `*.env`、`secrets*`、`state.json`、`heartbeat.json`、`config.json`、`id_rsa*`、`*.pem` 等。`file` 与 `images` 同规则。
- **白名单为空即对所有人开放**：改为 fail-closed，必须配置 `allowedUserIds` 或显式 `"allowAll": true`，否则 daemon 与 check-config 都失败。

修复（P1）
- 长文本拆成多条独立流式消息（各自 streamId、finish=true、≤20000 字节，feedback 只在第一条）。
- keepalive.sh：ROOT 取脚本所在目录（可用 `MUSE_WECOM_ROOT` 覆盖）；daemon 写 `daemon.pid`，keepalive 用 pid 文件 + `/proc/<pid>/cmdline` 识别；拉起成功以"pid 相符 + connected:true 心跳"为准；新增 `--status`；flock 防并发。
- 卡片回调：非演示按钮更新为同 card_type 的"已收到"卡片并把 `card_event` 投进 inbox；已发卡片登记到 `cards.json`；task_id 回退表按会话键统一。
- 排空加进程内互斥。
- send-file.mjs 按扩展名识别媒体类型。

修复（P2）
- state.json / heartbeat.json / kicked.json 等原子写；去重保存串行化。
- 白名单同样作用于空语音提示、图文混排提示、点赞回执、进入会话欢迎语、卡片回调。
- debug.log 10MB 轮转；incoming/、feedback_raw/ 7 天，sent/、expired/、failed/ 30 天定期清理；默认不记录消息原文（`logMessageText`）。
- 移除无用的 `frames` 映射。
- 早报：窗口改为 24 小时，`published_at` 按 Asia/Shanghai 带时区比较，ROOT 取 `MUSE_WECOM_ROOT` 或脚本上一级目录。
- .gitignore 补充 state.json、daemon.pid、cards.json、failed/、expired/、progress/、debug.log.*、config.json；不再误忽略 secrets.env.example。

其它
- 重构：`daemon.ts` 拆为 paths / config / files / chunk / state / outbox / logger / fsutil / bridge；客户端注入，便于离线测试。
- 新增 `npm test`（node 内置测试运行器，零新增依赖）；tsconfig 开启 `strict`。
- 主动推送补齐 `images` 支持（逐张上传后发送）；图片 base64 合计上限 10MB。
- 同一 ROOT 已有存活 daemon 时拒绝启动（防双开顶号）。
- `config.json` 损坏时报错退出，不再静默当作空配置。

