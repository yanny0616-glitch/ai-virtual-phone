# Fork 改动清单

相对 upstream `xiaolongbao0709/ai-virtual-phone` 的全部改动。
主文档见 [../CLAUDE.md](../CLAUDE.md)，构建纪律和部署链路都在那边。

> 加了新功能就在这里补一段，**别往 CLAUDE.md 里堆**。

`git diff upstream/main...main` 共 23 个提交、56 个文件（2026-08-30 核对）。分三类：

## A. 部署基础设施（upstream 没有，纯自建）

- `.github/workflows/float-release.yml` — 构建+发布流水线（链路图见 CLAUDE.md 的「部署链路」）
- `ops/float-deploy.sh` / `.service` / `.timer` — 拉取、校验、切换、回滚、健康检查
- `ops/float-ai-phone.service` — 生产服务单元
- `next.config.mjs` — 加 `output: "standalone"`，让 CI 产出自包含运行时，服务器上不需要 `npm install` / `next build`

## B. 功能与修复

1. **支持导入 SillyTavern 角色卡**（`lib/character-storage.ts`、`components/phone-character-app.tsx`、`lib/resource-hub-client.ts`）
   - 删掉原来的 `CHAR_BLOCKED_FIELDS` 拦截：upstream 见到带 `greeting`/`first_mes`/`scenario`/`mes_example` 的卡直接报错拒收
   - 改为兼容解析：识别 `chara_card_v2/v3` 的 `data` 包裹层，V1 扁平卡照旧；只取核心人设（`description`/`persona` 等），greeting、`alternate_greetings`、scenario、示例对话丢弃不导入
   - **卡内世界书 `character_book` 是支持的**（`lib/character-world-book.ts`、`234c746` / `a058d35`）：V2/V3 读 `data.character_book`，扁平卡读根上；解析后挂在角色上，用户在角色详情页点「导入世界书」才写进世界书库并绑定，可解绑/重新导入。导出角色时按 `character_book` 形状带出，导回酒馆认得
   - PNG 卡读取顺序改为 `ccv3` → `chara` → `ai_phone_character`，base64 兼容 URL-safe 变体与缺失 padding，改用 `TextDecoder` 解 UTF-8
   - PNG tEXt 块加长度校验（上限 8MB，且不得超过剩余字节），角色卡是用户上传文件，声明长度不可信

2. **Supabase 新版密钥兼容**（`lib/server/supabase-rest.ts`）
   - `sb_secret_*` 是不透明 API key 不是 JWT，放进 `Authorization` 会被拒；现在只作为 `apikey` 头发送，由网关映射到 `service_role`
   - 旧的 service_role JWT 仍然走 `Bearer`

3. **CI 修补**：`fix: package public assets at the correct path`（避免打出 `release/public/public`）、`ci: upgrade GitHub Actions runtime`（checkout/setup-node 升到 v7、Node 22）、`fix: use installed Node path for Float service`

4. **预设条目顺序修复**（`components/settings/preset-manager.tsx`，`e860c92`）
   - 拖动排序**只写 `prompt_order`**，`preset.prompts` 保持原始顺序——这是设计，别改
   - 但 `createPromptAtEnd` / `appendImportedPrompts` 原来按 `preset.prompts` 数组顺序重建 `prompt_order`，等于新建或导入一条就把用户拖好的顺序整个打回原始顺序
   - 改成和 `insertPromptAfter` 一致，用 `buildDisplayedPrompts(preset)` 做基准。**以后任何写 `prompt_order` 的地方都必须走 `buildDisplayedPrompts`**

5. **角色卡人设折叠**（`components/phone-character-app.tsx`，`9872323`）：ST 卡人设动辄几千字，详情页默认折叠

6. **个人云备份**（`components/settings/cloud-services-setup.tsx`、`lib/cloud-backup/storage-client.ts`）
   - `232b863` 第二台设备可以直接接入已有的个人云，不用重新建
   - `06122d1` 云备份这条路径也认 `sb_secret_*` 新版密钥（和上面第 2 条同一个坑，两处都要改）

## C. 提示词缓存 + 用量统计（这一块最大，跨 10 个提交）

背景：这是自建功能，upstream 完全没有。改动集中在 `lib/llm-provider-adapter.ts`、`lib/api-usage-stats.ts`、`lib/api-log-store.ts`、`components/app-market/custom-app-runner.tsx`。

1. **提示词缓存开关**（`ca8c8e2` / `9c4c4eb` / `4f49453`）
   - Anthropic 的 `cache_control: {type:"ephemeral"}` 打在 tools → system → 最后一个 message content block 上（`llm-provider-adapter.ts:96-105`、`:624`、`:645`）
   - OpenAI 走官方自动前缀缓存 + `prompt_cache_key`（只影响路由）；Gemini 的 `cachedContentTokenCount` 本来就含在 `promptTokenCount` 里
   - 两处开关：API 配置里逐条开（`settings-types.ts` 的 `promptCache`）、工坊单独开（`lib/qa-prefs.ts`）
   - ⚠️ **已知问题**：`cache_control` 会让某些严格按 Anthropic 协议反序列化的中转报 500 `data did not match any variant of untagged enum MessageContent`。目前没有按 provider 收窄，撞上就手动关掉那条配置的缓存开关

2. **用量归一化**（`3a13f7f`）
   - `LlmUsage` 把三家字段拉平；缓存**命中**和**写入**分开记，因为计费不同（命中 ~1/10，写入 1.25×），合在一起看不出这次是省了还是亏了
   - 流式用量分散在多个事件上（OpenAI 要 `stream_options:{include_usage:true}`；Anthropic 分 `message_start`/`message_delta`；Gemini 每块都发累计值），靠 `mergeLlmUsage` 逐条合并

3. **按角色卡分桶**（`25c161a` / `6a20636` / `ef6de85`）
   - 统计以 **`characterId`** 为键，改名后仍指向同一张卡；后台功能调用没有卡，退化成 `name:<功能名>`
   - 各 `lib/*-engine.ts` 的 `callLLM` 都补了 `characterId` 参数往下传，加新引擎时别漏
   - 老日志只有名字没有 id，所以日志筛选同时接受 `characterId` 和 `characterName`

4. **自定义 APP SDK 两级权限**
   - `usage.read` — 每日聚合 + 调用日志**元信息**（时间、模型、来源、token 数）
   - `usage.logs` — 日志**原文**（完整提示词、角色人设、世界书、回复原文），因为比聊天记录本身还敏感，必须单独申请
   - 动作：`usage.readDaily` / `usage.readLogs` / `usage.readLogDetail`，派发在 `custom-app-runner.tsx`
   - 改了 SDK 就跑 `npm run check:sdk`（校验 SDK/派发/权限/文档四处一致）

## D. 安全加固（`6962264`）

- `lib/server/safe-outbound-fetch.ts` — **新增**。所有出站请求（图片生成、OAuth 回调、tool-proxy）走它：解析 DNS 后校验目标 IP，挡内网/回环/链路本地地址，限制重定向次数，防 SSRF
- `components/ui/story-html-renderer.tsx` — 渲染模型输出的 HTML 前做清洗
- ⚠️ 已知遗留：`safe-outbound-fetch.ts:135` 有个 `LookupFunction` 的 TS2322，`npx tsc --noEmit` 会报，不是新引入的

## E. 网易云音乐 API 接入（2026-08-30）

`ncm-api` 容器（`moefurina/ncm-api`）本来就在跑，只是没有公网入口。这次把它挂到
**同域路径** `https://float.yanny.top/ncm` 下，没有开子域：

- 音乐功能是浏览器直连接口（`lib/music-service.ts` 全是裸 `fetch`），同源就不用配 CORS
- 省一条 DNS 记录，也不用多开一个公网入口
- Caddy 侧改动在 `/root/Documents/Codex/2026-08-02/vps/reverse-proxy/Caddyfile` 的
  `float.yanny.top` 块里：`handle /ncm/*` → `uri strip_prefix /ncm` → `reverse_proxy ncm-api:3000`，
  并加 `Cache-Control: no-store`（请求里带各用户自己的 `cookie`/`realIP` 查询参数）

`NEXT_PUBLIC_DEFAULT_NETEASE_API_BASE` 在 `.github/workflows/float-release.yml` 里给。
**`NEXT_PUBLIC_*` 是构建时内联的**，写服务器上的 `.env.local` 不生效——这是个反复踩的坑。
用户在音乐 APP 设置里填过自己的地址时以用户的为准（见 `lib/music-api-defaults.ts`）。

## F. push.wake 权限 + 「挂念」自定义 APP（2026-08-31）

自定义 APP 新增 `push.wake` 权限，把主程序既有的定时唤醒离线推送链路
（`TimedWakeSchedule` → `armTimedWakeBailout` → Supabase `push-generate` 边缘函数，
失败降级为 `follow-up-service` 本地轮询）开放给 APP：

- `lib/custom-app-host-api.ts` — `scheduleCustomAppTimedWake` / `listCustomAppTimedWakes` / `cancelCustomAppTimedWake`。
  约束：延迟 1 分钟 ~ 7 天、intent ≤500 字、每 APP 最多 24 条待触发、拒绝群聊；
  wake id 前缀 `timed_wake_capp_<appId>_` 实现按 APP 隔离（`TimedWakeSchedule` 本身没有 appId 字段）
- SDK：`AiPhone.push.wake / listWakes / cancelWake`（`custom-app-runner.tsx`）；
  `check-custom-app-sdk-consistency.mjs` 的 NAMESPACES 补了 `push`
- 服务端挂载失败时返回 `armed:false + reason`，本地轮询路径照常触发（仅浏览器开着时可达）

`custom-apps/gua-nian/`（挂念）— 首个用这条链路的 APP，灵感来自 AstrBot 私人陪伴类插件：
生成角色今日生活面（与系统日程 `calendar.read/write` 互通，写回条目 id 带 `guanian_` 前缀）
→ 候选时刻 → AI 动机复核 → `push.wake` 预约 → 面板可预览「她此刻会说什么」+ 全量诊断日志。

## G. 日历内置「暖桃」主题（2026-08-31）

日历主题弹窗加了第 7 个内置主题 `peach`（暖桃），与「挂念」APP 同一暖桃色系，
免去用户手动粘自定义 CSS：

- `lib/calendar-storage.ts` — `CALENDAR_THEME_IDS` 增加 `"peach"`
- `components/calendar-app.tsx` — `CALENDAR_THEMES` 增加 `{ id: "peach", name: "暖桃" }`
- `styles/tokens.css` — `[data-calendar-theme="peach"]` 全量 token（含 hair/glass/scrim 与八色事件色板，整体偏暖降饱和）
- `styles/calendar.css` — peach 缩略色块 + 主题专属珊瑚渐变 FAB、奶油色时间轴列头行

## H. 离线推送·到点补上下文（2026-08-31）

冻结请求快照的最大盲区：预约之后、触发之前，`push-generate` 可能已经替同一角色
发过别的主动消息（同天多个定时唤醒、冷场连发），但快照是预约时冻结的——角色
到点「失忆」，会重复自己或当作什么都没发生。修法不建新表：这些消息本来就都在
`push_outbox` 里，触发时现查现补。

- `lib/push-bailout-client.ts` — 主动类预约（followup / idle / timedwake / periodcare，
  经 `postBailoutJob` 统一注入）的 `merge` 新增 `snapshotAt`（快照冻结时刻）
- `supabase/functions/push-generate/index.ts` — `timed_task` / `followup` 任务触发时，
  查同会话 `snapshotAt` 之后 `pushGenerated=true` 的 outbox 行（≤5 条、每条截 400 字），
  以 user 角色追加一条系统备忘（「你已经发过这些、对方还没回，衔接勿重复」）再重放请求；
  按 providerKind 适配 messages/contents 格式。补失败不阻塞生成，老快照无 `snapshotAt` 跳过。
  `reply_bailout`（90 秒租约无此问题）与 `shortcut_resume`（续跑已代入首条回复）不补。
- 部署：用户在「设置 → 云服务部署」重新部署个人云即可生效（部署包已由
  `scripts/build-personal-push-dist.mjs` 同步进 `public/ai-phone-push/`）；新旧两端互相兼容。

## I. 聊天镜像 · 个人云后端阶段①（2026-08-31）

「挂念」离线判断的地基：把新聊天消息抄送一份到用户自己的 Supabase 个人云，
本地 IndexedDB 仍是唯一事实来源（纯加法，镜像失败不影响任何聊天功能）。默认关闭。

- `lib/chat-mirror-client.ts`（新）— 监听 `chat-message-pushed` 事件排队抄送
  （仅单聊 user/assistant，正文截 4000 字），kv 持久化队列（上限 800、批量 50、
  失败留队 60 秒重试）；开启时回填最近 10 个会话各 60 条；`health` 能力探测
  （旧版云函数静默停发）；`clearChatMirrorCloud()` 一键清空云端副本
- `supabase/functions/ai-phone-push/index.ts`（同步 `public/ai-phone-push/gateway.mjs`）—
  新增 `chat-mirror` 动作（service key 门卫之后）：POST 批量追加（按 id 幂等、逐条校验）、
  GET 按角色/时间查询（≤200 条）、DELETE 清空（可按角色）；`health` 在 schemaVersion≥4
  时报告 `chat-mirror` 能力；在线开关 cron 的清理任务加镜像 60 天保留
- `docs/personal-push-supabase.sql`（同步 `public/ai-phone-push/schema.sql`）—
  新表 `push_chat_mirror`（RLS 开启、仅 service_role、role 约束、角色+时间索引），
  部署守卫白名单收录，cleanup cron 加 60 天保留；`ai_phone_cloud_meta` 升 schema_version 4
- `components/settings/cloud-services-setup.tsx` — 「聊天镜像」开关（需离线推送已部署）+
  「清空云端镜像」按钮；部署时 meta 写 4
- `components/desktop-shell.tsx` — 启动挂载 `installChatMirror()`
- `components/settings/about-declaration.tsx` — 隐私声明补充镜像说明（自愿开启、
  自有项目、60 天、可清空）
- `custom-apps/gua-nian/`（0.4.3）— 设置页新增「云连接」（个人云地址 + Secret key，
  只存应用本地数据）+ 测试连接；诊断页新增「云端镜像」卡片（连接/能力/该角色最近一条）
- 生效方式：站点更新后，在「设置 → 云服务部署」重新部署离线推送（云函数 + SQL），
  再打开「聊天镜像」开关
- 后续修补（同日）：`assert_dedicated_project` 复核无标记的已配置项目，重部署改为
  原地更新而不是新建项目（免撞免费版 2 项目上限）；`characterIdForSession` 修正
  `session.contactId` 即角色 ID 的口径（此前镜像整条静默丢弃）；设置页加
  「立即上传」按钮（手动冲队列、报真实错误）

## J. 离线未回应降速 · 个人云后端阶段②（2026-08-31）

用户没回消息时，云端定时生成也要「收手」：预约唤醒可带 `cooldownRounds` 阈值，
到点先查聊天镜像 + 离线期间已代发的 outbox，用户连续这么多轮没回就取消这次生成。
逐任务可选（不带阈值 = 原行为），无 schema 变更，旧云函数忽略该字段。

- `lib/timed-wake-storage.ts` — `TimedWakeSchedule` 加 `cooldownRounds?`
- `lib/custom-app-host-api.ts` — `push.wake` 解析并夹取 `cooldownRounds`（0–9）存进预约
- `lib/push-bailout-client.ts` — 冻结请求时把 `cooldownRounds` 并入 push_jobs 的 merge
- `supabase/functions/push-generate/index.ts`（同步 `push-generate.mjs`）— `timed_task`
  生成前查 `push_chat_mirror` 该会话末尾连续 assistant 按轮计数（相邻 3 分钟归一轮、
  最新一轮晾满 30 分钟才计，与挂念本地口径一致），再加镜像之后 `pushGenerated` 的
  outbox 行；达阈值 `finish("done", "cooldown skip…")`。镜像空/查询失败不拦
- `custom-apps/gua-nian/`（0.4.4→0.4.5）— 0.4.4 修「他刚回完就说未回复降温」
  （连发多条气泡按轮数 + 30 分钟晾置口径重写 `unansweredStreak`）；0.4.5 三处
  `push.wake` 带上 `cooldownRounds = 设置的未回轮数阈值`
- 生效方式：站点更新后重新部署个人云（更新 push-generate），装 0.4.5 后
  在「今天」页重新编排一次，让新预约带上阈值
- 面板可视化（同日，gua-nian 0.4.6）：网关 `jobs` 加只读 GET（解密 payload 只回传
  sessionId / cooldownRounds / armAt 等非敏感字段，绝不回传冻结请求本体），health
  报 `job-status` 能力；挂念诊断页新增「云端预约·降速」卡片——每条预约的触发时间/
  状态/带没带阈值/`result_note`（含「已降速拦截」高亮），旧预约未带阈值时提示重新编排

## K. 推送通知体验：角色头像 icon + 进 App 收弹窗（2026-08-31）

- `lib/notification-avatar-cache.ts`（新）— 启动 8 秒后把每个角色头像居中裁方缩到
  192px JPEG 写进 Cache Storage（`notif-avatar-v1`，SW activate 清缓存时豁免），
  删角色后清残留；`closeChatPushNotifications()` 关掉托盘里聊天类系统通知
- `lib/push-bailout-client.ts` — 五处预约（回复兜底/连发/闲时/定时唤醒/经期关怀）
  的 `notify` 都带上 `characterId`
- `supabase/functions/push-generate/index.ts`（同步 dist）— 推送 JSON 透传
  `characterId`，老 SW 不认识则忽略
- `public/sw.js` — 弹通知时若缓存里有该角色头像，转成小 data URL 当 icon
  （icon 取图不保证走 SW fetch，内联最稳，>200KB 不内联）；点开一条聊天通知时
  把托盘里其余聊天通知一并收掉
- `lib/push-outbox-client.ts` — 启动/回前台/SW 告知有新消息且页面可见时，
  调 `closeChatPushNotifications()`：人在 App 里就不留系统弹窗（快捷指令、
  来电通知不动）
- 生效方式：站点更新后刷新一次页面让新 SW 接管；重新部署个人云更新 push-generate；
  已挂的预约在下次快照刷新/重新编排后才带 `characterId`

## L. 云端复核门禁（2026-09-01）

`push-recheck` 原来是「被 cron 派到 + 25 分钟没判过 + 有新消息」就直接发一次 LLM 裁决，
判断即花钱，只能靠 `DAILY_RECHECK_CAP = 6` 硬压着——聊得密的上午就能把一天额度烧光。
改成先过一层只读本地状态的门禁，全过了才花钱：

- `supabase/functions/push-recheck/index.ts`（同步 dist）— 新增 `GATE_DEF` 五道门，
  阈值可被 App 上传的 `context.gate*` 覆盖（改设置不用重新部署）：
  `gateDailyCap`(8) / `gateGapMin`(25 分钟) / `gateHorizonMin`(240 分钟，最近的待发时刻比这更远就不判) /
  `gateFreshMin`(10 分钟，刚说完话先等) / `gateMinMsgs`(1 句)。
  `last_recheck_at` 改成只在真的发裁决时才占坑——被门禁拦下不推迟下一次判断
- 拦截原因写进 `push_recheck_plans.decisions`，条目形如 `{kind:"gate", note, by:"cloud"}`：
  不带 `time`，App 的合并循环天然跳过，只当诊断用；原因没变就不写回，免得每轮 cron 都动一次行
- `custom-apps/gua-nian/`（0.6.2）— 设置里新增「云端复核门禁」五个 stepper，
  随计划一起上传；拉取云端裁决时把门禁记录写进诊断日志
- 无 schema 变更、无 cron 变更；生效需用户在「设置 → 云服务部署」重新部署个人云

## M. 发送前复核（2026-09-01）

原来到点那一刻只查一条硬规则：连续 N 轮没等到回复就跳过。改成先算一个「不合时宜度」，
够高就不发，判据不管发没发都写回计划，App 点开那条主动消息能看到当时到底是怎么判的：

- `supabase/functions/push-generate/index.ts`（同步 dist）— `timedwake:` 类任务在拿到
  聊天镜像之后，按 `trigger_key` 里的 wakeId 反查 `push_recheck_plans`（取最近两天的计划，
  认 wakeId 不认日期，跨零点触发才不会落空），算三个信号：
  未回应轮数占比 40% + 距上一句用户消息的贴近度 40% + 距上一条主动消息的贴近度 20%，
  合成 `press`，`press >= presendMax` 就不发。阈值同样走 `context`：
  `presendMax`(70) / `presendTalkingMin`(15 分钟) / `presendGapMin`(60 分钟)
- 只在 wakeId 能对上挂念计划里的时刻时才按分数拦；对不上就退回老的硬冷却规则，
  别的来源的定时唤醒不受影响
- 判据写进 `decisions`，条目形如 `{kind:"presend", time, blocked, note, scores:{pr,pt,pg,press,rounds,max}}`：
  带 `time` 所以会并进对应时刻，但**不打「云端调整过」角标**——它是这一条的执行判据，不是改计划
- `custom-apps/gua-nian/`（0.6.2）— 设置里新增「发送前复核」三个 stepper；
  二级弹窗新增「发送前复核」一节，三个信号各一条进度条，末尾给结论和阈值，
  被拦下的那条用警示色标出原因
- 无 schema 变更；生效需用户在「设置 → 云服务部署」重新部署个人云

## N. 精力随时间衰减（2026-09-01）

`day.energy` 原来是生成生活面时定的一个数，一整天不动，卡片上那条精力条只是个标签。
改成基线 + 衰减，每分钟重算：

- `custom-apps/gua-nian/index.html` — 生活面的 JSON schema 里每条日程多一个 `cost`
  （-40～40，负=开会/通勤/应酬这类消耗，正=午睡/吃饭/散步这类回血），
  同一次 `ai.generate` 出，不多花调用；`energy` 的语义改成「刚醒时的基线」
- 新增 `energyAt(day, ms)`：基线 + 已发生日程的 cost 累加 − 醒着时长缓降
  （07:00 起每小时 1.2，22 点后每小时 8）。凌晨 5 点前算作前一晚的延长，
  否则熬到 1 点反而显示精神饱满
- 用上的地方：此刻卡片的精力条（多显示一个「起床 X%」对照）、记录页今天那张卡、
  上传给云端的 `context.energy`、编排与在页复核两个 prompt
- 编排 prompt 里每个候选时刻额外带上**那一刻**的剩余精力，模型能分辨
  「22:30 那会儿只剩 35%」，不再只看一个全天平均数
- 老的 day 记录没有 `cost`，默认 0，只吃时间缓降，不会报错

## O. 日程可逐条改（2026-09-01）

日程原来只能整天重生成，改一条得把一天全推倒。改成每条可点开单独处理：

- `custom-apps/gua-nian/index.html` — 时间轴上的日程行可点，复用已有的 `#dsheet`
  底部抽屉（标题在「时刻详情」和「日程详情」之间切换）；抽屉里显示这条的精力影响、
  做完之后剩多少精力、挂着的心动时刻
- 「重新生成这一条」：可留一句要求，一次 `ai.generate` 只重写这一条
  （time/title/note/cost），把同一天其余日程一起给模型防撞时间；重写后时间可能变，
  按新下标重画抽屉
- 「删除这一条」：二次确认（按钮先变成「再点一次删掉」）
- 改完照旧走 `syncCalendar`：清掉 `guanian_` 前缀的旧条目、保留手动条目、重新写回，
  和整天重生成时一模一样
- **不自动重排**：重排要花一次模型调用、还会取消已挂的预约，改完只 toast 提示
  「要跟上就点♥ 重新编排」
- 日程行如果已经挂了心动时刻，那一行由 `wakeRow` 占着点不到，所以时刻详情底部补了
  一个「✎ 改这条日程」入口；`detailHtml` 会被异步重画，这个按钮走 `#dsheet-body` 委托绑定

## P. 自定义 APP 注入聊天提示词（2026-09-01）

自定义 APP 原来没有任何办法把自己的状态送进「用户↔角色」的聊天提示词：
`custom-app-chat-directives.ts` 只管富媒体指令语法，`CustomAppPromptProfile` 只过滤 APP
自己那次 `ai.generate`，`characters.state.write` 会往聊天里插一条可见的系统消息且只收
0–100 的数值，`setChatPluginPromptFragment` 属于聊天插件那套扩展。新开一条通道：

- 新权限 `chat.context`（`lib/custom-app-types.ts` + `lib/custom-app-storage.ts` 两处白名单）
- 新文件 `lib/custom-app-chat-context.ts` — 按 `appId × characterId` 存覆盖式片段
  （`characterId` 省略则落在全局作用域，对所有会话生效），
  `formatCustomAppChatContextForPrompt(characterId)` 汇总成一个 `<app_context>` 块。
  **只认还装着、且还持有 `chat.context` 的 APP**：用户在权限页撤销后注入立刻停，
  不靠 APP 自己收手
- `lib/custom-app-host-api.ts` — `writeCustomAppChatContext` / `dropCustomAppChatContext`，
  同时登记成后台动作（`chat.setContext` / `chat.clearContext`），
  APP 关着时也能靠 `tasks.schedule` 刷新
- `components/app-market/custom-app-runner.tsx` — SDK 外壳 `AiPhone.chat.setContext()` /
  `clearContext()`、dispatch 分支、命名空间方法表
- `lib/macro-engine.ts` — 新宏 `{{customAppContext}}`（别名 `{{自定义应用状态}}`）；
  `llm-prompt-assembler.ts`（单聊 + 群聊两处入参）、`chat-engine.ts`、`group-chat-engine.ts`
  把它接上（群聊没有唯一角色，只取全局作用域的片段）
- `lib/builtin-preset.ts` — 新条目「▸ 自定义 APP 实时状态」`custom_app_context`
  （`tags: ["chat"]`）和群聊版 `custom_app_context_group`（`tags: ["group_chat"]`），
  内容就是那个宏，**排在 `prompt_order` 最末**

**老用户怎么拿到这个条目**：内置预设的副本只在 `BUILTIN_PRESET_VERSION` 升版本时
才会被出厂内容整份重写，而那会把用户改过的内容打回原样。为了加一个条目不值当，
所以另开了一个只增不改的补丁号 `BUILTIN_PROMPT_PATCH_VERSION`
（`lib/builtin-preset.ts` + `settings-storage.ts` 的 `backfillBuiltinPrompts`）：
只把 `PATCHABLE_PROMPT_IDS` 里列的新条目追加到末尾，一条已有内容都不动。
以后再加出厂条目走同一条路——补丁号 +1，identifier 进那张表。
**用户自建 / 导入的预设不在补丁范围内**，那是用户自己的东西，不该被悄悄改；
要用就自己加一条内容为 `{{customAppContext}}` 的条目，或把这个宏拼进已有条目。

**为什么必须排在 `shortTermMemory` 之后**：`lib/llm-provider-adapter.ts` 给整个 `system`
串只挂一个 `cache_control` 断点，任何进 `system` 的逐轮变动文本都会让整段系统提示词
（人设、世界书、记忆）每轮重新计费。放在 chatHistory 之后，作废的只是尾巴那一小截。
条目在预设编辑器里可以拖，位置是用户自己的选择，默认给到缓存最优的位置。

## Q. 挂念 0.7.0：情绪跟随聊天 + 注入聊天（2026-09-01）

- `custom-apps/gua-nian/index.html` — 新增会衰减的「情况栈」`day.conds`：
  每条 `{mood, cause, energyDelta, intensity, halfLifeMin, startAt}`，
  权重 `0.5 ^ (已过时间 / 半衰期)`，降到 0.08 以下就清掉（最多留 8 条）
- 情绪三层：当天生成的 `day.mood` 是**情绪底色**，上面盖着聊天判出来的 cond
  和刚做完那件事的余味（90 分钟半衰期），谁分量重显示谁，都淡了就露回底色。
  此刻卡片的大字改成显示当前情绪，被盖住时多一行「因为 X · 底色「Y」」
- `energyAt` 把 conds 的 `energyDelta × 权重` 也加进去——精力从此**可升可降**，
  日程 cost 是走过就永久记账的，conds 会自己淡掉，两条路不重复计
- 情绪从哪来：复核那一次 `ai.generate` 的 JSON 多要一个 `feel`
  （情绪 / 缘由 / 对精力的加减 -20～20 / 强度 0–100 / 几小时淡一半），**不多花调用**。
  所以复核关掉（`recheckMin = 0`）时情绪不会跟着聊天动
- 新设置项 `injectChat`（默认开）+ manifest 加 `chat.context` 权限：
  开着时每次状态变化就 `AiPhone.chat.setContext` 覆盖式写一段
  （在做的事 / 情绪+底色+缘由 / 精力% + 一句体感 / 接下来那件事）；
  关掉、或换挂念对象时写空串撤销
- 正文里**不写当前钟点**：挂念关着的时候这段不会刷新，写死的时间会变成假话；
  快照时刻放进 label，渲染成【挂念 · 14:32 的状态】，角色对着提示词里的真实时间
  自己能看出这份状态旧了多少
