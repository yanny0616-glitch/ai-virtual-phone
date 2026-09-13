# Fork 改动总览

相对 upstream `xiaolongbao0709/ai-virtual-phone` 的**当前状态**：这个 fork 现在多了什么、各自在哪、有哪些必须遵守的纪律。
只写现状，不写过程。逐次改动的细节（日期、提交号、验证脚本、当时的发布状态）在 [fork-changelog.md](fork-changelog.md)。

> 改了功能：先在这里把对应小节改成新现状，再往 changelog 追加一段。两份都要动。
> 部署链路、构建纪律在仓库外的 `/root/vibe-coding/float/CLAUDE.md`。

## 1. 部署基础设施（upstream 没有，纯自建）

| 文件 | 作用 |
| --- | --- |
| `.github/workflows/float-release.yml` | `npm ci → check:push / check:apps-dist / check:sdk → build → 打包 standalone → gh release create float-build-<sha12>`，只留最近 3 个 release。副本不同步就不发版 |
| `ops/float-deploy.sh` / `.service` / `.timer` | 每 5 分钟拉最新 release：校验 tag + sha256 → 解压 → 切软链 → 重启 → 健康检查 → 失败回滚。服务器上只保留当前 + 2 个回滚版本，`--prune-only` 可单独清理 |
| `ops/float-ai-phone.service` | 生产服务单元 |
| `next.config.mjs` | `output: "standalone"`；`ignoreBuildErrors: true`（TS 报错不挡构建，本地要自己跑 `tsc --noEmit`） |
| `scripts/check-float-release-retention.py` | 清理逻辑的专项验证 |

`NEXT_PUBLIC_*` 是构建时内联的，写服务器 `.env.local` 不生效，要改 `float-release.yml`。

## 2. 角色卡与预设

- **SillyTavern 角色卡导入**（`lib/character-storage.ts`、`lib/character-world-book.ts`）：V1/V2/V3 都认，只取核心人设，greeting / scenario / 示例对话丢弃。卡内 `character_book` 解析后挂在角色上，详情页「导入世界书」才写库并绑定，导出时按原形状带回。PNG 读取顺序 `ccv3 → chara → ai_phone_character`，tEXt 块有 8MB 长度校验。
- **预设顺序纪律**（`components/settings/preset-manager.tsx`）：拖动只写 `prompt_order`，`preset.prompts` 保持原序。**任何写 `prompt_order` 的地方必须走 `buildDisplayedPrompts`**，否则新建/导入一条就把用户拖好的顺序打回去。
- **内置预设补丁号**（`lib/builtin-preset.ts`）：`BUILTIN_PRESET_VERSION` 升了会整份重写用户副本，非必要不升。加新出厂条目走 `BUILTIN_PROMPT_PATCH_VERSION` + `PATCHABLE_PROMPT_IDS`，只追加不改。用户自建预设不受补丁影响，预设详情页有「一键补齐功能条目」手动补。
- 正则新增 `historyRole`（仅用户 / 仅角色）；`buildProviderRequest` 发请求前剔除空白纯文本消息。
- 角色卡人设在详情页默认折叠。

- **陪眠 0.3.3**：渐弱按最多 20 秒分段，失败兜底停背景音；每次入睡独立校验生成/TTS/STT 返回，停止和绝对截止时间阻止旧任务续播；定时同时停止人声及环境音。SDK 新增 `voice.stopSTT({requestId, cancel?})`，沿用语音识别权限，用于松手结束识别和取消丢弃文本。宿主播放在读取媒体前登记通道序号，取消/替换后的迟到结果不会开播或误停新播放；试一句离页、换角色和正式入睡时取消，冻结角色并等待音频清理。同晚夜记按日期复用并累计睡眠区间；清空重建设置、分批删完记录并隔离迟到回写；异步下载完成后重新校验入层唯一性与六层上限。需同步更新宿主及陪眠 APP。

## 3. 提示词与请求管线

- **云端回复思维链折叠**：普通回传和现实桥回传在输出正则、拆气泡前按线上标签提取思考，保存 `reasoningText` 供原有折叠入口显示。新回复兜底/追问/主动预约冻结开关和标签，旧回传回退到会话当前绑定预设；显式关闭保持原行为。挂念云端已剥离的思考通过回传 metadata 保留。

- **挂念云端思考解析**：预约冻结线上思考开关和标签；发送前剥离思考块，再判断作罢。旧预约兼容标准 thinking / think / thought 标签。作罢记为任务完成但未发送，不写 outbox；标签不完整或仅有思考时失败结束，不交付分析。

- **提示缓存**（`lib/llm-provider-adapter.ts`）：Anthropic 打 `cache_control` 在 tools → system → 最后一个 message；OpenAI 用 `prompt_cache_key`；Gemini 原生带。开关在 API 配置逐条和工坊两处。已知问题：某些严格中转不认 `cache_control` 报 500，撞上就关那条配置的缓存。
- **`system` 只挂一个缓存断点**：任何逐轮变动的文本必须排在 `shortTermMemory` 之后，否则整段人设/世界书每轮重新计费。`{{customAppContext}}` 条目默认在 `prompt_order` 最末就是这个原因。
- **用量统计**：`LlmUsage` 拉平三家字段，缓存命中与写入分开记；按 `characterId` 分桶，后台功能退化为 `name:<功能名>`；自定义 APP 调用来源记 `custom_app:<appId>`。加新 `*-engine.ts` 时 `callLLM` 别漏传 `characterId`。四条请求路径失败时都补一条 failed 日志。日志保留条数可调（50–500），总预算封在 8MB。
- **沉默协议**：首行 `[本轮不回复]`，其余状态/内心/更新照常输出，保存为 `silentUpdate` 隐藏记录，不生成气泡、不通知、不追问。前台、后台、流式、原生工具、个人云全通。
- **语音表达**（`docs/voice-expression.md`）：`{{voiceExpression}}` 宏展开进语音条和单人通话；MiniMax 19 个声音标签，按语境使用；语音 API 配置里有独立开关。
- **世界书生效范围**：书级 `mode`（全部 / 仅线上 / 仅线下，只收窄不放宽）+ 条目级 `tags`（语义同预设条目的 `tags`，全部 ⊆ 当前 `appTags` 才生效，空 = 通用）。过滤在 `llm-prompt-assembler` 三处激活循环里做，单聊/群聊/提示词查看器共用一条路径。条目面板的「适用场景」二级选择器随书级 mode 收窄（仅线上藏掉线下小类，仅线下只剩通用 + 两个线下小类）；被收窄挡住的条目列表上标「与生效范围冲突」，生成时跳过。导入/导出 JSON 原样带这两个字段；酒馆卡、角色卡内世界书、mascot、自定义 APP API 不写即通用，零迁移。
- 提示词查看器：认 Anthropic 缓存格式的 `system` 数组；显示插件 `llm.request` 变换后的实际内容；标签折叠。
- 「重试以下」显式传生成意图，不再误判为空输入续写。
- 日记「过往日记」上下文在引擎里按角色收窄：调用方传整张日记表也不会把别的角色的日记喂进去，查看器预览与真实请求一致。

## 4. 聊天插件体系

方向：**宿主只留钩子和 UI 坑位，规则进官方插件**。改行为先看现有钩子够不够，不够再在宿主开坑位。

- 官方插件在 `chat-plugins/`，构建时复制到 `public/chat-plugins/` 并生成 `index.json`（`npm run plugins:build-dist`）；`lib/chat-plugin-official.ts` 是清单，已装的启动时静默升级。
- 钩子（`lib/chat-plugin-types.ts`）：`app.ready` `plugins.changed` `session.opened` `user.beforeSend` `prompt.system` `llm.request` `llm.streamChunk` `llm.response` `message.beforePersist` `message.persisted` `message.beforeReveal` `message.updated` `message.deleted` `chat.read` `chat.write` `chat.replyGate` `moments.beforePost` `moments.schedule` `variables.changed`。
- UI 坑位：`chat.header` `chat.presence` `chat.inputToolbar` `message.side` `message.footer` `message.panel` `list.avatar` `settings.section`。
- **共享变量池**：插件 `ctx.data.variables` 与自定义 APP `AiPhone.variables.*` 读写同一个池。
- **忙碌回复状态提示**：使用中文摘要，仅读取当前状态、活动/进展、地点、心情、精力、下一安排、有效手动状态；不再读取好感与关系变量。当前关系、好感分数、同步元数据、内部 ID、好感/关系历史不进入这段提示，存储及面板不受影响。
- 离线回传（`lib/push-outbox-client.ts`）也跑 `llm.response` → 输出正则 → 消息解析，固定批次 ID 防重复结算。

| 插件 | 版本 | 做什么 |
| --- | --- | --- |
| `affection-ledger` | 1.6.1 | `[内心]` 里带好感变化量和关系转折，累加、每日封顶、闲置回落；气泡旁爱心 + 便利贴卡片；写变量池 `affection` |
| `presence-status` | 1.0.1 | 列表头像点 + 聊天页标题下小字，按作息实时算，手动覆盖优先 |
| `busy-reply` | 1.1.1 | 被动回复的等待、概率偷空、睡眠、紧急优先；「允许角色选择不回复」默认开 |
| `moments-rhythm` | 1.0.0 | 每小时按作息/精力掷骰决定发不发朋友圈，不再到点必发 |
| `typing-rhythm` | 1.0.0 | `message.beforeReveal` 控制多气泡显示节奏 |
| `profile-signature` | 1.0.0 | 朋友圈个人主页个性签名 |

## 5. 自定义 APP SDK 扩展

宿主给 APP 开的能力（`lib/custom-app-host-api.ts`、派发在 `components/app-market/custom-app-runner.tsx`）。**加新权限要同时补 `lib/custom-app-permission-labels.ts` 的中文名**；改了 SDK 跑 `npm run check:sdk`。

| 权限 | 动作 | 用途 |
| --- | --- | --- |
| `push.wake` | `push.wake / listWakes / cancelWake` | 定时唤醒离线推送；1 分钟～7 天、每 APP 24 条、拒绝群聊；可带 `cooldownRounds` |
| `push.freeze` | — | 把与 `ai.generate` 同源的请求冻成 `kind=template` 的 push_jobs，云端到点换占位符调用；角色回复后自动续冻（去抖 3 分钟） |
| `chat.context` | `chat.setContext / clearContext`、`chat.setReplyGate`、`variables.*`、`chat.registerContextProvider` | 往聊天提示词注入 `<app_context>` 块（按 `appId × characterId`，撤权即停）；押后被动回复；当轮同步召回（默认 2000ms 超时） |
| `usage.read` / `usage.logs` / `usage.settings` | `usage.readDaily / readLogs / readLogDetail / getSettings / setSettings` | 用量元信息 / 日志原文（单独申请）/ 保留条数 |
| `bridge.send` / `bridge.read` | — | 现实桥（上游 9e7feb8 补进白名单） |
| — | `AiPhone.moments.post` | 替角色发朋友圈；云端只记「起意 + 时间点」，前台打开时补成帖子 |
| — | `memory.readShiguang` | 只读拾光记忆 |

后台动作：`chat.setContext` / `chat.clearContext` 可由 `tasks.schedule` 在 APP 关着时刷新。
沙盒 iframe 注入 `styles/base.css` 的四项全局保护（橡皮筋、缩放、滚动条、body 外边距）。

## 6. 个人云后端（用户自己的 Supabase）

正本 `docs/personal-push-supabase.sql`（当前 **schema 12**）、`supabase/functions/{ai-phone-push,push-generate,push-recheck,push-bridge,push-shortcut-result}`；公开副本 `public/ai-phone-push/*.mjs` 由 `npm run push:build-dist` 生成，`check:push` 校验字节一致。用户改完要在「设置 → 云服务部署」重新部署。

- **部署包代号** `lib/personal-push-version.ts`：`push:build-dist` 对六个云函数 + schema 做摘要，内容变了代号自动 +1 并内联进网关（`// BEGIN PERSONAL PUSH VERSION` 块），health 回报 `functionsVersion`。宿主启动和进「云服务部署」页时比对，落后就提示重新部署（每个代号只弹一次桌面提示，设置页常驻黄色卡片）。Access Token 仍要用户粘贴，这一步省不掉。**不要手改代号**，改完云函数跑一次 `push:build-dist` 即可。

- **聊天镜像** `push_chat_mirror`：新消息抄送云端（仅单聊、截 4000 字、60 天保留），本地 IndexedDB 仍是唯一事实来源；跟着本地编辑/删除同步；支持整轮批次快照。
- **降速** `cooldownRounds`：到点先查镜像 + 已代发 outbox，用户连续 N 轮没回就取消生成。
- **复核门禁**（`push-recheck`）：日上限 / 间隔 / 时间窗 / 刚说完等待 / 最少句数五道门，阈值由 APP 上传的 `context.gate*` 覆盖，全过才花钱。
- **发送前复核**（`push-generate`）：未回应占比 40% + 贴近上一句用户 40% + 贴近上一条主动 20% 合成 `press`，超 `presendMax` 不发，判据写回 `decisions`。
- **到点补上下文**：触发时查快照冻结后已代发的 outbox 追加备忘，不建新表。
- **用量与预算** `push_api_usage` / `push_api_limits`（rpc `ai_phone_usage_add`），云函数调用前查、调用后记。
- **设备锁**：`context.owner` + 任期号 `ownerSeq`，两台设备不重复编排；409 `taken` 停手。
- **延后回复上云** `deferred-reply` 动作：等待期间关掉手机也能偷空回。
- 回箱按确切批次去重；回复沿用云端 `created_at`；前台每 20 秒查回箱。
- 推送通知带 `characterId`，SW 用缓存头像当 icon；iOS 主屏 Web App 忽略自定义 icon（WebKit 280162 未解决）。
- Supabase 新版 `sb_secret_*` 密钥只作 `apikey` 头发送（`lib/server/supabase-rest.ts`、云备份两处）。

## 7. 自定义 APP（ZIP 首次安装，随宿主发布提供一键升级）

挂念诊断区分当前角色消息、后台模板、历史及其他角色，计数仅针对本次查询；旧模板和零降速阈值不再误报，支持刷新，网关只暴露白名单诊断信息。 2026-09-10 起诊断页固定为状态/记录/工具三张卡，云端同步与发送记录并入其中，展开体统一为行 + 说明 + 按钮。

挂念惦记账本按已有 ID 更新话头/日子，保留关联；无 ID 时按同类规范化文字判重，近期已了结事项供模型参考但不自动恢复。已有重复记录不自动合并。

官方 `/custom-apps/` 安装包无需登录即可下载，目录及 ZIP 响应禁止缓存；更新请求携带版本号并校验包内版本，避免误取首页或旧包。

zip 放 `/root/vibe-coding/float/releases/<app>/`，旧版不删。挂念和拾光源码在 `src/` 分文件，`scripts/build-<app>.mjs` 合成单 HTML + 打 zip。

**随宿主自动升级**：`scripts/build-custom-apps-dist.mjs` 把四个目录打成 `public/custom-apps/<目录名>.zip` + `index.json`（打包口径统一在 `scripts/lib/custom-app-package.mjs`，文件时间固定，内容不变字节不变，已进 `npm run build`）。宿主 `lib/custom-app-official.ts` 按 `manifest.id` 对照 index：启动巡检一次、打开 APP 时再查一次，落后就复用市场更新那个弹窗提示「立即更新」，本机运行时 id、数据、设置原地保留。用户不再需要下载 zip 手动导入；`releases/` 里的 zip 只剩给没装过的人首次安装用。

| APP | 版本 | 做什么 | 说明文档 |
| --- | --- | --- | --- |
| 挂念 `gua-nian` | 0.9.33 | 生成角色一天 → 心动时刻 → 云端复核 → 定时主动消息；精力/情绪衰减模型；约定账本；可同时挂念多人；信息页按日程自动同步在线状态 | `custom-apps/gua-nian/ARCHITECTURE.md`、`docs/gua-nian-*.md`、`docs/archive/gua-nian/` |
| 拾光 `shiguang` | 2.1.1 | 重要记忆：每 20 轮整理、关键词三档召回、当轮同步注入。宿主侧原管线已删，只留只读接口 | `custom-apps/shiguang/ARCHITECTURE.md` |
| 用量 `usage-dashboard` | 2.8.1 | 按角色/来源看 token 与缓存、日志分页筛选、保留条数设置。来源名由宿主 `lib/usage-source-names.ts` 下发 | — |
| `online-plaza` | 1.1.0 | 上游原有 | — |

## 8. 宿主功能与修补

- **角色可见范围**（`lib/character-visibility.ts`，设置 → 数据与规则 → 角色可见范围）：全局默认 + 按功能覆盖，按标签或点名隐藏角色。自定义 APP 在 SDK `characters.list` 处按 `custom_app:<manifest.id>` 统一过滤，APP 不用改。**宿主功能的角色选择器一律用 `loadVisibleCharacters("<功能id>")`**，并把功能加进 `CHARACTER_VISIBILITY_HOST_FEATURES`；聊天、联系人不过滤。目前接入：查手机、栖所。
- **查手机批量生成**（`lib/checkphone-batch.ts`）：桌面右上角「批量」按钮，勾选桌面上的 APP 后按顺序生成快照（并发 2），默认只勾未生成的；走 refresh-tracker，正开着的页面同步转圈并自动刷新。
- **栖所批量探索**（`components/dwelling/dwelling-app.tsx`）：每个房间页签栏多一个「批量探索」，底部弹窗按家具分组勾选物品（默认未探索的），并发 2 生成并落盘，不打开详情；失败逐条显示原因，可中途停止。
- **查手机**（`lib/checkphone-engine.ts`）：带时区时间戳按设备本地格式化；六个查询工具按 2000 字符预算报未展示条数；会话匹配原名/备注/微信号优先，多候选先返回列表；历史排除 `silentUpdate`；读库失败与空列表区分。
- **小卷**（`docs/mascot-editing.md`）：统一读取 → 准备草稿 → 预览 → 应用 → 记录 → 撤销管线，版本冲突拒绝覆盖；桌面/DIY/角色/主题都走它；DIY 沙箱接音乐控制；工具循环 8 轮上限、原生与文本调用去重。
- **冒险**（`docs/adventure-*.md`）：四时段游戏时钟由 `time_update` 推进；世界设定 AI 编辑预览后应用；可选自定义状态字段。
- **网易云音乐**：`ncm-api` 容器挂在同域 `/ncm`，Caddy 侧 `strip_prefix`；默认地址由 `NEXT_PUBLIC_DEFAULT_NETEASE_API_BASE` 在 CI 里给。
- **安全**：`lib/server/safe-outbound-fetch.ts` 所有出站请求校验目标 IP 防 SSRF，Undici 统一；`story-html-renderer.tsx` 渲染前清洗。
- **聊天头像**（聊天设置 → 聊天头像）：单聊可单独设一张「微信里的头像」：聊天页、会话列表、通讯录、朋友圈、通话页、通知都用它（走 `loadWeixinCharacters()`），角色 APP 仍显示角色卡原图。选图后先在圆形取景框里拖动/捏合裁剪（`components/ui/avatar-crop-dialog.tsx`，可复用），存 `session.chatAvatar`（320px webp data URL），可一键恢复。
- 绑定管理有「App Defaults」入口；记忆库删长期记忆后总结进度回退；会话列表未读角标；桌面拖拽翻页优化；朋友圈动态回写照片标签按真实模式。
- **自用放开的入口**：便签墙（日记内，`NOTE_WALL_UI_ENABLED`）；黑市可搜「黑市」/「black market」或点购物首页底部灰字进入。这些联网功能的表用 `docs/supabase-all-in-one.sql` 一次建齐。
- 日历「暖桃」主题已移除，`LEGACY_THEME_MAP` 有 `peach → cream`。**以后删主题往这张表补一条**。

## 9. 一致性校验与回归脚本

| 命令 | 校验什么 |
| --- | --- |
| `npm run check:push` | 云函数源码 ↔ `public/ai-phone-push/*.mjs` ↔ schema 副本字节一致；部署包代号与内容摘要一致 |
| `npm run check:apps-dist` | `public/custom-apps/*.zip` + `index.json` 与 `custom-apps/` 源码一致 |
| `npm run check:sdk` | 自定义 APP SDK / 派发 / 权限 / 文档四处一致 |
| `npm run check:weixin` | 微信助手提示词等价 |
| `npm run gua-nian:test` / `check:shiguang-app` | 两个 APP 的领域层 + 产物一致 |
| `npm run check:chat-silence` / `check:reply-delivery` / `check:cloud-messages` | 沉默、回复投递、云端消息链路 |
| `node scripts/check-fork-regressions.mjs` | fork 回归总集（40+ 项） |
| `node scripts/check-<feature>.mjs` | 其余 60 来个单项脚本，各自的名字见 `scripts/`，changelog 每段末尾写了对应哪个 |

目前没有一条命令跑全部；CI 只跑 `check:push` / `check:apps-dist` / `check:sdk`。`check-fork-regressions.mjs` 里「网关保留用户睡眠设置」一项在 2026-09-10 已知失败（recheck-plan 返回 409，设备锁改动后测试没跟上），不是新问题。

## 0.9.35：重新生成不再锁住挂念旧日程

本地整天生成与云端生成原料使用 `fixedCalendarItems` 排除 ID 以 `guanian_` 开头的挂念写回条目，避免旧产物成为必须原样保留的约束或在模型漏写时被补回。其他来源的日历安排继续保留；聊天与惦记仍参与模型判断，因此重新生成不保证所有内容不同。日历同步继续读取完整旧列表，以清理并替换挂念自己的旧条目。

随宿主发布后，已安装用户打开挂念点击「立即更新」升级至 0.9.35，再重新生成即可生效；无需手动导入 ZIP，不自动改写已有日程。云端在下次上传生成原料后使用新筛选结果，无需更改云函数。专项检查：`node scripts/check-gua-nian-calendar-regeneration.mjs`；未做手机端完整实测。

## 预设页面填入保留排序与开关

补入上游 `1cd5c1b` 的页面填入修复：小卷通过 `mascot-fill-field` 修改预设条目时保留已有 `prompt_order` 及关闭状态；identifier 改名沿用原位置，新增项追加，失效/占位/重复顺序项剔除。底部直接创建、JSON 导入和小卷专用工具已有排序修复保持原样。专项验证：`node scripts/check-preset-page-fill-order.mjs`。

## 同步上游照片重试修复（2026-09-11）

合并上游至 `a4da07f`：照片重试支持选择角色参考图，未配置参考图时保留原标签；旧式自拍标签提供兜底，显式参考图选择优先；补充生成中断恢复及换图等待。预设重复修复沿用 fork 已有实现及本次页面填入修复；朋友圈继续使用微信专属头像。静态缓存版本升至 v37。

### 陪眠（`custom-apps/pei-mian/`）

睡前陪伴 APP：角色分段哄睡（越说越轻，TTS 用宿主语音配置）、多层白噪音在 APP 内混音后交宿主播放、夜记 + 周汇总 + 月历、三套主题。19 段 Freesound CC0 录音不随包发，首次点到时从 Freesound 直连下载 128k 立体声预览存进媒体库（包只有 50KB，可过市场 5MB 门槛），APP 内商店可再搜。混音 44.1k 立体声，下载音质可选（省流 64k / 高 128k）。浅色主题是纸面 + 白卡片的独立视觉，首页天体按系统时间切太阳/月亮；组合可钉住收纳，声音和组合长按看小字详情表。构建 `npm run pei-mian:build`，校验 `npm run check:pei-mian-app`。为此宿主打包脚本改成递归打目录、`guessMime` 补了音频类型。

挂念 0.9.37 在配置基本页提供日程提示词编辑按钮，通过独立底部弹窗编辑和恢复默认，所有角色共用。默认强调角色独立生活、共同活动需要明确约定及不预写用户行动；本地与云端 genKit 共用同一文本，动态日期/聊天资料和 JSON 协议自动补齐。保存不重排今天，云端待生成原料刷新后生效。

挂念 0.9.38 将设置/详情遮罩样式限定为原遮罩，提示词编辑遮罩只在编辑弹窗打开时显示，避免整个设置页被模糊和遮挡。

### 真实小红书链接读取（2026-09-13）

在角色单聊或群聊发送小红书 HTTPS 短链／笔记链接，保留原文字，并生成独立 `xhs_link`
分享卡。卡片提供封面、标题、正文摘要、作者、点赞／收藏／评论数、原链接跳转、逐张加载
进度和失败重试，长按使用现有消息删除菜单。与 Float 内置虚构小红书 APP 的分享类型分开。

同源服务端接口 `/api/xhs-card` 和 `/api/xhs-images` 随宿主部署到 VPS，无需角色电脑或额外
MCP 配置。以手机 UA 读取公开页面，安全解析 `__INITIAL_STATE__`，支持两种移动端数据路径；
只返回页面可获取的评论及回复，不承诺完整评论区。图片域名白名单、每跳 SSRF 校验、超时、
响应体上限和图片签名验证共同约束出站请求，不执行页面脚本、不使用小红书账号 Cookie。

配图存入本机媒体缓存，构建模型请求时转换成实际 base64 图片块，保留原序号；单聊／群聊、
普通／时间线历史均支持。每条笔记作为一组图片占一个最近图片名额，组内配图全部传入；
仍遵守角色 API 的「识图」开关及会话图片保留设置。读取未完成时阻止生成，部分失败会明确
告知模型哪些图不可见；刷新可恢复未完成读取，删除不会使后台任务重新创建消息。

每条消息最多 3 个不同链接，每篇最多 30 张配图；超过上限会明确报错。视频笔记仅处理正文
和封面，不提供视频／音频转写。遇到登录要求、失效链接或平台限制时保留原链接并显示失败。

专项验证：`node scripts/check-xhs-note.mjs --live`、`node scripts/check-xhs-note-client.mjs`、
`node scripts/check-xhs-note-browser.mjs`；真实笔记验证了 5 张配图、16 条可见评论／回复。
全仓 TypeScript 检查通过；未调用付费模型验证视觉描述质量，图片理解仍取决于角色所用模型。

### 小红书 MCP 搜索、阅读与角色分享（2026-09-13）

新增 Bearer 鉴权的 `/api/xhs-mcp`，提供固定三个工具：`search_xiaohongshu_notes` 搜索候选、
`read_xiaohongshu_note` 读取正文/评论/配图、`share_xiaohongshu_note` 在当前聊天分享卡片。
搜索复用 VPS 本机的 `xpzouying/xiaohongshu-mcp` 浏览器服务，需用户扫码登录；部署说明在仓库外
`../xhs-mcp/README.md`。原始浏览器服务只监听回环端口，对角色不暴露平台发布/评论/点赞接口。

MCP 采用可移植的标准工具协议，Float 专用结构化扩展决定界面呈现：阅读配图仅加入模型上下文，
分享时才生成一张 assistant `xhs_link` 卡，群聊保留执行角色身份。图片序号、部分失败和完整搜索
候选链接均保留；工具的 `isError` 作为失败处理。角色分享过的配图在后续请求中转换为带来源说明的
user 图片块，兼容 Anthropic 等不接受 assistant 图片输入的提供方。原生/文字工具循环均支持。

工具列表固定，扫码状态与搜索结果不会改变定义。鉴权密钥仅保存在运行时配置及用户的工具箱配置，
不提交仓库。专项检查：`node scripts/check-xhs-mcp.mjs`（协议、错误、只读/分享分离、单群聊图片历史）。

### 小红书评论图片与统一 MCP 读取（2026-09-13）

- 自动识别用户链接后直接向 `/api/xhs-mcp` 调用 `read_xiaohongshu_note`，与角色使用同一协议、工具和结果解析器；用户入口使用同源 Float 登录 Cookie，外部 MCP 保留独立 Bearer 鉴权。不需要模型先决定调用，且不重复生成分享卡片。旧 HTTP 读取接口仅保留兼容。
- 提取公开页面评论与楼中楼的 `pictures`，包括纯图片评论，优先原图地址；正文与评论附件共享图片管线，保留评论归属和失败位置。卡片分别显示正文图、评论图的已加载数。最多 30 张正文图、60 张总附件，图片总量仍受 MCP 24MB base64 上限约束；超过或被拦截明确标注。
- 外部资料明确说明“未读到评论图不等于原评论区没有图片”。不绕过登录、不补抓未公开的全部评论。旧卡片需要重新发送链接刷新内容。
- 验证：公开麻辣烫笔记、评论与纯图回复夹具、MCP 同源 Cookie/Bearer 鉴权、自动读取不重复卡片、删除与重试清理、单聊群聊多模态管线。

### 小红书工具箱统一配置与按需评论（2026-09-13）

聊天工具箱自动提供唯一小红书 MCP 条目（复用已有导入项和启用状态），本机服务使用同源登录，无需导入密钥。用户链接自动读取和角色调用共用该配置及 MCP 传输函数，停用后两边均不可调用。默认正文读取、分享不下载或附带评论图片；新增 `read_xiaohongshu_comments`，每批默认5条、最多10条，可用offset继续页面公开评论，返回明确的公开范围和下一位置。旧公开页面接口仅兼容保留。

### 小红书 Cookie 直连接口与账号状态（2026-09-13）

- 同一个小红书 MCP 增加登录状态、推荐流、用户主页、点赞/取消、收藏/取消、发表评论/回复和图文发布，共12项工具；搜索改走独立签名服务，正文与按需评论沿用已有公开读取。账号写操作明确要求用户授权，服务只在上游确认成功时报告成功。
- 工具箱小红书配置页增加服务端 Cookie 保存、替换、清除与状态检测。Cookie 不进入浏览器持久存储、配置导出或模型请求；管理接口只接受同源 Float 登录，不接受角色的 MCP Bearer 密钥。状态区分未配置、有效、无效/失效及检测失败，公开读取能力单独说明。
- VPS 签名服务独立在 `/root/vibe-coding/float/xhs-api-vps`，只监听127.0.0.1:18061。所提供移植包及其来源许可随该私有服务保留，不并入此仓库；Float 通过受鉴权HTTP调用。签名服务的出站请求复用本项目DNS固定与重定向检查，限制响应大小。
- 验证使用模拟账号响应，覆盖状态转换、Cookie不回显、各账号操作路由和参数校验；未提供有效Cookie前不能声称真实账号搜索或发布已跑通。

### MCP 参数、连续记录与海龟汤历史（2026-09-14）

- 共用 MCP 调用入口按 inputSchema 递归处理对象/数组：对JSON编码容器解析一次，缺失必需字段或错误容器类型在发送前指出路径，不猜测缺失参数。
- 聊天中连续 tool_notice 合为默认折叠的一组，普通回复和其他消息断开分组；展开查看原记录，多选模式仍逐条处理。
- 单聊、群聊及提示词预览共用历史去重：仅处理已知 play 返回格式，较旧结果去掉与顶层完全重复的当前问答日志和冗余创建时间，保留其他线索、回答与房间状态，最新结果原样保留。数据库原始记录不改写；不对任意MCP结果做猜测性删减。
