# Fork 改动清单

相对 upstream `xiaolongbao0709/ai-virtual-phone` 的全部改动。
主文档见 `/root/vibe-coding/float/CLAUDE.md`（**在仓库外**，故意不提交；构建纪律和部署链路都在那边）。

> 加了新功能就在这里补一段，**别往 CLAUDE.md 里堆**。

`git diff upstream/main...main` 共 139 个提交、130 个文件（2026-09-03 核对）。

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

## G. 日历「暖桃」主题：加了又挪走（2026-08-31 → 09-03）

一度做成第 7 个内置主题 `peach`，与「挂念」APP 同色系。**09-03 `95d28b5` 已从源码移除**：
只是一组配色变量加两条规则，日历设置里的「自定义 CSS」框就能承载，不值得占
`styles/tokens.css` 的位置——那个文件每次合上游都是撞车点。

- 现在 `CALENDAR_THEME_IDS` 里没有 `peach`，`components/calendar-app.tsx` 的
  `CALENDAR_THEMES` 也没有；配色靠用户自己粘进日历的自定义 CSS 恢复
- `lib/calendar-storage.ts` 的 `LEGACY_THEME_MAP` 补了 `peach: "cream"`（`5b11bd9`）：
  已经选中暖桃的设备落到同为暖色的 cream，不会被 `normalizeCalendarTheme` 甩回冷白的 light。
  **以后再删主题，删一个就往这张表里补一条**

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

## R. 聊天插件体系（2026-09-01 ~ 09-02）

方向：**宿主只留钩子，规则进官方插件**。改行为先看现有钩子够不够，不够再在宿主开坑位。

- **官方插件随宿主发布**（`6fdc32a`）：`chat-plugins/*.js` 构建时复制到 `public/chat-plugins/`
  并生成 `index.json`（`scripts/build-chat-plugins-dist.mjs`，挂在 package.json 的构建里，
  dist 目录进 .gitignore）；`lib/chat-plugin-official.ts` 是清单，扩展插件页多一个「官方插件」区，
  已装的官方插件启动时对照版本静默升级（`components/chat-plugin-bootstrap.tsx`），用户不必手动导入文件
- **坑位**（`lib/chat-plugin-types.ts` / `components/chat/chat-plugin-slot.tsx`）：新增「气泡旁边」
  （`4a24422`）、输入栏工具坑位带 `sessionId`（`2918f68`）、「+」面板的插件按钮并进内置按钮网格（`5e8fb25`）
- **浮层**：关进手机壳、高度按遮罩算而不是窗口 88vh（`256e9d9` / `7aa1dff`），
  遮罩上下留白算进安全区，灵动岛机型不再压住面板顶部（`40e21d2` / `8c48c45`）
- **共享变量池**（`dba5aad`）：插件的 `ctx.data.variables` 与自定义 APP 的
  `AiPhone.variables.get/set/update/unset`（权限走 `chat.context`）读写同一个池，
  两边不用各算一份；创作指南（`lib/custom-app-creator-guide.ts`）与插件文档（`lib/chat-plugin-docs.ts`）各补一节
- **宿主坑位与钩子**：`chat.presence` / `list.avatar` 坑位、`variables.changed` 事件、
  replyGate 只读接口（`833b511`）；`moments.beforePost` / `moments.schedule`（`e1c25b4`）

## S. 官方插件「好感与关系」（`chat-plugins/affection-ledger.js`，1.0 → 1.5.1）

原来的自带状态区让模型每轮自报一个 0–100 的绝对值，没有来由也不累积。改成：
同一次回复的 `[内心]` 块里带心里话、好感变化量（`-3～+3|理由`）、只在转折点出现的 `关系→x`，
插件截下来累加——**每日封顶、闲置回落，关系要在面板确认才变**。

- 展示形态迭代：气泡下折叠头 → 带当时好感/区间/关系的卡片（`059abfa`）→ 折叠头照内置思维链
  的样子（`e437f5a`）→ 气泡旁图标 + 底部面板（`4a24422`）
- 面板：玫瑰色底页（`b4cc6da`），区间、关系阶段、提示词、数值都能改（`cd830ce`），
  涨跌上限分开、允许小数（`9358a69`），去掉预设关系列表、加「关系变化时TA自己改」开关（`48b28dd`），
  关系由角色按人设自己定、不再默认「刚认识」（`01c5444`），可锁定角色在线状态（`6ad0ec7`）
- 结果写变量池 `affection` 供「挂念」读；面板反过来显示挂念写的 `presence` 快照
- `1.5.1`（`3013578`）：模型漏写 `[/内心]`、写成【内心】或干脆不打标记时也能截掉，不再漏进正文

## T. 官方插件「在线状态」与「朋友圈节奏」（2026-09-02 ~ 09-03）

- **在线状态**：先做在宿主里——列表头像点变色、聊天页标题下一行小字（`e940f9d`）、
  按宿主里的作息实时算而不等 APP 同步（`f56b91b`）、挂念的此刻快照带 `busy` 标记（`d24e120` / `f2e9dc3`）。
  `833b511` 整个挪进 `chat-plugins/presence-status.js`，宿主只留 `chat.presence` / `list.avatar`
  两个坑位加 `lib/character-presence.ts`
- **朋友圈节奏**（`e1c25b4`）：`chat-plugins/moments-rhythm.js`，宿主在 `lib/moments-engine.ts` /
  `moments-storage.ts` 上开 `moments.beforePost` / `moments.schedule` 钩子。
  插件每小时按作息、精力、当天的事掷骰子决定发不发，**不再到点必发**
- 顺带：导入 PNG 角色卡时压缩头像（`833b511`）

## U. 押后被动回复（2026-09-01）

`lib/chat-reply-gate.ts`（新）+ SDK `AiPhone.chat.setReplyGate`（权限 `chat.context`）：
自定义 APP 可以按角色作息把被动回复押后——睡着押到醒来，忙着偷空再回（`e8ce793`）。
到点由桌面壳触发，聊天室没开也照样后台生成，不必守着聊天窗（`f3482ce`）。

## V. 「挂念」0.8.2 → 0.9.7（2026-09-01 ~ 09-03）

- `0.8.2`–`0.8.6`：到点补状态、自发起念、哨兵预约、睡眠窗、精力公式修正、日程带地点与好感联动、
  此刻快照写变量池、页签吸顶、心动时刻不卡整点（锚点与等待分钟数在区间里随机）
- `0.9.0`（`7aa6f27`）：**云端生成TA的一天**。宿主新增 `push.freeze`——把与 `ai.generate` 同源的
  提示词请求冻成 `kind=template` 的 `push_jobs`，不到点发送，只给云函数换占位符后调用。
  同时修掉网关 `recheck-plan` 的 context 白名单停在 0.5.0 的 bug（`sentinelWakeId`/`day`/`affection`/
  门禁等全在入口被丢掉，云端复核一直半瞎跑）
- `0.9.1`（`e9080a4`）：**可以同时挂念几个人**。运行时状态从「当前角色」一份改成按角色的字典
  （`ctxOf` / `cur` / `allCx`），面板只读 `cur()`，后台循环按人轮着跑；`apiDailyCap` 所有人合计的日调用上限
- `0.9.2`（`03763d4`）：**schema 6** — `push_api_usage`（rpc `ai_phone_usage_add` 原子累加）、
  `push_api_limits`；网关加 `usage` 动作；push-generate / push-recheck 调用前查预算、调用后记账。
  宿主侧：自定义 APP 的调用在用量统计里来源记为 `custom_app:<appId>`
- `0.9.3`–`0.9.6`：日程详情「这条日程已经不在了」、零点后按昨天作息撑到今天生成、
  重排时按会话 id 撤掉云端残留的旧预约、整体 review 三批修复
- `0.9.7`（`a64bb98`）：**设备锁**。电脑和手机同时开着会各自编排、挂出两套 `push_jobs`，到点发两遍扣两份额度。
  锁记在当天云端计划行的 `context.owner` 里，粒度就是「角色 + 日期」那一行，零点自然释放；
  网关加 `ownerOnly` 分支只 PATCH 锁不动 items/decisions；云端用量本机行改成 `app-<设备id>`，两台不再互相覆盖
- 宿主配套：`18ba1b6` 自动续冻模板（kv `custom_app_templates_v1`，角色每次回复后按角色去抖 3 分钟重冻，
  否则模板烤着旧记忆要等 APP 再被打开才更新）；`2807cf5` 聊天镜像跟着本地变
  （`lib/chat-storage.ts` 新增 `CHAT_MESSAGE_EDITED_EVENT`，镜像客户端多听 deleted / edited / batch-replaced；
  网关 `chat-mirror` POST 改 merge-duplicates，`deleted:true` 的按 id 删。否则云端起念会看到已删的句子）

## W. 「用量」自定义 APP（`custom-apps/usage-dashboard/`，2.2.0 → 2.8.1，2026-09-03）

**不进构建**——和挂念一样是打成 zip 在 APP 市场手动装的，zip 放在 `/root/vibe-coding/gua-nian-releases/`。
仓库里这份是正本，改完要重打 zip 才到得了手机。

- **宿主打底**（`00e0f7a`，先于 APP 进仓库）：四条请求路径（流式 / 非流式 / 工具流 / 工具非流）
  原来都在写日志前就抛异常，**报错的调用在日志和用量里完全消失**；改为在 catch 里补一条 failed 记录，
  `simpleLLMCall` 的空回复同样标记失败（token 照记，空回复也计费）。
  `apiLogChannelFor` 不再把所有 appId 压成 `"chat"`，`source` 保留原始 appId，
  小红书/朋友圈/群聊/查手机才分得开；`ApiUsageBucket` 加 `failedCalls` 与 `calls` 分开统计
- `2.2.0`（`d2e3fcf`）进仓库：来源细分到各 APP、失败调用单独统计，`usage.readLogs` 补 `failed` 与 `failedOnly`。
  同时**撤回**宿主自带日志面板的分页与筛选改动（`95f8cb7`）——和这个 APP 的日志页重复
- `2.3.0`（`10413ab`）：来源名改由宿主下发（`lib/usage-source-names.ts`），APP 不再自带 id→名字 映射表，
  新增内置 APP 或用户装了自定义 APP 都能自动跟上
- `2.4.0`–`2.7.1`：日志每页 20 条上下翻页、筛选收进浮层、天数选择挪进顶栏、
  天数改「今日/7天/30天」默认今日且跨 0 点自动刷新、筛选计数改按日志算并合并同名角色
- `2.8.0`（`0cbbeb9`）：**日志保留条数可调**（50/150/300/500）。宿主 `api-log-store` 的 150 改成存 kv 的配置，
  序列化预算按条数等比放大；调小立刻裁掉超出的旧日志；新权限 `usage.settings` 配
  `usage.getSettings` / `usage.setSettings`；`readLogs` 的 limit 上限跟着容量走（原来写死 200，容量 500 时翻不到底）。
  **加新权限记得同时补 `lib/custom-app-permission-labels.ts` 的中文名**，否则权限页显示裸 id
- `2.8.1`（`5b11bd9`）：代码审查查出的 8 处修复 + 设置页显示日志实际占用（宿主 `getApiLogStorageChars()`
  → `usage.getSettings` 的 `logChars`）。其中两处值得记住：
  APP 里 `AiPhone.usage.xxx` 必须先判 `AiPhone.usage` 本身存在，否则老宿主上整页白屏；
  `usage.readLogs` 不能逐条 `resolveUsageSourceName`，那会把整个已装 APP 大对象解析 N 次
- 合 upstream `9b231cf`（预算 2MB→8MB）时把两边意图并起来：每条份额按 8MB/150 算
  （特调一次调用带整段历史，单条逼近 100K，份额小了会把小记录全挤掉），
  总量仍封在 8MB——每次 push 都要把整环 parse/stringify 一遍，容量 500 时不能真让预算翻到 26MB

## X. 宿主杂项修复（2026-09-02 ~ 09-03）

- `e5eed3d` 修 Anthropic 反代与应用默认 API 绑定（`lib/api-helpers.ts` + `shopping-engine` / `xiaohongshu-engine` 各自的取值口径）
- `f5fce49` 绑定管理（`components/settings/binding-manager.tsx`）：全局页新增「App Defaults」应用格子，可按应用设默认绑定给所有角色共用
  （数据层的 `appDefaults` 早就有、解析时也读，就是没有编辑入口）。解析顺序不变
- `e621ec1` 记忆库（`lib/memory-storage.ts`、`components/memory/memory-bank-page.tsx`）：删掉长期记忆条目后，
  总结进度退回剩余条目的最晚时间，下次能重新总结那段
- `04fc394` 小卷（`lib/mascot-tools.ts`）加预设条目不再打乱用户拖出来的顺序——和 B.4 是同一条纪律，**写 `prompt_order` 必须走 `buildDisplayedPrompts`**
- `166cbab` 桌面：拖拽与翻页期间停掉实时模糊，几何只算一次
- `44088b2` 沙盒 APP 注入样式补齐 `styles/base.css` 的四项全局保护（橡皮筋回弹露白底、
  双击/捏合缩放、滚动条、body 默认 8px 外边距）——iframe 是独立文档，宿主的 base.css 进不去
- `630f57e` 把版本号升到 1.0.0，当天 `4fc35cd` 回滚了

## Y. 自定义 APP 替角色发朋友圈 `AiPhone.moments.post`（2026-09-04）

挂念 0.9.9 要「浏览器关着也发朋友圈」。朋友圈整条链路（5 秒轮询、IndexedDB 帖子）都在前台，
云端发不了帖，所以分成两半：云端只记「起意 + 时间点」，前台打开时由宿主补成当时的帖子。

- 新权限 `moments.write`（`lib/custom-app-types.ts` / `custom-app-storage.ts` 白名单 / `custom-app-permission-labels.ts` 中文名）
- 新动作 `moments.post({ characterId, hint, createdAt })`：`lib/custom-app-host-api.ts` `postCustomAppMoment` → `lib/moments-engine.ts` `postMomentForCharacter`，
  走和定时发帖一样的 `triggerAIPost`（人设、记忆、去重、配图、NPC 互动），**不过** `moments.beforePost` 钩子——念头已经在 APP 那边定了
- `lib/moments-storage.ts` `addMomentPost` 接受 `createdAt` 回填过去的时间并保持倒序；`updateScheduleAfterPost` 的 `lastPostTime` 取较大者
- SDK 外壳与一致性脚本（`scripts/check-custom-app-sdk-consistency.mjs`）补 `moments` / `variables` 命名空间，制作说明加了一节
- `chat-plugins/moments-rhythm.js` 1.0.0：变量池里有挂念写的 `moments`（3 天内）就让位，避免两颗骰子各发各的
- 合 upstream 时清掉「状态栏补写」提示的残留（`components/mixology/mixology-game.tsx`）：
  上游 `9cd4fd6` 移除了补写请求、`60b0122` Revert 了 `mix.draft`，但 `MIX_REPAIR_EVENT` /
  `MixRepairEventDetail` 的 import 和那个 toast 留在了组件里，指向 engine 里已经没有的导出。
  他们 `ignoreBuildErrors: true` 所以没炸；我们跑 tsc 会报，删掉

## Z. 挂念起念改造与审查修补（2026-09-04 ~ 09-05）

`57d9870` 自发起念从三种由头拆成五种（惦记到点 / 刚忙完 / 想念 / 余韵 / 安静太久），各有提示词口径与门槛，
参考 AstrBot 私人陪伴插件的 `open_loop_followup / memory_echo / absence_miss`：

- 想念：断 `missDays`（默认 3）～21 天，每段断联白天只掷一次（56%）；余韵：每天掷一次（24%），把昨天的对话喂给模型；
  TA 主动发了没回音时（最后一句是 TA 的，且晚于用户上一句半小时以上或对得上今天某个时刻）后三种一律不追
- 由头分量：三分值 × 各自时间曲线（约定靠近到点涨、刚忙完 3 小时掉光、想念随天数涨、安静太久平）× 回音率；
  额度剩 2 / 1 个时按 0.45 / 0.65 卡槛。回音账 `context.fb`（按 `items.kind` 归类）由云端从镜像回填：
  到点 3 小时后 TA 真开过口才算「发过」，用户 3 小时内接话算「回了」；App 存 `settings.fbState`，诊断页「念头的回音」卡
- 词表了结：用户说「好了 / 算了 / 不用了…」撞词了结约定或话头（日子不碰），带否定前缀、问句、长句、多条撞词四道防误触
- `a8ac6eb` 宿主回复门：「触发回复」按钮和「收起键盘后自动回复」也过睡着 / 忙着判定（`components/chat/chat-room.tsx`）

审查修补（GPT 审查报告六项，全部属实）：
1. 随用随判早上寄空计划时云端没时间基准直接退出 → `push-recheck` 用 App 寄的 `day.tz` 造一个「此刻」当基准
2. `settleFired` 到点就算「说完了」 → App 查聊天记录、云端查镜像，到点后 TA 真说了才推进账本；6 小时没见到就放弃
3. 设备锁空行时两台都拿到 true → 网关先建空行，再按「没人占 / 还是我」条件 PATCH（`or=(context->>owner.is.null,...in.("",me))`），
   写不进回 `taken` 给 App 停手；接管走 `force`
4. 云端裁决先清后存 → App 先存本地再回执，回执带 `before`，网关只清 `at <= before` 的那批
5. 云端生成无视随用随判 → `generateCloudDay` 在该模式下不调起念模板
6. 已押后时紧急词失效 → `isUrgentReplyText` 先判，命中越过已有等待
