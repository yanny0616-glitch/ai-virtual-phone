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
- **只认流式的中转**：`simpleLLMCall` 非流式拿到 200 空正文时自动用流式重试一次（`readSimpleLLMStream`，复用 provider adapter 的增量解析），截断不重试；后台调用（总结、朋友圈、小剧场等 24 处）不再静默失败。
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
- UI 坑位：`chat.header` `chat.presence` `chat.inputToolbar` `message.side` `message.footer` `message.panel` `list.avatar` `settings.section` `chatInfo.section`，聊天之外另有 `float.panel`（手机壳里的悬浮小窗，宿主给标题栏 / 拖动 / 收起 / 位置记忆，见 `components/chat-plugin-float.tsx`）和 `app.panel`（任意 APP 页面底部浮层，props 带 `appId`）。插件在 App 启动时就全部加载，后台定时器和定时唤醒本来就不限于聊天页。
- 聊天信息页（`components/chat/chat-settings-panel.tsx`）除备注 / 查找 / TA 的电脑 / 群成员外按类折叠：聊天、生成、插件各一栏（`chatInfo.section`，插件在容器上写 `data-summary` 当摘要）、状态栏、外观、清理与删除；一次只展开一类，标题下一行是当前状态摘要。
- **共享变量池**：插件 `ctx.data.variables` 与自定义 APP `AiPhone.variables.*` 读写同一个池。
- **会话动作** `ctx.chat`：`requestReply` 让角色回一轮；`offline.get/set/turns` 切线下（聊天室听 `CHAT_OFFLINE_MODE_CHANGED_EVENT` 跟着切）、读线下记录；`scheduleWake/cancelWake` 复用宿主定时唤醒，App 关着走 timed_task 兜底。插件唤醒 id 以 `chat_plugin_` 开头，普通唤醒的「一会话一条」和 `clearTimedWakeSchedule` 都不动它们。`chat.header` 坑位带 `offlineMode`，切线下时重挂载。
- **忙碌回复状态提示**：使用中文摘要，仅读取当前状态、活动/进展、地点、心情、精力、下一安排、有效手动状态；不再读取好感与关系变量。当前关系、好感分数、同步元数据、内部 ID、好感/关系历史不进入这段提示，存储及面板不受影响。
- 离线回传（`lib/push-outbox-client.ts`）也跑 `llm.response` → 输出正则 → 消息解析，固定批次 ID 防重复结算。

| 插件 | 版本 | 做什么 |
| --- | --- | --- |
| `affection-ledger` | 1.6.1 | `[内心]` 里带好感变化量和关系转折，累加、每日封顶、闲置回落；气泡旁爱心 + 便利贴卡片；写变量池 `affection` |
| `presence-status` | 1.1.0 | 列表头像点 + 聊天页标题下小字，按作息实时算，手动覆盖优先；面板里编辑固定作息、查看 / 撤销 / 手动加今天的例外，分神画空心绿点 |
| `busy-reply` | 1.2.0 | 被动回复的等待、概率偷空、睡眠、紧急优先；「允许角色选择不回复」默认开；固定作息 › 今天的例外（剧情 `[作息:…]` 标记）› 挂念日程；分神短等待、连发 3 条拽过来；打电话接不接（睡着连打叫醒、专注拒接后回拨） |
| `moments-rhythm` | 1.0.0 | 每小时按作息/精力掷骰决定发不发朋友圈，不再到点必发 |
| `typing-rhythm` | 1.0.0 | `message.beforeReveal` 控制多气泡显示节奏 |
| `profile-signature` | 1.0.0 | 朋友圈个人主页个性签名 |
| `meetup` | 1.0.0 | 约见面：你约或TA主动约，TA按日程答应 / 改时间 / 推掉；到点推送，去赴约切线下，散场写一句回执；卡片票根 / 简约 / 信笺三种样式（类名 `mt-*`），角色可单独设 |

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
| 挂念 `gua-nian` | 0.9.40 | 生成角色一天（带到点揭晓的变数，照着固定作息排）→ 心动时刻 → 云端复核 → 定时主动消息；精力/情绪衰减模型；约定账本；可同时挂念多人；信息页按日程自动同步在线状态 | `custom-apps/gua-nian/ARCHITECTURE.md`、`docs/gua-nian-*.md`、`docs/archive/gua-nian/` |
| 拾光 `shiguang` | 2.1.1 | 重要记忆：每 20 轮整理、关键词三档召回、当轮同步注入。宿主侧原管线已删，只留只读接口 | `custom-apps/shiguang/ARCHITECTURE.md` |
| 用量 `usage-dashboard` | 2.8.1 | 按角色/来源看 token 与缓存、日志分页筛选、保留条数设置。来源名由宿主 `lib/usage-source-names.ts` 下发 | — |
| `online-plaza` | 1.1.0 | 上游原有 | — |

## 8. 宿主功能与修补

- **角色可见范围**（`lib/character-visibility.ts`，设置 → 数据与规则 → 角色可见范围）：全局默认 + 按功能覆盖，按标签或点名隐藏角色。自定义 APP 在 SDK `characters.list` 处按 `custom_app:<manifest.id>` 统一过滤，APP 不用改。**宿主功能的角色选择器一律用 `loadVisibleCharacters("<功能id>")`**，并把功能加进 `CHARACTER_VISIBILITY_HOST_FEATURES`；聊天、联系人不过滤。目前接入：查手机、栖所。
- **查手机批量生成**（`lib/checkphone-batch.ts`）：桌面右上角「批量」按钮，勾选桌面上的 APP 后按顺序生成快照（并发 2），默认只勾未生成的；走 refresh-tracker，正开着的页面同步转圈并自动刷新。
- **栖所批量探索**（`components/dwelling/dwelling-app.tsx`）：每个房间页签栏多一个「批量探索」，底部弹窗按家具分组勾选物品（默认未探索的），并发 2 生成并落盘，不打开详情；失败逐条显示原因，可中途停止。
- **查手机**（`lib/checkphone-engine.ts`）：带时区时间戳按设备本地格式化；六个查询工具按 2000 字符预算报未展示条数；会话匹配原名/备注/微信号优先，多候选先返回列表；历史排除 `silentUpdate`；读库失败与空列表区分。
- **组件可填字段**（`lib/widget-fields.ts`）：代码沙盒组件的作者声明 `fields`（文字 / 数字 / 日期 / 时间 / 颜色 / 下拉，最多 20 个，key 限标识符），用的人在桌面编辑模式点组件左上角 ✎ 填表，值进 `WidgetInstance.config`，代码里 `AiPhoneWidget.getConfig(key, 默认)` 照读。默认值垫底，删字段连带清实例里的旧值；主题包与小卷的模板补丁都认 `fields`。
- **小卷出主题**（`lib/mascot-css-plan.ts`）：改 CSS 默认走「出主题」——出方案、弹卡片，用户自己点 预览 / 结束预览 / 应用 / 撤销 / 只存进主题库 / 看代码；小改动用局部补丁（`find` 必须恰好命中一次），`读取CSS` 附带按块编号的主题地图和已声明变量。主题库存 50 份，套用也走方案管线可撤销。`覆写CSS` 仍是立刻生效的老路径。
- **小卷**（`docs/mascot-editing.md`）：统一读取 → 准备草稿 → 预览 → 应用 → 记录 → 撤销管线，版本冲突拒绝覆盖；桌面/DIY/角色/主题都走它；DIY 沙箱接音乐控制；工具循环 8 轮上限、原生与文本调用去重。
- **冒险**（`docs/adventure-*.md`）：四时段游戏时钟由 `time_update` 推进；世界设定 AI 编辑预览后应用；可选自定义状态字段。
- **网易云音乐**：`ncm-api` 容器挂在同域 `/ncm`，Caddy 侧 `strip_prefix`；默认地址由 `NEXT_PUBLIC_DEFAULT_NETEASE_API_BASE` 在 CI 里给。
- **安全**：`lib/server/safe-outbound-fetch.ts` 所有出站请求校验目标 IP 防 SSRF，Undici 统一；`story-html-renderer.tsx` 渲染前清洗。
- **聊天头像**（聊天设置 → 聊天头像）：单聊可单独设一张「微信里的头像」：聊天页、会话列表、通讯录、朋友圈、通话页、通知都用它（走 `loadWeixinCharacters()`），角色 APP 仍显示角色卡原图。选图后先在圆形取景框里拖动/捏合裁剪（`components/ui/avatar-crop-dialog.tsx`，可复用），存 `session.chatAvatar`（320px webp data URL），可一键恢复。
- **聊天重新生成**（`lib/chat-reroll.ts`、`components/chat/reroll-dialogs.tsx`）：「重试以下」先弹说明框，快捷标签、自由说明、我的常用、附上一版对照可选；说明作为不落库的系统指令只跟这次请求走，单聊群聊都认。最新一轮回复重来过会留版本（每会话最多 8 版，存 kv），长按菜单「换一版 k/n」点选；发下条消息后作废。放回版本走 `restoreChatMessages`：换新 id、清 `cloudSync`，镜像与微信云同步按新消息上传。
- **持久存储**（`components/pwa-registrar.tsx`）：启动时未获持久存储就申请一次。
- **长期记忆注入方式**（`lib/memory-recall.ts`，记忆设置 →「长期记忆怎么放进提示词」）：默认「全部放入」，和原来一样按预算从新到旧塞满。选「按话题挑」后每轮只挑相关的几条（1～20，默认 8），关键词一路（CJK 双字 + BM25，常见词自动降权）总在，配了向量模型再并一路向量；过闸、相对阈值、去重后按发生先后排，每条前标「9月1日（周一）· 约 2 周前」。检索词除时间线最近 10 条外，再并上本次请求最近 8 条（含刚输入的），线下当前场景也算得上；日期标签只挂在返回副本上，不写回存储。
- **经期预测**（`lib/menstrual-predict.ts` 纯函数，日历 → 周期设置）：「按记录自动算」默认开，取最近几次间隔、剔掉漏记的那种加倍间隔后按新近加权平均；预测是「最可能那天 ± 波动」的一段窗口，月历画成浅色带、最可能那天实心圆，晚了不往后跳周期。关心分提前 N 天 / 最可能那天 / 晚了 3 天三次，另有可选「前一晚提醒」（21:00～22:00 或自定），App 关着走 timed_task 兜底，云函数不用改。
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

### 工坊配置聊天工具箱（2026-09-14）

工坊增加一个 `configure_chat_toolbox` 工具，文本协议名“配置聊天工具箱”。支持列出、读取、创建、局部修改、启停 MCP/REST/组合工具，并通过现有 MCP 发现流程更新工具定义；沿用 tool-storage 的同一份本地配置，聊天工具箱立即可见，不修改仓库。读取不回显 Token、headers、fixedParams 等凭据；更换 MCP 地址清除旧授权和发现缓存。保留未修改字段，新增默认关闭。工坊只配置，不因此自动获得该 MCP 的业务执行能力。

### 工坊按选择调用 MCP（2026-09-14）

工坊配置新增 MCP 勾选列表，默认空，授权绑定服务器id与地址，调用还要求工具箱启用。新增固定“调用MCP / call_workshop_mcp”工具，list列出授权服务器、read查看inputSchema、call复用现有MCP传输和参数校验；执行前再次检查授权。停用、撤回、地址变化立即阻止新调用，配置工具不能修改授权列表。结果读取文本与文本资源，并明确提示图片未进入此文本工具入口；超出工坊单页上限明确标注截断，不把base64塞进上下文。

### 工坊五项修补（2026-09-14）

- 上下文计量把 user 条目的图片 dataURL 算进去（`lib/qa-chat-store.ts` 的 `entryChars`）：图片每轮原样重发，此前不计入导致带图会话永远触不到压缩阈值。
- 输入框桌面端 Enter 发送、Shift+Enter 换行、Ctrl/Cmd+Enter 强制发送；触屏设备（`pointer: coarse`）Enter 仍是换行；输入法组合期间不触发。
- 工坊配置面板新增「采样温度」（`lib/qa-prefs.ts`，默认 0.8，留空 = 不传）。工坊不走聊天预设，引擎只造一个承载温度 + max_tokens 开关的最小采样对象给适配层，top_p / 惩罚项等一概不发；此前四处请求都传 `null`，温度固定为适配层默认 0.8 且无处可调。FAQ 同步改口。
- 创作指南不再按关键词整份塞进 system prompt（11 万字符的 APP 指南本就超预算从未注入过，小游戏/插件指南则每轮重发），只保留一段索引让模型走「创作指南」工具；工具新增 `plugin` 类型读聊天插件文档。system prompt 因此稳定，提示缓存更容易命中。
- 新增 `scripts/check-qa-engine.mjs` 覆盖流式过滤器（跨 chunk 指令隐藏、括号配平、思考块、续写标记、尾部暂扣、未收尾丢弃）、截断判定和文本/原生两种协议的上下文回放；`npm run check:qa` 串起它和已有的 toolbox/MCP 两个脚本，CI 构建前跟着跑。

### 工坊三项新功能（2026-09-14）

- **提案卡逐行 diff**：「提交修改」在确认模式下顺带读一次仓库原文（片段替换本就读过；整写/暂存引用各多一次读取，404 记为新文件；全自动模式不读，省 API 配额），存进提案的 `original` 字段。确认卡每个文件行可展开，`lib/qa-diff.ts` 做去公共头尾后的 LCS 行 diff，3 行上下文分 hunk，显示 +/− 统计；任一侧超过 4000 行只提示整文件替换。回归：`scripts/check-qa-diff.mjs`。
- **代码语法高亮**：`lib/qa-highlight.ts` 用 `highlight.js/lib/core` 只注册 11 种常用语言（js/ts/json/html/css/bash/python/sql/yaml/markdown/diff），token 颜色写在 `styles/qa.css` 跟随浅色主题。超过 3 万字符不高亮；未标语言只对 3000 字符内的代码自动识别且要求置信度。流式期间仍是纯文本，生成结束后才高亮。
- **重新生成**：会话最后一条回复的操作栏多一个刷新按钮，等价于把上一条用户消息原样重发（复用编辑重发的裁剪逻辑与副作用门禁：该轮调过工具就拒绝并提示新开一轮）。续接轮次（重试产生、没有用户气泡）不给重来。

### 工坊按选择调用 REST / 组合 / 自定义 APP 工具（2026-09-14）

与「调用MCP」同一套门禁：工坊配置里第二张勾选表（`lib/qa-tool-access.ts`），默认空，授权绑定 `kind:id → 指纹`（REST 用方法+地址、组合工具用 updatedAt、APP 工具用 APP 版本），指纹变了授权即失效；调用还要求工具在聊天工具箱启用（包内工具还要求包启用）。新增固定工具「调用工具箱工具 / call_workshop_toolbox_tool」：list 列出已授权工具、read 看参数 schema、call 执行，执行前再查一次授权。`tool-executor` 新增 `executeWorkshopToolboxTool` 按 id 定点执行，不走按名字的全表匹配，同名工具不会串条目。REST 工具 headers / fixedParams 的值及其中每个词不论成败一律脱敏；结果超工坊单页上限截断。「配置聊天工具箱」不能改这张授权表。回归：`scripts/check-qa-tool-access.mjs`。

### 外观预设与开屏动画（2026-09-14）

- **外观预设**（外观 → 外观预设）：把当前整套外观存成命名预设，最多 30 套，一键切换。内容 = 主题档案（主题色 / 壁纸参数 / 图标皮 / 字体 / 状态栏 / CSS 变量）+ 桌面图标位置 / 组件 / DIY 模板 / dock / 文件夹。存 KV 键 `ai_phone_appearance_presets_v1`（已加入「桌面与主题」备份模块），素材只记 id 引用，复用主题素材库，不复制 dataURL。切换走与主题包导入相同的落地路径（`onDesktopThemeChange` → `saveDIYTemplates` → `onApply`），不刷新页面。恢复默认与壁纸 / 图标皮 / 字体 / dock 皮删除会跳过仍被任一预设引用的素材（`isThemeAssetReferencedByPresets`），只解除当前引用。支持重命名、用当前外观覆盖、删除。
- **开屏动画**（外观 → 开屏动画）：默认「漂浮」（原 canvas 版）之外新增三套纯 CSS 变体「墨色」「极光」「脉冲」，以及「不要开屏」（水合完成后自动进桌面）。选择存 localStorage `ai_phone_splash_variant`（开屏在 KV 水合前渲染，KV 那时读不到），两个 localStorage 键已登记进「桌面与主题」备份模块。页面里卡片按 390 宽真实尺寸渲染再缩放预览，点卡片全屏预览。
- **自定义开屏**（同一页下方）：贴一段完整 HTML（可带 style/script）或从 .html 文件导入，存 `ai_phone_splash_custom_v1`，最多 20 套、单套 40 万字符；用沙盒 iframe（`sandbox="allow-scripts"`，不同源）渲染，碰不到宿主存储；没写 `<html>` 自动补无边距外壳。可编辑、删除（删掉正在用的回到「漂浮」）。

- **悬浮球贴边定位**：快捷操作和提示词球均校正记忆坐标，使用容器布局尺寸并监听尺寸变化，避开顶部状态栏；单球也使用停靠锚点，定位标记与实际坐标一致。

### 工坊图片上下文预算修复（2026-09-14）

图片按每张4096等效字符估算，不再将dataURL/Base64长度计入文本预算；文字、附件及工具参数维持原计数。百分比和压缩阈值共用估算，配置页明确其不是实际计费tokens。单条新消息本身超预算且旧上下文尚未触顶时不先压缩旧历史；同一轮若发送前已尝试压缩，结束后不再重复调用压缩。原图片和历史消息不改写，原生/文本协议仍发送真实图片块。

### MCP OAuth 真实授权与工坊错误详情（2026-09-14）

显式点击 OAuth 后，即使服务允许匿名 initialize/tools/list，也继续执行授权发现、PKCE 和 token 交换，不再将握手成功误报为账号授权成功。首次授权及手机回调恢复都要求非空 access_token；刷新返回无效 token 时保留旧凭据。工坊保留 MCP 调用的具体错误与状态码，401 提示重新授权，输出先隐藏连接凭据。通过模拟授权与工坊调用测试，不执行真实资料修改。

### 花园事件唤醒配置（2026-09-14）

聊天工具箱的花园 MCP 内新增角色选择、自动处理/仅接收、Machine Token 和手动连接管理。独立 VPS adapter 使用官方唤醒桥 0.2.1，单连接故障即停，不自动重连；收到事件写入私有队列。Float 前台以稳定消息 ID 写入普通 user 消息并确认收件，只有确认赢家启动现有角色工具管线。手机关闭时仅暂存，回到 Float 再处理，不宣称离线运行 MCP。部署、数据路径与投递边界见 `tools/garden-wake/README.md`。

### 通用工具事件入口（2026-09-14）

花园专用收件管线改为多来源通用事件网关：每个已有 MCP 均可配置独立来源、目标角色、自动处理/仅接收。公共 `/api/tool-events/ingest` 使用来源专属 Bearer 密钥接收 version/sourceId/eventId/reason/message；外部不能指定角色或管理其他来源。支持有界持久事件 ID 去重、原子确认、来源暂停和隔离删除。宿主消费器只核对保存的 MCP ID/URL 与开启状态，不含花园域名判断；花园 SSE 放入独立适配器，其他来源用 Webhook 或外部转换器，不必改宿主核心。旧配置、密钥、本地开关和消息 ID 兼容迁移，旧 API 留别名。仍仅在 Float 可见运行时触发角色，离线只暂存；详见 `tools/tool-events/README.md`。

### 忙碌提示写在干嘛 · CSS 停手即预览（2026-09-15）

- **忙碌提示**：发消息后 TA 被回复闸门拦下时，顶部提示直接写 TA 在干嘛（「TA在上课，15:30 左右再回」「TA在做饭，一会儿就回」），取自忙碌窗口 / 分神的标题（固定作息、今天的例外、挂念日程）；没有标题时退回原来的「TA正忙」。不做自动回复气泡。`ReplyGateDecision` 的 delay 多一个 `what`。
- **CSS 停手即预览**：全局 CSS（外观 → 自定义 CSS）和聊天 CSS（聊天 → 我 → 自定义 CSS）编辑框停手 250ms 自动预览，按钮改为「保存并应用」，没保存时显示「预览中 · 还没保存」，不保存直接返回恢复原样；聊天 CSS 的「清除」也改成只清框。全局预览直接改 `#ai-phone-global-custom-css` 的内容、不碰 draft，避免别的外观页点「应用」时把预览一起存下；聊天预览走 `chat-app-css-preview` 事件。

### 图片预览 · 编辑 · 出镜长相（2026-09-15）

- **预览层**（`media-preview-overlay.tsx`）：点开图片可双指缩放（1–4 倍）、双击放大 / 还原、放大后拖动，电脑上滚轮缩放；没放大时单击关闭。底部三个按钮：编辑 · 重新生图 · 保存。朋友圈配图同样（重新生图沿用存在动态上的 `photoPositive / photoNegative`）；只传 `onRegenerate` 的旧调用方仍是一个「重新生成」。
- **编辑面板**（`generated-image-edit-dialog.tsx`，替换原「重新生成图片」弹窗）：画面、角色出镜（长相 + 此刻的样子）、画风预设（kv `image-style-presets`，点一下套用，「存成预设」起名）、本次正向 / 负向（折叠）。正负向和方案默认一样就不单独存，不一样存进消息的 `mediaData.imagePositive / imageNegative`，「重新生图」一键沿用。OpenAI 兼容接口没有负向，写成「不要出现：…」接在末尾；单独改正向时保留设置页追加的【画面比例】。
- **两层外观**（`lib/image-prompt-extras.ts`）：长相由聊天绑定的模型从人设 + 性格提取（NovelAI 出英文 tag，其他出中文短句），按人设指纹缓存在 kv `image-character-looks`，人设一改下次出镜重新提取；编辑面板里改过的按当前人设记住。此刻的样子由聊天模型写在照片描述里（「此刻：…；画面：…」）。只在使用参考图（角色出镜）时把长相放到描述最前，冲突以此刻为准；提取失败不挡生图。设置 → 生图「角色出镜时加长相」可关（`appearanceOn`，默认开）。两个 kv 已进备份。
- **预设条目**：内置预设单聊 / 群聊「发照片」和三处朋友圈规则直接改原条目：出镜照片写成「此刻：…；画面：…」，五官长相不用写。不做运行时注入；自建预设用「同步内置条目」拿新写法。
- **同步内置条目看得出差异**（`preset-sync-dialog.tsx` + `lib/text-diff.ts`）：「查看差异」改成逐行对比，只列改动附近、其余折成「N 行相同」，改动的行里标出具体改了哪几个字（红删绿增），只差空格也画出来；条目下直接写「改了：内容 +2 −1 行」。短字段显示「当前 → 内置」。

### 推理深度 · 地址纠错 · 存不上横幅 · 更新日志 · 排错清单（2026-09-15）

- **推理深度**（`lib/reasoning-effort.ts`，API 配置 `reasoningEffort`；缺省＝按服务商默认，什么都不发）：关 / 低 / 中 / 高 / 更高 / 最高，按模型名换写法。Claude 原生：Fable / Mythos 5 系列一直在想，只发 `output_config.effort`，关不掉；Opus 5 / Sonnet 5 默认开，「关」发 `thinking: disabled`；Opus 4.7 / 4.8、4.6 发 `thinking: adaptive` + effort（4.6 没有「更高」）；Opus 4.5 及更早走 `budget_tokens`（2048 / 8192 / 16384），没有更高档，最后一条是工具结果的那轮不开（宿主不回传思考签名，开了会 400）。开思考时去掉温度 / top_p / top_k，max_tokens 按档位抬到下限。经中转站（OpenAI 格式）的 Claude 发 `reasoning_effort`，OpenRouter 发 `reasoning`。GPT-5 / o 系列发 `reasoning_effort`（5.1 起能关成 none，5 只到 minimal，o 系列关不掉，5.2 起才有 xhigh）。Gemini 原生写进 `generationConfig.thinkingConfig`（2.5 用预算、2.5 Pro 关不掉；3 用 thinkingLevel）。DeepSeek 和认不出的模型不发。档位这个模型没有时往下落。只管 `buildProviderRequest` 这条主请求路径，`simpleLLMCall` 的后台小任务不带。设置页有档位条、这次会带上的参数预览和说明。
- **地址纠错**（`lib/api-url.ts`）：`determineBaseUrl` 先纠错再用：去空格和结尾斜杠，补 https://，去掉多填的 `/models` `/completions` `/embeddings`（Claude 去 `/messages`），只填域名时补 `/v1`（Gemini 补 `/v1beta`）；带路径的（Cloudflare 网关 `/…/openai` 之类）不补；完整的 `/chat/completions` 照原样。框里原文不改；设置页 Base URL 下显示「实际会请求」和补了 / 剪了什么，「改成这个」才存；非本机的 http:// 标红；填了 anthropic.com 或 `/v1beta` 却选错服务商时提示切换。
- **存不上横幅**（`lib/storage-health.ts` + `components/storage-health-banner.tsx`）：11 个 Dexie 库文件顶部 import 这个模块，它注册一个 DBCore 中间件：写入被拒（ConstraintError 和连带的 AbortError 不算）或事务带错误 abort 时，记下库、表、值；浏览器强行断开连接（`db.on("close")`）也记。顶部横幅写几处没存上、最近一条是几点的什么，点开列明细；「重试」按原样重写（连接断了先重开）；重试还失败就提示复制没存上的聊天文字。只记本次打开以来的，关掉页面就没了，文案照实说。没存上的聊天消息按 `data-msg-id` 画红色虚线框。每 10 分钟查一次 `navigator.storage.estimate()`，用到 90% 横幅提醒，「去清理」进数据管理。
- **更新日志**（`public/changelog.json` + `lib/changelog.ts` + `components/changelog-sheet.tsx`）：给用户看的条目，按模块分组，新功能 / 优化 / 要你动手三色。启动后有没看过的就弹底部抽屉（已读 id 存 kv `changelog-seen-v1`；全新安装、还没配过 API 的直接记已读、不弹）；「关于与声明」加「更新日志」一行翻历史。自托管更新接口顺带取 main 分支上的 changelog.json，卡片列出「还没更新到」的条目；正在云端备份 / 恢复时「立即更新」等它做完（最多 10 分钟）。以后发版往 changelog.json 顶上加一条。
- **排错清单**（设置 → Help →「排错清单」，`lib/troubleshoot-checks.ts` + `components/settings/troubleshoot-page.tsx`）：7 类 21 项。聊天回复（没反应、报错码对照、截断、不像人设、标签外露、胡言乱语）；主动与推送（不主动、锁屏收不到、来得晚）；朋友圈（不发、不评论、配图）；生图与语音（失败、不像、没声音）；数据与存储（记录不见、存不上、卡、备份）；显示与安装（更新没变化、界面错乱、主屏幕）；APP 与插件（白屏、插件出错、挂念）。打开时现查绑定、Key、地址、模型、最近一次请求、预设条目开关、通知权限、个人推送云、存储用量、写入失败、云端备份、插件报错等，每步标通过 / 有问题 / 提醒，「去改」直达设置子页；「实际连一次」用默认 API 发一句你好。有问题的项自动展开，顶部汇总。

### 「+」面板自订 · 聊天变量 · 双向拉黑（2026-09-15）

- **「+」面板自订**（`lib/chat-plus-menu.ts`，kv `chat_plus_menu_v1`；`components/chat/plus-menu-editor.tsx`）：全局一份 `{order, hidden, seen}`。按钮都有稳定 id（内置 11 个 + `chat_variables`，APP 按钮 `app:<appId>:<actionId>`），没排过的按自然顺序接在后面；新装 APP 按钮默认勾上、红点点一次消失。插件坑位的按钮不进列表，固定在勾选项之后。
- **聊天变量**（`lib/chat-variables.ts`，kv `chat_var_defs_v1`；`components/chat/chat-variables-sheet.tsx`）：值就存在插件变量池 `chat_plugin_vars_v2`（session / character / global），插件、APP、宏读同一份；定义（类型、范围、说明、规则、AI 开关、最近 20 条变化）另存。面板三页：这段聊天（状态栏跟模式走：原生改最新一条消息的 `stateValues`、自定义只读最新 `statusPanel`、关掉不显示）/ 角色（官方插件和挂念的 8 个变量有中文名、摘要、谁写谁用，第三方原样）/ 全局。入口在「+」面板和聊天信息。
- **AI 改变量**：预设新条目 `chat_variables`（内容 `{{chatVariables}}`，只列开了「让 AI 按规则改」的用户变量）。AI 单独一行写 `[变量 名=值｜理由]`，`lib/chat-directives.ts` 在解析气泡前摘掉、全部落库后生效；只改开了 AI 的用户变量，数值夹到范围，选项必须命中。`{{setvar}}` / `{{setglobalvar}}` 经 `MacroVarStore` 写进变量池（local→session，global→global），`getvar` 读不到时从池里取。
- **角色拉黑 / 删你**（`lib/chat-block.ts`）：预设条目 `chat_block_actions`，AI 写 `[拉黑:理由]` / `[删除好友:理由]` → `session.charBlock`；系统提示存第三人称给 AI，`uiText` 给用户看。期间用户消息在 `pushChatMessage` 打上 `rejectedBy`（红 ! + 提示，不进提示词），角色消息一律丢，追发和后台回复停。冷静期 30 分 / 2 小时（默认）/ 6 小时 / 1 天，过了之后打开聊天或再发消息时单独问一次（`block_reconsider_prompt`）：拉黑可能解除并说一句，删好友可能发好友申请到「新的朋友」。被删可发朋友验证（`friend_verify_prompt`），被拒 10 分钟后才能再发。
- **你拉黑 TA**：沿用 `isBlacklisted`（自定义 APP 的 contacts.block 也写它），角色所有来源的消息在写库处截进 `blockedInbox`（最多 50 条），聊天信息里能偷看；输入框换成「解除拉黑」。解除时写一条带被拒条数的系统提示，拒过才让 TA 回一轮。聊天信息新增「拉黑与删好友」一栏：冷静期、上帝视角直接恢复、拉黑开关。
- 预设条目走 `BUILTIN_PROMPT_PATCH_VERSION = 2` 只增补丁：内置预设自动补上，复制出去的预设要「同步内置条目」一次。

### 回复方式 · 聊天截图 · 通话记录 · 通话细节（2026-09-15）

- **回复方式**（`lib/reply-style.ts`；聊天信息 ›「聊天」`ReplyStyleRows`）：会话字段 `replyLength`（mood / short / mid / long / custom + `replyMin` `replyMax`）、`singleBubble`、`onlineActions`、`autoModeSwitch`。预设条目 `reply_style`（`{{replyStyle}}`，tags `["chat"]`）只在有非默认项时出内容：线上给长度、单气泡、`*动作*`、`[切到线下]` 规则，线下只给 `[切到线上]`。单气泡在 chat-room `splitAndSaveAIMessages` 和 follow-up `parseAndSaveResponse` 里 `mergeSingleBubble`（文字合并，媒体仍单独）。`*动作*` 靠聊天页根节点 `data-online-actions` 把助手气泡里的 `em` 染灰。
- **自动切换**：线上 `[切到线下]` 由 `takeChatDirectives` 摘掉、落库后 `switchChatMode(…, "char")`；线下 `[切到线上]` 在 `handleOfflineSend` 摘掉。切换写 kv、发 `CHAT_OFFLINE_MODE_CHANGED_EVENT`，另留一条 `mediaData.modeSwitch` 的系统说明（给 AI 看第三人称）并发 `chat-mode-switched`；聊天页顶上挂 8 秒提示，「切回去」连那条说明一起删。
- **聊天截图**（`components/chat/chat-screenshot-sheet.tsx`，依赖 `modern-screenshot`）：多选栏「截图」。选中行按渲染 id `#message-<id>` 克隆进聊天页根节点里一个屏幕外舞台，外面套上消息列表几层祖先的 class，所以 `.session-<id>` 作用域的自定义 CSS 照样命中；头像 / 名字（打码）/ 时间（`data-time-row`）/ 背景（聊天背景或纯色）/ 水印可选。超过 80 条不画；带外站图片的消息提示并可一键取消选中。先生成、再点「存到相册」走 `navigator.share`（`lib/share-file.ts`），不支持时下载。
- **通话记录**（`lib/call-records.ts`，`components/chat/call-records-page.tsx`）：不另存，直接从聊天消息认「发起 / 挂断 / 拒绝 / 取消 / 未接听」，分出接通 / 中断 / 没接 / TA 拒接 / 你拒接 / 取消。详情页：TA 的句子用现在的声音重新合成播放；改字直接改消息；「分享音频」先合成 WAV（`lib/call-audio.ts`，逐句解码混成单声道、句间 0.35 秒）再点分享；中断的通话「修复」按最后一句 +1ms 插一条挂断；删除走聊天页的 `deleteWeixinCloudBeforeLocal`。入口：聊天信息 ›「通话」、展开的通话卡片底部。
- **通话小结**：`emitCallEnded` 结果为接通时，`summarizeLatestCall` 用 appId `call_summary`（预设条目 `call_summary_prompt`）写一句存到挂断消息的 `mediaData.callSummary`，卡片第二行显示。`loadNativeTimeline(…, { callSummaries: true })`（只有长期记忆总结这么调）把有小结的通话折成一行。
- **通话细节**（`lib/call-directives.ts`、`lib/call-art.ts`、`lib/call-css.ts`、`components/chat/use-call-extras.tsx`）：预设条目 `call_extras`（`{{callExtras}}`，只在语音 / 视频请求里有内容）。开关都在会话上：`callNarration`（全角括号旁白，字幕灰字、TTS 前删掉；半角括号只认带中文的，`(laughs)` 这类语音表情照读）、`allowCharHangup`（`[挂断]` → 说完后以 assistant 身份记 `[我挂断了…]`，UI 显示「X挂断了…」）、`callSummary`、`callCameraDefault`、`callSceneFollow`（接通时读插件变量 `presence` 里的 place / doing 等对场景名）、`callArtSwitch`（`[立绘:名]` `[场景:名]`）。立绘和场景按角色存 kv `call_art_v1`，图片在聊天图片库；视频有立绘时场景不再模糊。
- **通话美化**：会话字段 `callCSS`，`SessionCustomCSS` 以 `[data-call-screen]` 为作用域注入；稳定钩子 `.call-scene` `.call-portrait` `.call-avatar` `.call-topbar` `.call-name` `.call-timer` `.call-subs` `.call-sub[data-role][data-name]` `.call-sub-narr` `.call-controls` `[data-call-hangup]`。写了 CSS 时另加一段保护：挂断键及其父级强制可见、可点、置顶。预设「直播风」。原「外观」里的单聊通话背景挪进「通话」一栏。
- 预设补丁号升到 3，新增 `reply_style` `call_extras` `call_summary_prompt`。
### 语境属性 · 时辰主题 · 通知横幅版式（2026-09-15）

- **通知横幅编辑器**（外观 →「通知横幅」，`components/theme/notif-banner-page.tsx`）：五种场景（单聊 / 群聊 / 系统 / 长文本 / 来电）用横幅真身的 class 实时预览，浅深色切换、重播进场；逐项调 `--notif-*` 存进 `cssOverrides`，带窄条 / 居中卡片两套预设（拍立得预设试过，实际长相不好看，撤了；column 版式本身保留）。新增 `--notif-duration` 控制停留 1.2–30 秒。全局一份，不按角色分配。来电横幅和新消息横幅认同一套变量（默认长相各自保留，只有调过的项才共用），所以五个场景都会跟着预设变。
- **语境属性**（`lib/ui-context-attrs.ts`）：组件把当下的状态挂成 DOM 属性，主题 CSS 用属性选择器直接写规则，不用改组件。完整清单在 `lib/theme-types.ts` 顶部的契约注释里，属性名发布后不再改名。
- **时辰与深浅色**：`useAmbientContext()` 给手机屏幕根节点（`components/desktop-shell.tsx` 的 `[data-ui="phone-screen"]`）和聊天室外层 `.session-{id}` 挂 `data-time-of-day`（morning 5–10 / day 11–16 / evening 17–20 / night 21–4）、`data-hour`、`data-color-scheme`（跟随 `prefers-color-scheme`）。每分钟走 `bgSetInterval` 校一次（切后台普通定时器会被掐），另听深浅色变化和 `visibilitychange`。服务端渲染阶段不挂属性，避免注水前后对不上。
- **聊天列表项**（`SessionItem`）：`data-unread`（0 / 1 / few / many）、`data-unread-count`、`data-pinned`、`data-muted`、`data-group`、`data-last-type`（mediaType 的连字符写法，纯文字为 text）、`data-last-role`、`data-length`（按预览字数分三档）、`data-hour` / `data-time-slot`（最后一条的时间）；变量 `--item-index`、`--item-unread`、`--item-avatar-url`。头像地址超过 512 字符（base64）不挂变量，免得把每一行的 style 撑大。
- **朋友圈帖子**（`.feed-post`）：`data-author`、`data-has-img`、`data-img-count`、`data-photo-status`、`data-liked`、`data-like-count`、`data-hour`、`data-time-slot`。
- **通知横幅**：新消息横幅 `data-notif-kind="message"` + `data-group` + `data-session`，来电横幅 `data-notif-kind="call"` + `data-call-type` + `data-group`。
- **通知横幅版式变量**（`styles/chat.css`）：`--notif-layout`（row / row-reverse / column，column 配大头像就是拍立得样式）、`--notif-align` `--notif-justify` `--notif-gap`、位置与宽度（`--notif-top` `--notif-left` `--notif-right` `--notif-width` `--notif-margin`）、`--notif-min-height` `--notif-padding` `--notif-radius` `--notif-text-align`、头像那一块（`--notif-info-layout` `--notif-info-align` `--notif-info-gap` `--notif-avatar-w` `--notif-avatar-h` `--notif-avatar-radius`）、`--notif-text-width` 和「查看」按钮的 `--notif-action-order` `--notif-action-align`。这套变量 `.chat-message-notice-bar` 和 `.incoming-call-bar` 都消费，两边的 fallback 值不同。
- **会话 CSS 作用域修补**（`lib/css-scoper.ts`）：`:root` 后面紧跟属性或伪类的写法（`:root[data-time-of-day="night"] .x`、`:root:hover`）之前会被当成普通选择器加前缀，写出来的时辰主题不生效；现在和 `:root ` `:root.` 一样改写成作用域选择器本身。
### 朋友圈多图 · 聊天多选发图（2026-09-16）

- **数据**：`MomentPost` 加 `photoUrls?: string[]`（`lib/moments-types.ts`）。整组图都写进 `photoUrls`，第一张同时写进原来的 `photoUrl`，所以查手机、短期记忆、生图重试、朋友圈提示词这些只读 `photoUrl` 的地方照常能用——不用逐个改。
- **发帖**（`components/chat/moments-compose.tsx`）：文件框加 `multiple`，最多 9 张，每张照旧压到 800px / JPEG 0.8 存进图片库；还在压缩落库的图占位显示「处理中」，这期间发表按钮锁住，避免把没存完的图丢掉。删除按张删。
- **展示**（`components/chat/moment-post-card.tsx`）：两张以上按 `.feed-post-photo-grid` 铺（2 张和 4 张两列，其余三列方格，`object-fit: cover`），每格仍是 `MediaImageWithPreview`，点开能放大保存。单图和 AI 生图那条路完全不动，重新生图 / 改提示词的按钮只在单图时出现。帖子被清理过图之后 `photoUrls` 为空，靠 `multiPhotoCount` 兜住，不会渲染残留的旧解析结果。
- **提示词**（`lib/moments-engine.ts`）：多图时写「配图：见附图（共 N 张，附的是第 1 张）」——视觉附件仍只发第一张，不让模型以为全看到了。
- **存储**（`lib/storage-space.ts`、`lib/media-maintenance.ts`）：占用统计和按天清理都按整组算，清理时 `photoUrl` 和 `photoUrls` 一起置空。压缩仍只处理第一张：多图从发帖起就是 `asset://` 引用，已经压过一轮。
- **多图进提示词**（`lib/moments-engine.ts`）：`resolveMomentPhotosForVision` 返回整组（上限 9 张，与发帖上限一致），快照消息按「文字 + 朋友圈配图 N： + 图」逐张拼，模型看得到全部配图；正文里写「配图：见附图（共 N 张）」。关了图像识别时和以前一样只有文字。
- **聊天发图**（`components/chat/rich-input-modals.tsx` + `chat-room.tsx` 调用处）：`PhotoInputModal` 改成多选，`onSend(description, imageDataUrls)`，缩略图可逐张移除；发送时按选择顺序连发 N 条图片消息，描述只跟第一张，中途遇到「等对方回复」就停下。
