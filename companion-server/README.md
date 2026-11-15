# companion-server（挂念后端 + 唤醒后端）

挂念的"情绪 / 生活 / 何时发送"迁到 VPS 常驻运行的后端。设计见 `/root/vibe-coding/float/docs-draft/guanian-backend.md`。

独立于 Next.js：不参与 `npm run build`，Node 22 直接运行 TypeScript（类型擦除），只依赖 `web-push`。

## 当前阶段：4（挂念 / 小手机直连后端）

每 60 秒给每个角色跑一轮（`src/engine.ts`）：

1. 生活面：到 `autoGenAt` 用 daily 快照生成今天（影子模式读云端已生成的那份）
2. 不调模型的账：朋友圈骰子、回音账（凭后端自己的发送记录）、约定定时器
3. 门禁 → 由头（到日子 / 想念 / 憋不住 / 刚做完 / 余韵 / 太安静）→ 分量
4. 判断：judge 快照 + 挂念判断提示词 → 改念头、记账本、挂定时器
5. 到点：发送前复核（睡眠 / 忙 / 淡去 / 事项去重 / 用量）→ chat 快照 + 最新聊天事实 + 状态备忘 → 写 `push_outbox` → Web Push

规则与文案逐段搬自云函数 push-recheck / push-generate；`src/vendor/*.mjs` 是原样拷来的约定 / 事项 / 岔子模块。
旧的「早上定完」模式已删；无大脑的云端预约逻辑备份在 git tag `guanian-cloud-legacy-20260916`。

### 模式

| 模式 | 行为 |
|---|---|
| `shadow`（默认） | 读云端当天生活面，跑门禁，只记「这会儿会去判 / 会发」；**不调模型、不写个人云** |
| `live` | 自己生成、判断、到点发送；替代云端 push-recheck / push-generate |

切换：`node src/cli.ts mode live`（存在 SQLite，服务下一轮生效；`COMPANION_MODE` 只是初始默认）。

### 切到真发

1. App 开启「交给 VPS 后端」保存时，先调 `/app/characters/:id/handoff`：停旧云端复核与生成、分页核对并条件撤销尚未成文的预约。执行中、成文待投递、设备归属冲突或读取失败时不确认交接，VPS 角色保持停用。
2. 交接确认后保存设置（云端复核/生成置为关闭）并启用后端角色。已在用后端但尚无交接记录的角色，打开挂念时也补做一次。新的角色如有旧云端计划，只迁入该角色的状态，不覆盖已有后端状态。
3. `node src/cli.ts mode live` 切到真发；影子模式不发消息。`status` 查看判断和定时器。

交接复用 schema 12 已有 RPC；不删除 `push_jobs` / outbox 凭据，也不重建个人云。旧云端判断租约有效或生成尚可能在执行时，需要等它结束后重试保存。

### 直连

- 监听 `COMPANION_BIND`（逗号分隔，默认 `127.0.0.1`）；线上是 `127.0.0.1,172.17.0.1`，Caddy 容器经 `host.docker.internal:18070` 反代到 `https://float.yanny.top/companion/…`（Caddyfile 的 float.yanny.top 块，`uri strip_prefix /companion`）。
- 鉴权：运维令牌 `COMPANION_API_TOKEN`，或挂念设置里存的个人云 Secret key——后端拿它读一行 `push_server_config`（只有 service 级密钥读得到）确认，只缓存 SHA-256（通过 30 分钟、失败 1 分钟），每分钟最多核对 20 次。
- CORS 放开 `*`：挂念跑在沙箱 iframe（null origin），不用 cookie。
- 手机发来的改动在 `Runner.exclusive` 锁里做：正在跑一轮时排到这轮之后，最多等 20 秒，没做完回 202 `{queued:true}`。

### 接口（除 /health 外都要 `Authorization: Bearer <运维令牌或个人云 Secret key>`）

| 接口 | 作用 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /status` | 模式、各角色此刻状态、念头、定时器、最近判断（不含快照内容） |
| `GET /diagnostics` | 各角色最近聊天镜像与快照时间 |
| `POST /mode` `{mode}` | 切模式 |
| `POST /import` `{force}` | 从个人云迁入 |
| `PUT /snapshots` | 手机寄提示词快照（purpose: chat / judge / daily） |
| `POST /push/test` | 测试推送 |
| `GET /characters/:id` | 单个角色状态 |
| `PUT /characters/:id/settings` | App 同步设置 |
| `PUT /characters/:id/calendar/:date` | App 同步日程表已定安排与作息 |
| `POST /characters/:id/regenerate` | 重新生成今天（仅 live） |
| `POST /characters/:id/tick` | 立刻跑一轮 |
| `GET /app/state?ids=a,b` | 挂念界面：生活面（按此刻揭晓变数）、念头（带后端状态、押后、发送前复核、轨迹）、账本、朋友圈记录、判断记录、快照时间、注入聊天的文字 |
| `GET /app/archive?id=a&limit=30` | 记录页：最近几天的生活面和念头 |
| `GET /app/host?ids=a,b` | 小手机宿主：在线状态用的日子、注入聊天的文字、待发朋友圈、发圈节奏 |
| `POST /app/characters/:id/handoff` | 停旧云端并验证交接 `{owner}`，成功回 `{stopped:true}`，VPS 角色暂保持停用 |
| `POST /app/characters/:id` | 建档 / 更新名字、会话、设置、开关 `{name, sessionId, settings, enabled}` |
| `PUT /app/characters/:id/settings` | 设置（只收设置键） |
| `PUT /app/characters/:id/inputs` | 宿主寄原料 `{affection, days:[{date, calendar, routine, exceptions}], routineOn}`，后端按角色时区折成已定安排和起床 / 上床 |
| `PUT /app/characters/:id/day` | 改今天的日程 `{date, schedule, forks, conds}` |
| `POST /app/characters/:id/threads` | 账本 `{op: add\|done\|undone\|drop}`，了结 / 删掉会撤掉挂在上面还没发的念头 |
| `POST /app/characters/:id/items/cancel` | 撤掉一个还没发的念头 `{wakeId}` |
| `POST /app/characters/:id/moments/ack` | 宿主发朋友圈的回执 `{id, status, postId, note}` |
| `POST /app/characters/:id/regenerate` / `tick` | 同上，挂念按钮用 |
| `PUT /app/wake/templates/:sourceId` | 唤醒后端：手机寄来的来源底稿（旧的不覆盖新的） |
| `POST /app/wake/templates/:sourceId/delete` | 来源不再交给后端 |
| `GET /app/wake/status?source=x&limit=n` | 底稿概况（不含密钥）、网关来源状态、最近处理记录 |

CLI：`node src/cli.ts diagnose | push-test | status | import [--force] | mode shadow|live`

### 手机那头（小手机开着就跑，挂念不用开）

`lib/guanian-server-sync.ts`：每分钟取 `/app/host`，写在线状态变量、回复闸门、注入聊天提示词、朋友圈节奏变量；后端起意的朋友圈在前台补成帖子并回执；后端生成的日程写回系统日程表；把好感、系统日程表、「忙碌回复」固定作息和例外寄到 `/app/characters/:id/inputs`。挂念 0.10.0 开着「交给 VPS 后端」时界面直接读写 `/app/*`。
端到端自测：`node scripts/check-gua-nian-server-direct.mjs`（真后端 HTTP + Chromium 跑挂念 + vm 跑宿主同步）。

### 唤醒后端（`src/wake.ts`、`src/mcp.ts`）

外部事件叫醒角色，手机关着也处理。花园只是一个接入方：任何能发 Webhook 的项目按 `tools/tool-events/README.md` 投递即可，不能发的写个适配器翻译成标准格式。

1. 收件：本机事件网关（`tools/tool-events/service.mjs`，127.0.0.1:18062）负责适配器、投递鉴权、去重、排队。工具箱 MCP 的「事件唤醒」选「交给 VPS 后端」= 来源 `mode: "server"`；网关只把这类事件交给带 `mode:"server"` 领取的后端，手机领不到。
2. 底稿：小手机 `lib/wake-server-sync.ts` 给每个这样的来源冻一份——聊天提示词 + 完整聊天记录 + 末尾占位用户消息，只含绑定 MCP 的工具（原生协议给定义和名字对照，文字协议给指令说明），MCP 地址和请求头。聊天有新消息 30 秒后、切后台、每 5 分钟检查一次，没变化 30 分钟重寄。工具箱仍是原件。
3. 处理：每 15 秒领一次。没底稿或会话被占用的事件留在网关；有底稿先取得共享会话租约、读取最新聊天，再 ack（工具有副作用，失败不重放）→ 占位换成事件原文、时间刷新 → 多轮调模型（最多取手机的工具轮数，上限 10），要工具就经 MCP（Streamable HTTP，JSON / SSE 回包，会话过期重握手）调 → 回复写 `push_outbox`（`trigger_key = wake:<事件>`，`meta.toolEvent` 带原文、动作、失败原因）→ Web Push。失败也写一条，事件不会悄悄消失。
4. 补收：`lib/push-outbox-client.ts` 先落事件原文（用户消息）和每个动作的 tool_call / tool_result / 灰条，再按普通离线回复解析。
5. 来源断开（花园断线按官方规定不自动重连）：推一条「唤醒来源断开了」，去工具箱手动启动。
6. 记录：`wake_runs` 表（sent / silent / error / waiting / disconnected），工具箱唤醒设置里能看到。

端到端自测：`node scripts/check-wake-server.mjs`（真网关 + 真后端 HTTP + 本机假 MCP）。

### 发送分流（`src/delivery.ts`、`src/shortcut-resume.ts`）

挂念到点成文后按正文里的控制标记送，规则搬自 push-generate，标记一律从正文剥掉：

- **来电**：聊天模板里有 `__GUANIAN_CALL_INVITE__` 占位，后端到点按同一角色 20 小时一次换成「可以打电话」说明，否则换成「照常发消息」。回复开头是 `[我向…发起了语音通话]` / `【拨打电话】` 等标签时，推单条 `incoming_call` 通知（点开 `/?ring=<会话>` 直达振铃），正文照常进 outbox。
- **发到微信**：模板带角色绑定的 bot（`payload.weixin.botId`）。回复开头 `【发到微信】` 就经微信云助手 `send-text` 发到真实微信，送成了不进聊天 outbox；送不成照常发到聊天。
- **快捷动作**：`【快捷动作：名称({参数})】` → 读 `push_bridge_config.shortcut_actions` 目录 → 调个人云 `ai-phone-push?action=shortcut-create` 建命令。outbox 的 `meta.shortcutMarker` 带标记原文和位置，补收时原位落 tool_call。角色先说话、推送完，再投递「运行快捷指令」（推送模式调 `shortcut-deliver`，邮件模式请站点代发）。创建失败落 `meta.kind = shortcut_delivery_error` 诊断行；命令投递失败保留草稿阶段并重试，不重新创建命令。建命令前草稿先记 `shortcutTried`，重启后看到没结果就不重复执行。
- **结果续跑**：会回传结果的动作，把刚说的话代入模板里的续跑底稿（`shortcutContinuation`），存 `shortcut_resumes` 表。Runner 每轮查 `push_shortcut_commands`：没执行完往后排，过期按超时交给角色；结果和截图代入后生成第二轮，写 `trigger_key = shortcut:<命令>` 的 outbox 并推送。第二轮再出动作标记只剥不执行。不再挂 `shortcut_resume` 云任务。
- **安卓壳通知**：`push.ts` 对 `shell:` 订阅改发 Realtime 广播 `shellpush:<userId>`，来电带 `kind: "call"`。唤醒后端的推送也走这里。

### 离线任务（`src/jobs.ts`）

小手机「离线执行」选了后端时，回复兜底、自动追问、定时消息（安静太久 / 一次性定时）、经期关怀不再寄个人云 `push_jobs`，而是 `POST /app/jobs` 寄到这里，存 `offline_jobs` 表，每 15 秒扫一次到点的。规则照搬 `push-generate` 这几类任务的路径：同会话生成租约、每天 50 条硬闸、补最新聊天（定时 / 追问）、未回应降速、沉默协议、来电 / 快捷动作 / 微信分流、写 outbox + 推送、安静太久续排 `key+`。成文正文先落库，写 outbox 失败重试时不重新调模型。

不重复发：同一 triggerKey 只挂一边。手机重挂时先撤另一边、确认后才挂（`lib/offline-jobs-client.ts`）；后端到点前再查个人云同名任务——正在跑就等，比这条新或这条挂上后已处理过就不发，更早的待发就撤掉它。

忙碌回复（`deferred:*`）走 `POST /app/jobs/deferred`，协议照搬个人云网关 `deferred-reply`：回执带 revision / acceptedMessageId，改版只换快照不重置时钟，撤销留 cancelled 墓碑。到点先按 `src/reply-timing.ts`（照抄 `lib/deferred-reply-timing.ts`，测试核对一致）判断现在回不回，不回就改期；回的时候补最新聊天并把回复接在最新一条用户消息后面。一轮建在哪边就在哪边收尾（手机记在 `cloud.line`）。

### 微信助手（`src/weixin.ts`）

「离线执行」选后端且微信自动回复开着时，后端每 12 秒轮询一次，代替个人云的 `weixin-assistant` 云函数。核心逻辑是同一份：优先用小手机同步到桶里的 `weixin-cloud/function-core.mjs`，读不到或协议版本不对用 `src/vendor/weixin-assistant-core.mjs`（`npm run weixin:build-dist` 同步，测试核对一致）。开关和心跳存 meta，重启后照旧。接口 `GET/POST /app/weixin`、`POST /app/weixin/run`。手机切开关时先开新的一边再关旧的，两边共用桶里的自动回复锁，不会重复回。

### 还在个人云执行的

- 快捷命令网关本身（建命令、推运行通知、收结果回传：`ai-phone-push`、`push-shortcut-result`）、微信主动发送（`weixin-assistant` 的 `send-text`），后端只当调用方
- 「离线执行」选云端时的所有离线任务；选后端时，切换前已经排在云端、还没重挂的那几条
- 在线快捷动作续跑（`shortcut_resume`）、现实桥（`push-bridge`）、屏幕速聊（`screen-chat`）

## 配置

`/etc/float-companion/env`（0600）：

```
PERSONAL_SUPABASE_URL=https://xxxx.supabase.co   # 个人云，不是网站用的 Supabase
PERSONAL_SUPABASE_SECRET_KEY=...                 # service_role / sb_secret_
COMPANION_API_TOKEN=...                          # 接口令牌，openssl rand -hex 32
# 可选
COMPANION_USER_ID=...                            # 订阅表里只有一个账号时可省略
COMPANION_PORT=18070
COMPANION_DATA_DIR=/var/lib/float-companion
COMPANION_WAKE=off                               # 关掉唤醒后端
COMPANION_ALLOW_HOSTS=                           # 模型 / MCP 地址允许指向本机或内网的主机名，逗号分隔；默认空 = 一律不许
WAKE_GATEWAY_URL=http://127.0.0.1:18062
WAKE_GATEWAY_TOKEN_FILE=/etc/float-garden-wake/backend-token
```

数据：`/var/lib/float-companion/companion.db`（0600，快照里含模型密钥）。

## 部署

```bash
sudo rm -rf /opt/float-companion/companion-server && sudo mkdir -p /opt/float-companion/companion-server
(cd companion-server && tar --exclude=node_modules -cf - .) | sudo tar -xf - -C /opt/float-companion/companion-server
cd /opt/float-companion/companion-server && sudo npm install --omit=dev
sudo cp float-companion.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now float-companion
curl -s http://127.0.0.1:18070/health
```

## 开发

```bash
cd companion-server
npm install
npm test
```

聊天复核现在处理 `feel` 与 `sched`：情绪只写可衰减 conds；日程只改当天未来条目，最多两条，改期保留时长并清理旧细排。`chatEditsDay=false` 只禁止日程修改，不禁用情绪；自发起念、仅核对承诺及模型跨日返回不写聊天状态。纯变换见 `src/chat-state.ts`。

### 交接补迁与旧预约刷新

`/handoff` 停用旧调度后，对已建档角色也按 wakeId 补迁缺失任务；只接受标记为本次交接撤销且无 outbox 凭据的预约。已有任务终态、日程、计数、设置和账本内容保留；缺失的关联约定随任务补入，重试不重复。成功同时记录 `handoff-tasks:<角色>`；旧版只有停用记录的角色，下次打开挂念补做完整交接。

宿主通过 `lib/guanian-wake-ownership.ts` 统一判断 VPS 所属预约，发送与刷新入口都让位；快照组装前后均检查，退出本地登记时不删除云端凭据。生成日程的聊天资料使用与复核相同的独立线上/线下回看窗口，保留线下摘要。


### 挂念迁移收尾：正文、回音账、会话互斥

到点生成成功后，`generated_drafts` 在本机 SQLite 保存可见正文、原生成时间、固定 outbox ID、合并元数据与通知配置。投递失败或进程重启后优先核对 outbox 凭据，未投递则复用草稿；重试不再调用模型，不因生成预算或念头淡去丢弃正文。停用、取消、约定版本检查仍生效，账号/会话变更时保留草稿并报错。成功结算后清除草稿。原生成时间保持不变，另记 `meta.companionDeliveredAt`，回音窗口和主动消息间隔按成功投递时间计算。影子模式不消费草稿。SQLite 表由启动自动创建，旧数据不重建。

交接时补迁旧云端当天及前一天未结算的发送记录；已经交接的角色也在后端下一轮自动补查，补丁晚到时参考最早后端发送日期。发送凭据来自 outbox 或旧任务的成功回执，`fbSeen` 排除已结算记录，原发送时间保留，累计 `fb` 不覆盖；查询失败不写完成标记。`sends.wake_id` 去重且保留 `fb_done`，回音计数与结算标记在同一 SQLite 事务提交。沿用三小时有效回应窗口和用户睡眠暂停。

挂念定时发送与事件唤醒通过 `generation-lease.ts` 复用个人云 schema 12 的 `push_generation_lease`，与旧云端其他后台消息共享同一把会话锁。锁被占用时挂念延期一分钟（不计失败重试），事件唤醒不 ack；拿到锁后刷新聊天事实。模型/工具执行期间每分钟续租，在模型、工具、outbox 边界校验，失去租约停止后续副作用，最终释放。无需更新云函数或挂念安装包版本。

专项验证：`node --no-warnings --test test/engine.test.ts test/wake.test.ts test/feedback-import.test.ts test/generation-lease.test.ts`；网关/MCP/补收集成验证从仓库根目录运行 `node scripts/check-wake-server.mjs`。


### 发送分流的故障恢复

聊天写入和快捷通知分别记录完成状态。快捷命令（包括无回传动作）一律 `deferDelivery=true`，首条消息写入后再投递；outbox 回执丢失时恢复该正文，继续补投同一命令。通知确认后持久化 `shortcutDelivered`，再挂续跑；全部步骤完成才把定时器置 done、删除草稿。推送网关按 notified_at 去重，邮件代发沿用 commandId 幂等键。

`delivery-guard.ts` 在建命令、投递命令、微信发送、写 outbox 和通知前检查角色开关、会话归属、排队中的取消与会话租约；守卫放在各次配置/凭据读取之后、外部请求之前。续跑保存 sourceWakeId，受相同守卫约束；旧版已经挂起但父草稿还没投递命令的续跑先等待。

微信发送在发起请求前持久化 sending。明确失败保存 failed，之后只重试聊天兜底；成功保存 sent。超时、5xx、无效回执或重启发现 sending 均视为结果不明，保留草稿并将定时器标为失败待核对，不自动重发微信或改投聊天。个人云当前没有这条发送请求的幂等回执查询协议，不能把“没收到回执”当作“没发出去”。

快捷结果续跑取得租约后重新读取聊天镜像和 outbox、刷新模板时间、补入最新聊天，再代入结果及图片。生成后将正文、原生成时间、思考内容和图片路径存进 shortcut_resumes；投递失败/重启复用正文及固定 outbox ID，不再次调模型。停用/等待锁/预算满不消耗失败次数；其他错误三次后保留记录及正文待核对。兼容已有 SQLite JSON 记录，不改云函数或安装包版本。

故障专项：`node --no-warnings --test test/delivery.test.ts test/engine.test.ts test/shortcut-resume.test.ts`。


### 同一念头的展示归并

`/app/state` 和 `/app/archive` 对同一天、同一事项的预约版本合成一个展示条目，改期、发送和作罢过程并入该条目的 `hist`，现有挂念详情页直接展示。有效的待发/执行中版本优先；没有待发版本时保留已发送版本，之后因重复而作罢的版本不再独立占一行。缺少 matterId 的旧约定按约定 ID 归并，不按标题相似度猜测；不同日期分别保留历史。

这只调整给界面的投影，不删除或覆盖 SQLite 的原计划、定时器和发送凭据。展示条目沿用所选版本的 wakeId，取消仍定位该实际任务。同一事项的后续变化记在详情里；真实有新预约时条目更新为当前预约，旧发送记录仍在轨迹中。当前“心动”与“记录”页已有所需字段，无需升级挂念安装包。

### 止血：备用通道、分段重试、判断留痕、由头轮换（2026-11）

- **备用通道**：生成一天和判断用各自的快照（`daily` / `judge`）调模型，失败时沿用同一份正文、换 `chat` 快照的地址 / 密钥 / 模型再调一次（`llm.ts` `callModelWithFallback`，协议不同或两份本来相同就不换）。主通道失败后半小时内先走备用。生成日志里会写「这次换用聊天的模型」。
- **生成重试**：到点、12:00、18:00 三段各 3 次，失败后十分钟退避不变。头一段 3 次都没成推一条 `guanian_gen_failed` 通知（`meta` 键 `gen-notify:<角色>:<日期>`，一天一次）。今天没有生活面且生成报过错时，自发起念按昨天的作息（`bridgeDay`）继续。
- **判断留痕**：`decisions.kind = judge` 的 `data` 里有 `raw`（模型原话，截 6000 字）、`selfKind`、`skip`（模型自己写的不找原因）、`viaAlt`；模型没调通或回的不是 JSON 记 `failed: "call" | "json"`，这一轮照常往下跑到点发送。`/app/*` 接口不外露 `data`，查库看：`select at, note, json_extract(data,'$.raw') from decisions where kind='judge' order by id desc limit 20`。
- **由头轮换**：`selfUsed` 只算起成了的自发念头；`state.selfTry = { date, n, at, skips }` 记当天问了几次、各由头被否几次。一天最多问 max(4, `selfImpulseCap`+3) 次，两次至少隔 60 分钟；「刚忙完」「安静太久」被否后歇 3 小时 × 次数（封顶 9 小时）。
- **想念**：断联到 `missDays`、7、14、28 天、之后每 14 天（到 90 天为止）各问一次，`state.missKey = "<最后一条用户消息时刻>:<阶段>"`；不掷骰子，排在「上一条没回音不追」之前，连着没回满 `maxUnanswered` 条就不问。

### 审计第一批：发错、发不出、白耗额度（2026-11）

- **作罢标记**：成文里只要出现 `[挂念作罢…]`（全角括号也认，不带原因也认）就作罢，后面再跟状态栏、句号、`[内心]` 块都不会被当台词发出去。
- **没发成 = 念头作罢**：到点后淡去、睡着不发、连着没回被拦、事实核对作罢、去重、挂着的事已了结，都同时把念头标成 `act: false` 并写上原因——不再占当天额度、不挡同一件事再起念、不被当成「上一条没回音」。
- **发送重试**（`sendFailed`）：默认不延长——失败后每 5 分钟再试，第 3 次还不行就标 `failed`（和原来一样），同时把念头作罢、让出额度。挂念「设置 → 云端 → 发送失败后延长重试」（高级，默认关）打开后，App 把 `sendRetryMin`（普通念头，默认 30）/ `promiseRetryMin`（约定，默认 120）寄过来，关着时寄 0：在这个窗口内隔 5、10、20、40 分钟、之后每小时再试，下一次会超出窗口就作罢；上限 1440。`timers.note` 里记 `tries:<次数> first:<第一次失败时刻>`。约定作罢时推一条 `guanian_send_failed` 通知。没有聊天快照、空回复、思考块不完整也走这条重试；用量到上限时，约定只有开了延长重试才在窗口内每小时再看。发送这一步仍然没有备用通道（不让别的模型替 TA 说话）。
- **晚发提示**：普通念头比原定时刻晚了 20 分钟以上才发（忙着押后、失败重试、你正说着话），事实核对里会写明原定时刻和晚了多久，并要求和时刻绑着的话（问午饭、道早安、提醒马上要做的事）直接作罢。
- **约定快车道**：离上次判断不到 `gateGapMin` 时，聊天里冒出约定线索可以提前判——一天头两次 1 分钟，之后至少隔 10 分钟（`state.ledgerFast = { date, n }`）。上一次没判成（`failed`）就等正常间隔。模型根本没调通的那次不占 `recheckCount`，也不占自发起念的次数。
- **跨天**：新一天的 `judgedChatAt` 从前几天的行接过来（7 天内），不再每天零点把前 6 小时的聊天重判一遍。
- **口头了结**（`settleByWords`）：「太好了 / 就好了 / 快好了」里的「好了」不算做完；撞不上词的短句只有在 TA 上一句正说着这件事（至少撞上两个词）时才认；比这件事记下 / 改动时刻还早的话不能了结它。
- **连着没回的轮数**（`unansweredRounds`）：你说完 30 分钟内跟上的第一轮是回复，不算；到点主动发的（`timedwake:`）照数。
- **没问到模型不算问过**：自发由头因分量不够被拦时不记 `missKey`；「到日子了」只有真起了念头才记这一阶段的标记，被婉拒按「惦记」这个由头歇 3 小时 × 次数再问。
- **一套解析器**：判断输出用 `parseJudgeText`（底下是 `parseModelJson`，会剥 `<think>` / `<thinking>` / `<thought>`，正文里有多个 JSON 对象时挑带判断字段的那个）。
- **约定不重挂**：同一个约定、同一版只挂一次定时器。手动撤掉、到点作罢的不会被下一轮挂回去；改期或在账本里「放回」会升版本，那时才重新挂。
- **你正说着话**：到点时你最后一句话才过去不到「正聊着」窗口（`presendTalkingMin`，默认 15 分钟）的三分之一，普通念头押到窗口结束再看；约定不受影响。
- **恢复时补推**：草稿里记 `pushed`。重试时发现正文已在发件箱、通知没推过、手机也还没收走（12 小时内），补推一次。

### 审计第二批：防卡死、看得见、防误操作（2026-11）

- **推送超时**（`push.ts`）：每个订阅最多等 10 秒（`web-push` 的 socket 超时外再兜一层 12 秒的硬超时）。超时的订阅这一批剩下的几段不再等它，订阅本身不删，下次照常推，结果里记 `timeout`。
- **`/health`**（`health.ts`）：不再恒为绿。返回 `ok`、`running`、`problems`（只有代号，不带角色名和报错原文）：
  - `tick_stale`：超过 20 分钟没跑完一轮，此时 HTTP 503；
  - `gen_failed`：有启用的角色今天的日程生成报错；
  - `model_unreachable`：最近 6 小时最后一次判断是模型没调通；
  - `send_failing`：最近 2 小时有到点发送失败；
  - `push_failing` / `no_push_subscription`：最近一次推送一条也没送出去 / 没有订阅（进程内记，重启清空）。
  其余问题仍回 200，但 `ok: false`。带原因的说明在 `GET /status` 的 `health.problems[].note`（要令牌）。
- **看门狗**（`main.ts`）：超过 30 分钟没跑完一轮就 `exit(1)`，由 systemd `Restart=on-failure` 拉起；启动时正在生成的念头照旧放回待发、重发前核对投递凭据。
- **覆盖迁入**：`POST /import { force: true }` 只认运维令牌（手机上的个人云密钥回 403），真发模式下回 409；命令行 `cli.ts import --force` 在真发模式下要再加 `--overwrite-live`。两条路做之前都用 `vacuum into` 在库旁边留一份 `companion.db.before-force-import-<时间>.bak`（权限 600）。不带 `force` 的迁入不变。

### 审计第二批（续）：个人云抖动、坏数据、长占锁、重启、内网地址（2026-11）

- **用量上限读不到不当成没上限**（`llm.ts`）：`usageBudget` 读上限或当天用量失败（网络错、非 2xx、回的不是数组）抛 `UsageUnknown`；没有上限那一行才算没设上限。判断和生成一天这一轮不调模型；到点的消息押 5 分钟再看，不算一次发送失败；回复兜底不受上限管，照常。记账时区用 `usageTz()`：这次读不到就沿用上次读到的，不退回 UTC。没改的：个人云里根本没有上限行时时区仍是 0，这和云函数一致，改了两边会记到不同的日子。
- **会话租约**（`generation-lease.ts`）：续租请求没问到（超时、5xx）不再永久判丢。离上次续成不到 8 分钟（库里一次续 10 分钟）就照常往下走；超过才报「续不上」，而且之后续成了还能接着用。只有个人云明确回「不是你的了」才永久判丢。
- **生成一天不占全局锁**（`engine.ts` `prepareDay` / `writeDay` / `applyDay`，`runner.ts` `detachGeneration`）：读聊天、调模型那段放到锁外，跑完再排进锁里落库；落库时重新读库，这期间你手动生成或改过这一天就以你的为准。生成期间别的角色照常到点发，手机的写请求不用等。命令行和测试不开这个选项，仍在一轮里原地跑完。没改的：判断和成文仍在锁里（一次判断最坏 4 分钟、成文 5 分钟），期间手机的写请求还是要等。
- **优雅退出**（`main.ts`）：收到 SIGTERM 后先停掉定时器、不接新连接，给正在跑的一轮 30 秒自然跑完；还没完就打断模型调用，再等 10 秒让它放掉个人云里的会话租约、把念头放回待发，然后关库退出。被打断的判断不记「模型没调通」、不占次数，被打断的发送不算一次失败，被打断的生成不算一次尝试。唤醒和回复兜底不打断，沿用各自的重启恢复。
- **切会话只认聊天模板**（`templates.ts`、`engine.ts`）：判断 / 生成模板带着另一个会话 ID 先到时不再切换角色的会话。到点发送前再核一次：聊天模板的会话和角色当前会话不一致就不成文，走发送失败的重试，等新会话的聊天模板。
- **密钥校验**（`auth.ts`）：个人云超时、5xx、429 是「没问出来」，不缓存成密钥无效，接口回 503「个人云暂时连不上」；核对通过的密钥在个人云抖动期间最多再认 24 小时。
- **聊天镜像坏行**（`history.ts`）：缺 id、时间不成样的行丢掉，正文不是字符串的当空，坏掉的整轮快照退回发件箱原文；跳过的条数记在 `history.skipped` 和这一轮的轨迹里。没做的：每分钟全量重读 200 条镜像 + 200 条发件箱没有改成增量。
- **模型 / MCP 地址设防**（新增 `net-guard.ts`）：每次请求前解析主机名，指向本机、内网、链路本地、保留段的不请求，不跟随跳转。确实要用本机的模型网关，在环境变量 `COMPANION_ALLOW_HOSTS` 里列主机名（逗号分隔）。没做的：解析和建连是两次解析，DNS 重绑定还防不住。
- **`/app/state` 带后端体检**：多一个 `health: { ok, problems: [{ code, note }] }`，和 `/status` 里的是同一份；挂念 0.10.4 的诊断页「后端体检」读它。

