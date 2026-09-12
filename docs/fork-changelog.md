# Fork 变更日志

## 2026-09-12：云端普通回复恢复预设思维链折叠（本地待发布）

- 手机补收普通消息及现实桥回复时，在输出正则前按预设提取标签思考，正文拆分与折叠内容分别保存，原始回复保留。新普通回复兜底、追问、冷场、定时与关怀预约冻结线上解析配置，旧任务按当前绑定预设回退。
- 挂念正常发送的思考通过 metadata 交付，作罢仍不交付。保持显式关闭解析、插件顺序和重复回执去重。
- 专项：`check-push-outbox-plugins.mjs` 覆盖真实收取流程、旧配置回退、自定义标签、显式关闭、云端预提取、重复 ACK；挂念专项验证思考保留。不追溯修补已入库历史，不改变普通云端通知预览/动作判断，无 schema 变更。
- 发布需更新宿主及个人云 push-generate。未做手机端完整实测。


## 2026-09-12：挂念云端发送前解析思考标签（本地待发布）

- 修复完整 `<thinking>` 加作罢标记被当成普通聊天发送；保留原始生成快照，交付使用剥离思考后的正文。
- 新预约保存线上标签配置，旧预约兼容标准标签；保留显式关闭设置。不完整思考块与空正文失败结束。
- 专项：`node scripts/check-gua-nian-fact-replies.mjs`，覆盖报告结构、正常正文、思考内标记、自定义标签、关闭解析、残缺标签及重复执行。
- 生效需发布宿主并更新个人云 push-generate；旧标准标签预约更新 worker 后即可受保护。未修改历史消息与回执，无 schema 变更。


完整改动记录，**只追加不整理**。A 区是部署基础设施；B 区是 2026-09-05 之后的功能与修复，最新在上；C～Z 区是 2026-08-30～09-05 的功能，按时间正序。
当前行为的总览看 [fork-changes.md](fork-changes.md)，日常改完功能先更新那份，再把细节追加到这里。
条目里的「本地未发布」「待发布」等状态只对记录当时有效，以源码和实际部署为准。

`git diff upstream/main...main` 共 139 个提交、130 个文件（2026-09-03 核对）。


## 2026-09-12 陪眠 0.3.0：浅色重做、组合收纳、音质可选

- 白天 / 灰雾两套浅色不再是换底色：米纸 / 冷灰纸底 + 白色毛玻璃卡片 + 实心强调按钮，灰雾的蓝换成鼠尾草绿；通知条加了壳（深底浅字、描边、投影）。
- 首页天体按系统时间：7～19 点太阳，其余月亮，每分钟核一次；四个主题月亮统一金色，入睡画面永远是月亮。底栏去掉英文小字。
- 组合收纳：声景页只放钉住的（默认前 4 个内置），「全部 N ›」弹层里 ★ 钉/取下；长按组合看每层音量/起伏/是否已下载、总音量、来源，自存的可改名删除。
- 长按声音出详情表：Freesound 编号/作者/许可、原文件采样率位深声道时长、本机档位与大小、链接。
- 配置里可选下载音质 省流 64k / 高 128k（只影响之后的下载）；表单、弹层、说明文字整体缩小一到两号，今夜大字不动。

## 2026-09-12 陪眠 0.2.0：高音质、按需下载

- 内置 19 段声音不再打进包里（16MB → 50KB，可发市场）；第一次点到时在 iframe 里直连 Freesound 拉 `preview-hq-mp3`（128 kbps、44.1k 立体声）存进媒体库，块上有下载角标和进度；配置里可一次下完 / 清掉。
- 混音从 32k 单声道改成 44.1k 立体声（左右共用循环起点），循环体 48 秒；商店下载也改用高音质预览，时长上限放宽到 240 秒。

## 2026-09-12 陪眠 APP 第一版

- 新增官方自定义 APP「陪眠」（`custom-apps/pei-mian/`，0.1.0）：哄睡 / 失眠 / 只要声音三种模式，节奏曲线可调，19 段内置声景可叠 6 层，Freesound 商店，夜记日 / 周 / 月视图，夜航（日夜自动）/ 暖烛 / 灰雾三套主题。
- `scripts/lib/custom-app-package.mjs`：递归打包子目录（`assets/`），关闭 JSZip 自动目录条目保证 zip 字节稳定。
- `lib/custom-app-storage.ts`：`guessMime` 识别 mp3 / m4a / wav / ogg，安装包里的音频拿到正确的 `data:audio/*`。
- 新脚本 `pei-mian:build` / `pei-mian:check` / `pei-mian:test` / `check:pei-mian-app`。
- 视觉走访谈 / 栖所那条线：墨色夜空、琥珀单强调色、宋体标题下挂英文小标、细线分区、底部 5 tab；定时是月亮外的圆环拨盘，声景是竖向推子，周记是一夜横躺的时间轴；进场 / 拨盘 / 推子 / 时间轴 / 入睡画面都有动效，跟随系统「减少动态效果」。

## A. 部署基础设施（upstream 没有，纯自建）

- `.github/workflows/float-release.yml` — 构建+发布流水线（链路图见 CLAUDE.md 的「部署链路」）
- `ops/float-deploy.sh` / `.service` / `.timer` — 拉取、校验、切换、回滚、健康检查
- 服务器版本清理（2026-09-08）：部署前及健康检查成功后，仅保留当前运行版与两个回滚版本；切换后明确保护上一运行版。仅清理名称、VERSION 和入口文件符合部署格式的目录，跳过其他目录和符号链接，并复用部署锁防止并发清理。`/usr/local/sbin/float-deploy --prune-only` 可独立执行；专项验证为 `python3 scripts/check-float-release-retention.py`。
- `ops/float-ai-phone.service` — 生产服务单元
- `next.config.mjs` — 加 `output: "standalone"`，让 CI 产出自包含运行时，服务器上不需要 `npm install` / `next build`

## B. 功能与修复

### 修复日记混入别的角色的日记（2026-09-11）

- 日记 APP 手动生成和后台定时两条路径都把全部角色的日记整包传给引擎，引擎取最近 12 篇当「过往日记」，别的角色的日记连作者名一起进了提示词，模型顺着写出另一个角色的人和事。提示词查看器的预览自己先按角色筛过，所以看不出来。
- 修法：`lib/diary-entry-engine.ts` 的 `resolveDiaryEntryGeneration` 里按 `characterId` 过滤一次，三个调用方不动，预览与真实请求从此必然一致。已经混进内容的旧日记不会自动清理。
- 验证：`tsc --noEmit` 通过。

### 世界书按场景生效（2026-09-11）

- 世界书详情页新增「生效范围」：线上线下都生效 / 仅线上 / 仅线下，存为 `WorldBookConfig.mode`，缺省为全部。仅线下的书在线上请求里整本跳过，反之亦然；群聊算线上。
- 条目面板新增「适用场景」二级选择器（大类 → 小类），复用预设条目那张 `CONTENT_SCOPE_TAG_GROUPS` 表，存为 `WorldBookEntry.tags`；不选 = 通用。选择器按书级范围收窄：仅线上时藏掉「聊天 → 线下」「群聊 → 线下」，仅线下时只剩通用和这两个小类。已选场景与书级范围冲突的条目在列表行标「与生效范围冲突」，引擎按书级范围为准跳过。
- 过滤落在 `lib/llm-prompt-assembler.ts` 单聊、群聊共享书、群聊独享书三处激活循环的 `!entry.disable` 旁，新增 `isWorldBookEntryInScope`（`lib/content-tag-utils.ts`）；提示词查看器走同一条 `previewPromptRequestSnapshot` 路径，切「线下 ON」即可看到筛选结果。
- 导入解析（`parseWorldBookFromJson`、条目 JSON 导入）保留 `mode` / `tags`；导出原样带出。角色卡内世界书、mascot 工具、自定义 APP host API 不写这两个字段，旧数据等于旧行为。
- 验证：`tsc --noEmit` 通过；改动文件 lint 仅剩世界书管理页原有的 3 个 react-hooks 错误。未做真实模型验收。

### 聊天头像按会话覆盖（2026-09-10）

- 追加：改为微信区域统一生效。`lib/chat-storage.ts` 新增 `loadWeixinCharacters()`（按单聊 `chatAvatar` 覆盖角色卡头像），聊天、通讯录、朋友圈、群聊建群/成员、通话、通知头像缓存共 11 个文件从 `loadCharacters()` 换过去；角色 APP 不换。
- 追加：选图后先弹 `components/ui/avatar-crop-dialog.tsx` 裁剪（260px 圆形取景框，单指拖动、双指捏合、滚轮缩放，最大 5 倍），确定后按框内区域出 320px webp。组件独立于聊天，角色卡、用户头像还没接。

- 聊天设置的「聊天背景」下新增「聊天头像」（仅单聊）：选图后缩到 320px webp 存进 `session.chatAvatar`，聊天页所有角色头像位与会话列表优先读它，角色卡 `character.avatar` 不写回；「恢复」清空后回落到角色卡头像。
- `ChatRoom` 里 `character` 改为按 `storedCharacter` + `session.chatAvatar` 派生的 memo，页内引用点零改动。用户身份页的图片缩放函数抽到 `lib/image-data-url.ts` 共用。
- 验证：`tsc --noEmit` 干净；六个文件 eslint 报的错都在改动范围之外（chat-room 既有的 react-hooks 规则）。未在手机端验收。

### 挂念诊断分类（0.9.33，2026-09-11）

- 云端消息任务、后台模板、历史记录及其他角色分开显示；无法确认的记录单列，旧模板和约定零阈值不再制造“有旧预约”误报。
- 最多 20 条账号样本加当前计划精确查询，数量注明为本次读取；新增刷新入口，缓存按云地址隔离，部署包与数据库版本分开。
- 本机今日登记仅供参考，排除模板和未来日期造成的混淆；未复核不报警，总览不再保证“一切正常”。仅改只读诊断，个人云需更新 ai-phone-push 网关，无 SQL 变更；专项脚本 check-gua-nian-diagnostics.mjs，未做手机端完整实测。

### 挂念诊断页结构重排（0.9.34，2026-09-10）

- 「后台」子页签下直接接内容，云端同步、云端发送记录不再横在页签和内容之间，分别并入诊断页的「状态」和「工具」卡。
- 诊断页固定三张带标题的卡：状态（结论 + 连接/任务/复核/同步）、记录（本机登记/回音/日志）、工具（此刻预览/发送记录），和用量页同一套骨架。每块统一为原生 `<details>` 折叠，warn/bad 原地高亮并展开，不再在两张卡之间搬动。
- 展开体只剩三种元素：`diag-item` 行、卡尾左对齐说明、末尾一行按钮；空状态和错误改为行而不是居中脚注，「云端点亮」和日志的清空按钮不再嵌套折叠或顶在正文之前。没接云连接时保留状态卡里的结论与「去设置」入口。
- 验证：`npm run gua-nian:build`、`npm run check:apps-dist`、`node scripts/check-gua-nian-diagnostics.mjs`（补了同步/记录渲染钩子桩），430px Chromium 截图核对无云、有云、全部展开三种状态（演示数据）。随 0.9.34 发布，宿主自动提示升级。

### 挂念话头更新与判重（0.9.32，2026-09-10）

- 发布核验补齐官方 ZIP 的公开静态访问规则，避免未登录请求被重写成首页并缓存；官方目录/安装包禁用缓存，下载 URL 带版本并核对包内版本。
- 本地和云端 applyThreads 对话头/日子使用已有 ID 更新原条，不再仅凭字面匹配后新建。无 ID 时按同类型规范化文本找唯一候选；未知/类型冲突 ID 和多个候选不擅自新增、覆盖。重复条目续期现在触发保存。
- 提示明确同一事件改措辞也必须引用原 ID，并带入近期已了结话头/日子用于判重；已了结项保持了结，用户现有重复记录不自动清理。未增加模型调用。
- 生成挂念 0.9.32 HTML/ZIP 与云函数副本。专项 `check-gua-nian-thread-updates.mjs` 对照本地/云端，约定隔离检查使用 `check-gua-nian-promises.mjs`；需发布后重新部署个人云 ai-phone-push、push-recheck 并升级 APP，无新增 SQL。APP 支持随宿主发布后站内一键升级，未做手机实测。

### 忙碌回复状态提示精简（2026-09-10）

- 插件升至 1.1.1，以白名单读取当前信息并渲染中文摘要，替代整份变量 JSON 截断注入。移除同步字段、内部 ID；不再读取 affection 变量，避免重复注入当前关系、好感分数/档位及历史；手动忙碌/睡眠过期后不再作为有效手动状态注入。
- 不修改共享变量、好感结算、历史和面板；不修改等待规则、沉默开关或好感插件自身的分寸提示。短文本逐字段压缩，保留 0 精力，未知结构不序列化输出。
- 生成官方插件副本，SW 缓存版本升至 v33。专项 `check-busy-reply-state-prompt.mjs` 检查字段白名单、历史不泄漏、原始对象不变、手动状态有效期、缺失/异常字段及原开关边界。本次随宿主发布，刷新小手机后已安装的官方插件可自动升级；不需要更新个人云函数。

### 自用实例开放隐藏入口（2026-09-10）

- 日记：`NOTE_WALL_UI_ENABLED` 改 true，便签墙卡片回来（上游关着）。表用 `docs/notewall-supabase.sql` 或 `supabase-all-in-one.sql`。
- 购物：黑市触发词增加「黑市」；首页列表底部加一行灰字「· black market ·」直接进入，不必搜索。

### 角色可见范围（2026-09-10）

- 新增 `lib/character-visibility.ts`：kv `character-visibility`，`{ default, apps }` 两层规则（`hiddenTags` / `hiddenIds`），`loadVisibleCharacters(appId)` / `filterVisibleCharacters` / `isCharacterVisibleIn`，`collectCharacterTags` 收集候选标签。
- 新增设置页 `components/settings/character-visibility.tsx`，挂在「数据与规则」卡片组；全局默认一张卡，下面按功能（宿主功能 + 已装自定义 APP）逐个展开覆盖，可恢复跟随默认。
- `custom-app-runner.tsx` 的 `characters.list` 按 `custom_app:<manifest.id>` 过滤；挂念、拾光等自定义 APP 零改动。查手机与栖所的角色列表改调 `loadVisibleCharacters`。
- 验证：`tsc --noEmit` 0 错误；新文件 lint 只有与绑定管理相同的 `<img>` 警告；`phone-settings-app.tsx` 的 2 个 lint 错误为原有。未实机验证设置页布局。

### 查手机与栖所的批量生成（2026-09-10）

- `lib/checkphone-batch.ts`：`generateCheckPhoneAppSnapshot` 统一分派 23 个 APP 的生成函数并落盘，用 `beginCheckPhoneRefresh/endCheckPhoneRefresh` 与页面共享生成中状态；`runCheckPhoneBatch` 并发 2，可取消（完成当前后停）。`checkphone-app.tsx` 桌面右上角新增「批量」按钮和浮层：全选 / 只选未生成 / 清空，逐行状态（排队 / 生成中 / 已生成 / 失败原因 / 已有内容），样式在 `styles/checkphone.css` 末尾。
- 栖所：`handleExploreItem` 拆成 `exploreItem(…, openOnDone)`，批量时不打开详情、不弹单条错误。房间页签栏加「批量探索」按钮，底部弹窗复用 `dw2-sheet`，按家具分组、方块勾选，默认勾未探索项，并发 2，失败原因写在行内，可停止。样式在 `styles/dwelling.css` 末尾。
- 验证：`tsc --noEmit` 0 错误；两个组件 lint 与改前数量一致、我改的行没有新增；两份 CSS 经 `app/globals.css` 进入哈希产物，不用升 SW 缓存版本。未在浏览器和手机上实际点过，弹窗布局需要实机看一眼。

### 官方 APP 随宿主自动升级 + 个人云函数版本提示（2026-09-10）

- 新增 `scripts/lib/custom-app-package.mjs`（统一打包口径）和 `scripts/build-custom-apps-dist.mjs`：四个官方 APP 打成 `public/custom-apps/<目录名>.zip` 并生成 `index.json`，进 `npm run build`；`build-shiguang.mjs` / `build-gua-nian.mjs` 改用同一打包函数。`npm run apps:build-dist` / `check:apps-dist`。
- 新增 `lib/custom-app-official.ts`：按 `manifest.id` 对照 index，`updateInstalledCustomAppFromOfficial` 复用市场更新的注册/回滚流程，但保留本机运行时 id 与 `marketItemId`。`desktop-shell.tsx` 的更新弹窗改为 `source: market | official` 双来源；启动时巡检已装官方 APP（一次只提示一个，更新后不打开），打开 APP 时官方目录优先于市场。
- 新增 `lib/personal-push-version.ts` 部署包代号 + 摘要，`push:build-dist` 自动 +1 并内联进网关 health（`functionsVersion`），`check:push` 校验代号与摘要一致。`personal-push-cloud.ts` 状态多记 `functionsVersion`，新增 `probePersonalPushCloudUpdate()`；设置页「离线推送」卡片显示落后并给出黄色提示，桌面启动每个代号提醒一次。
- CI 构建前新增 `check:push && check:apps-dist && check:sdk` 一步。
- 验证：`tsc --noEmit` 0 错误；改动文件 lint 无新增（`cloud-services-setup.tsx:160` 的 `set-state-in-effect` 为原有）；`check:push`、`check:apps-dist`、`check:sdk`、`shiguang:check`、`gua-nian:check` 通过。`check-fork-regressions.mjs` 在 HEAD 上已有一项失败（recheck-plan 409），与本次无关。未在手机上实测升级弹窗，未部署真实个人云验证 `functionsVersion`。

### 查手机时间、完整条目与查询可靠性（2026-09-10）

- 带时区的时间戳按设备本地时间格式化，逐条标注历史时刻的 UTC 偏移，正确处理跨日及夏令时；无时区的原始日期时间标注“未标注时区”，不猜测。日历日期/时段保持原本地含义；订单优先显示带时区换算的付款时间，缺少付款时间时保留原标签。
- 六个内置查询工具按完整格式化条目控制 2000 字符预算，报告实际输出数与未展示条数；聊天历史从最新条目向前选择，再按原顺序展示。单条正文仍沿用 800 字符预览上限及省略号；超长条目无法容纳时明确提示未展示，不宣称无记录。宿主其他工具的原输出上限不变。
- 指定 sessionId 严格精确读取；原名、备注、微信号等私聊身份匹配优先于群成员匹配。同级多会话或仅匹配群成员时先返回候选，不按更新时间擅自选择，也不提前读取候选聊天正文。
- 历史始终排除 silentUpdate；默认排除原生工具轮、工具提示、记忆写入请求及系统/工具消息。显式 includeSystem 可查看系统/工具信息，但不把沉默更新算作发言。
- 日历/订单区分成功读库但未建记录、有效空列表、读库失败和 JSON/结构损坏；后两者明确报错。`node scripts/check-phone-lookup.mjs` 验证五类问题和旧姓名查询回归；仅时间专项在上海、UTC、纽约运行，包含纽约夏令时重复小时。相关 ESLint 通过。存储与网络使用夹具，尚未手机实测；只发布宿主，无需更新挂念 ZIP 或个人云函数。

### 查手机会话名称与长资料读取（2026-09-10）

- 修复资料工具将超过 12,000 字符的 JSON 截断后，组合工具解析失败却当作空列表的问题。内部以 Symbol 字段传递完整的已脱敏结构化数据，脚本中间结果保留完整内容；最终给模型的文字沿用原长度限制，内部字段不随 JSON 序列化输出。
- 消息列表和聊天记录定位只读取角色 ID、名字和微信号；联系人摘要与身边人物工具保留其原有资料字段。角色原名、联系人备注、会话别名和微信号均可匹配同一会话。
- 无效资料返回及聊天记录数据库不可用明确报错，不伪装为“没有联系人/聊天”；有效空列表仍正常返回。仅更新宿主，无需更换挂念 ZIP 或个人云函数。
- 专项验证：`node scripts/check-phone-lookup.mjs` 运行实际资料结果适配器、组合执行器和内置查询脚本，覆盖 6 个长角色卡会话、长身份字段、四种姓名/号码匹配、指定会话历史、失败与空数据、内部完整传递和最终输出限制。存储读取由受控夹具提供，尚未手机实测。

### 沉默仅停止聊天显示（2026-09-09）

- 沉默协议改为首行 `[本轮不回复]`，后续继续按原配置输出状态、内心、签名和必要更新。没有变更内置/插件内心提示词，也没有将内心全文加入下一轮聊天历史。
- 允许沉默的前台请求继续运行回复插件和原有更新/工具处理，保存 `silentUpdate` 隐藏记录接收本轮元数据；不生成正文/爱心卡片、会话预览、未读或普通消息发布事件。插件待挂载心里话由本轮隐藏记录接收，避免落到下一条正常回复；隐藏记录从界面和模型历史排除，当前状态读取仍有效。
- 云端沉默结果若带更新内容，通过固定编号的 outbox 留待客户端正常插件/解析管线落库，跳过聊天通知；纯沉默沿用直接完成。源码与公开函数副本已同步，SW 缓存版本升至 v31。
- 专项验证：`check-chat-silence.mjs` 覆盖普通/原生工具及流式/非流式输出，`check-chat-silent-updates.mjs` 执行真实好感插件和元数据保存流程，验证内心不串条、状态保留、不显示/未读、云端幂等和不通知；`check:push` 验证部署副本一致。未在本机全量构建，未部署云函数或线上服务。

### 聊天提示词位置、插件预览与重新生成（2026-09-09）

- 新增语音表达协议通过 `{{voiceExpression}}` 在已有聊天格式的「语音条」小节和单人语音通话条目内部展开，开关关闭时为空；保留通话原有单段要求。旧预设只补宏，保留自定义文本、顺序及开关，不提升会重置内容的出厂版本。
- 固定沉默输出协议由请求末尾移到前部，沉默资格判断保持原样；挂念状态位置保持原逻辑。请求组装等待插件就绪，单聊手动提示词查看器补齐 `llm.request` 变换，与实际请求一样显示本次参与的插件内容。
- 修复长按「重试以下」截取到同轮前一条 AI 气泡时，被误判为无新输入续写的问题。重试显式传递生成意图，保留用户上下文与原删除范围，跳过不适用的续写提示；真正空输入生成仍保留保护。
- 验证：`check-chat-prompt-layout.mjs`、`check-voice-expression.mjs`、`check-chat-silence.mjs` 定向检查；未运行本机 Next.js 全量构建。细节见 [语音表达及提示词组织](voice-expression.md)。

### MiniMax 自然语音表达（2026-09-09）

- 声音标签规则补齐同步接口的全部 19 个标签及中文含义，普通聊天语音条和单人通话共用；内置规则与默认表达提示词改为“按语境在合适的地方使用”，不再限制为少量或多数句子不用，保留用户自定义提示词。
- 语音 API 配置新增独立的「自然语音表达」开关及可编辑提示词，旧配置默认关闭；界面沿用宿主圆角开关行、输入框和文字按钮，完整配置组件使用项目样式核对。开启后接入普通聊天语音条和单人语音通话，复用本轮聊天模型，根据上下文生成情绪，在合适的位置使用声音/停顿标记。
- 气泡、字幕和历史保留可读文本，表达原文独立保存。MiniMax 收到按段情绪；2.8 HD/Turbo 支持声音标签，其他模型和关闭状态有清理回退。已生成音频保留，编辑文字不会复用旧表达内容；通话挂断停止后续段落。
- 定向测试覆盖请求参数、解析、双语/编辑、配置隔离、通话取消及普通聊天缓存；隔离浏览器验证设置组件。未做付费语音或手机实机验证，未在本机全量构建。架构、范围和使用见 [自然语音表达](voice-expression.md)。


### 信息页自动同步挂念状态（0.9.31）

- 宿主读取已选角色日程，前台按墙钟更新在线状态、正在做什么、地点和精力等；进入会话/状态面板、回前台及本地修改触发同步，无须先打开挂念，不调用模型。
- 新增经过鉴权的批量日程读取接口，日程保存后发送私有变更通知，60 秒轮询补偿断线；本地未同步修改和较新版本受保护，断网保留缓存并标注。
- 官方在线状态插件优先手动覆盖，好感面板局部更新状态、保留其他输入。宿主和 APP 共用纯状态计算模块。见 [验证与部署说明](gua-nian-presence-sync-2026-09-09.md)。


### 挂念模板恢复与设置反馈（0.9.30）

- 修复后台模板先撤旧再建新导致断档的问题；新模板不写本地消息队列，避免替换同会话的普通预约。后台模板可在免打扰期间保存，普通消息限制保留。
- 后台重试先重建模板并同步计划，成功后再恢复任务；云端区分模板读取、解密、关联和记录缺失，空自发结果也留记录。
- 设置生效说明归入设置面板，不再占各页顶部。交付与验证见 [本轮说明](gua-nian-template-recovery-2026-09-09.md)。


### 冒险剧情时间推进（2026-09-09）

- 修复新游戏一直停在清晨的问题：原有时段推进工具未接入游戏，只有休息会跳到次日清晨。场景生成、普通行动裁决、自由交流后的直接裁决现在均可返回 `time_update`，由程序校验并保存，仍使用清晨/午后/黄昏/夜晚四时段，不按聊天轮数或现实时间硬推进。
- 每次请求显式提供最新游戏日与时段；AI 返回原时间、绝对目标时间及原因。短暂对话可不变，明确的赶路/等待/过夜才推进；拒绝非法日期/时段、倒退、与请求原值不符或缺少原因的变化。格式修复或截断回复不推进，API失败不改时钟。
- 成功一轮记住 `lastTimeTurnId`，待完成事件保存 `timeTurnId`；真正的失败重试复用编号，掷骰后跳过重复显示仍算新一轮。绝对值、原值检查与轮次编号共同防止重复推进。时间原因记入日志，本轮剧情日志、自定义状态变更记录、顶部及下一轮使用更新后的时间；休息维持次日清晨，旧存档无需重建。
- 角色发言（普通、离开、自由交流）和提示词预览追加最新游戏时间，结局同样更新游戏时钟上下文。时间工具独立为纯函数模块 `lib/adventure-time.ts`。
- 验证：`node scripts/check-adventure-time.mjs` 覆盖时段/跨日、原值/倒退/格式拒绝、重复轮次、实际场景/普通/直接裁决与休息处理函数、真实存档回调中的重试编号、重新打开后重试；`node scripts/check-adventure-status.mjs` 验证状态、世界修订与角色时钟上下文兼容。新增时间模块类型检查通过，相关 lint 无新增问题；没有运行本机 Next.js 构建、真实模型或手机实机全流程。说明见 `docs/adventure-time.md`。

### 冒险世界设定的 AI 编辑（2026-09-09）

- 「冒险 → 状态 → 世界设定」新增紧凑的 AI 编辑入口，可查看当前背景与已有 NPC，输入自然语言修改要求，逐项预览原值/新值/原因，确认后保存。更改要求或放弃预览不写入；支持取消与 120 秒超时。
- 第一版只改世界背景和已有 NPC 姓名、人设，不新增/删除 NPC、不改地图拓扑、任务、玩家状态或历史进度。AI 请求只带公开背景和 NPC 资料，不带 DM 密档；严格校验操作范围、编号、内容长度、重复字段和同名冲突。
- NPC 修改同步扁平列表与地图节点，要求能唯一定位；改名保留旧名关联，旧任务/对话文字继续指向同一 NPC，不批量重写历史。预览基于世界资料版本，确认时在 IndexedDB 事务内重读并校验，写入成功后才更新内存和当前页面；失败或过期预览保留原资料。
- 场景、普通/自由交流后的裁决、结局在请求时按世界 ID 刷新旧事件快照中的背景/NPC资料；角色发言、预览与总结追加最新公开修订。未编辑世界保留原提示路径；修订内容优先于旧对话/任务文字中的冲突设定，模型语义一致性仍需要实际使用确认。
- 验证：`node scripts/check-adventure-world-edit.mjs`（规则、模拟模型、隔离数据库失败注入、实际 DM 请求刷新）；`node scripts/check-adventure-status.mjs`（相关角色提示词及状态兼容）；`node scripts/check-adventure-world-edit-browser.mjs`（Chromium 320/390px 各 31 项真实 React 交互）。新增领域模块和编辑器类型检查通过，相关 lint 与 HEAD 基线相比无新增问题。未运行本机 Next.js 构建、真实模型调用或 iPhone 实机验证。说明见 `docs/adventure-world-edit.md`。

### 冒险可选自定义状态（2026-09-08）

- 界面改为紧凑布局：正文/输入 11px、标签和提示 10px（随应用文字缩放），按钮与输入框最小高 30px；当前值两列排列，字段按行显示并默认折叠编辑，减少整屏大表单和重复说明。保留键盘焦点、表单标签及独立的生成/错误提示，样式仅作用于此面板。

- 新建世界可配置，已有世界可在「状态 → 自定义状态 → 设置与手动纠正」开启，默认关闭。支持文字身份与有范围的辅助数值；默认通过「让 AI 根据世界生成字段」建议字段、初始值、范围及规则，预览调整后保存，已有字段仅补充不覆盖。保留手动添加和宫廷示例作为备选，没有经验阈值晋位规则。
- 配置、当前值和变更历史随冒险存档保存；世界创建模板与存档深拷贝隔离。关闭保留数据，停止提示词注入和自动更新。手动补录、纠正、字段配置修改、移除及待发生事项撤销均留原因。
- 字段建议每次点击调用一次当前冒险绑定的模型，读取背景、有限近期剧情和已有字段，不读 DM 密档或完整角色人设；最多补充 6 项，严格校验类型/范围并由宿主生成编号。取消、120 秒超时、无效/截断回复不改原字段；生成中不允许保存或创建世界，旧世界生成期间推进剧情则拒绝旧建议。
- 场景与裁决复用原有 DM 请求返回 `status_changes`，每轮无需新增模型调用。校验字段、原值、数值范围、当前版本和本轮正文原文依据；正式事件才更新，提议/传闻/许诺只记待发生。模型负责事件语义判断，程序不能独立证明册封真实生效，提供手动纠正。JSON 修复可能改写标点，开启功能时优先原样解析；需修复的回复保留剧情但不更新自定义状态。
- 世界生成、场景、每轮裁决、角色发言（含自由交流/离开）、提示词预览、结局与总结注入最新启用状态。只注入当前字段、最近 5 条已生效记录和最近 10 条待发生记录，完整历史仅保存在存档。辅助数值不与同伴原有好感度自动同步。
- 专项验证：`node scripts/check-adventure-status.mjs`（纯规则、隔离存档适配器、真实请求组装流程搭配模拟模型回复）、`node scripts/check-adventure-status-suggestions.mjs`（跨题材建议、既有字段保护、输入上限、取消和失败）、`node scripts/check-adventure-status-browser.mjs`（真实 React 面板，Chromium 320/390px，各 56 项交互检查）。新增状态模块及面板类型检查通过；相关 lint 与 HEAD 基线比对，原有页面 lint 问题保留。未运行本机 Next.js 构建，未调用真实模型、读取用户手机存档或完成 iPhone 实机验证。设计与使用说明见 `docs/adventure-custom-status.md`。

### 小卷组件配置刷新与编辑版本隔离（2026-09-08）

- 复现：读取 desktop/DIY 后，仅组件 `config`（例如天气缓存）更新，旧的全桌面版本就拒绝未变源码的样式修改。读取同时记录完整版本与排除组件配置的结构版本；后者仍包含所有布局、模板源码和组件结构。
- 不写 config、不删除组件的计划允许保留最新配置；提交和撤销按实例 ID 合并当前配置，不把草稿里的旧配置写回。配置写入、删除、源码/布局变化仍检查冲突；撤销新增组件时若其配置已被修改，拒绝删除并丢失新数据。旧草稿和缺少结构版本的旧读取保留原严格规则。
- 错误区分缺少本轮读取、配置已变化、其他内容已变化；编辑指南说明只改样式时不要回填 config。新增隔离测试覆盖读取/准备/应用/撤销间持续配置保存、模板改样式、单实例复制、移动、真实冲突和旧草稿兼容，`node scripts/check-mascot-edit.mjs` 与相关 ESLint 通过。没有读取用户手机数据，复现的是相同机制，不能仅凭截图确认实际变化字段。

### 小卷新增搭配卡的组件类型纠错（2026-09-08）

- `widget.place` 类型不存在时返回实际传入值、失败动作序号与纠正方法；区分桌面实例 ID、组件显示名称和未知类型。错误明确说明不是读取版本过期，避免只重复读取而不改动作。没有放宽类型校验或自动猜测/替换目标。
- 桌面读取说明和编辑 schema/指南补齐“移动已有实例”“新增现有款”“新建卡片并摆放”的区别。新卡使用同一 `template.create` 动作的 `patch + place`，由宿主生成并使用模板 ID，无需先应用或自造 ID；位置 schema 同步现有边界。
- 专项验证 `node scripts/check-mascot-edit.mjs`：复现三类无效类型，校验失败时整个批次不写目标或草稿；直接解析指南示例生成四页卡片方案，保留原组件和图标，预览成功后实际桌面仍不变。相关文件 ESLint 通过。使用隔离数据和模拟预览宿主，未验证用户手机内的实际调用参数或真实模型输出；截图只能定位类型校验错误，不能确认具体误填值。

### 小卷读取记录与工具循环修复（2026-09-08）

- `准备修改` 使用宿主在本轮真实读取时保存的版本记录，reads 不再要求模型复述；兼容旧参数但不把模型传回的版本当作读取依据，避免漏传/抄错造成读取与准备反复循环。
- 桌面、外观和角色列表读取忽略无关 id；新旧编辑入口统一只保存实际编辑范围，避免无关桌面变动阻塞角色更新。仍拒绝未读、读错角色、真实数据变化及应用后未重读的操作。
- 同轮展开套件后继续执行该轮动作；原生调用在解析时保留各自的 ID 和协议名称，避免混合调用错位及重复工具名复用首个 ID。文本调用不借用原生 ID；同一响应中的相同原生/文本动作只执行原生调用，参数按对象键序无关、数组顺序有关比较，保留不同参数及同一协议内的动作顺序。
- 耗尽 8 轮时在对话中明确提示可能未完成，通知显示达到处理上限；正常结束通知改为“已回复，请查看结果”，不再把回复结束当作操作成功。中止与异常分别处理；停止后不再启动同批剩余动作，并为未执行的原生调用回传取消结果。模型请求被中止时也记录中止状态；已经开始的动作等待返回，已完成修改不会自动回滚。
- 文本调用格式只展示必填字段，递归处理对象、最少数组项、整数和数值边界及默认值，避免可选坐标填 0、整数填 null 或无关 ID 占位。组件坐标 schema 补齐现有整数范围，尺寸冲突说明与实际拒绝行为一致。
- 新旧预览入口统一检查窗口是否接收请求，失败明确报错并返回保留的方案 ID；可以从修改记录重新预览，失败或成功预览都不自动应用草稿。
- 专项验证：`node scripts/check-mascot-edit.mjs` 和 `node scripts/check-mascot-tool-loop.mjs`，覆盖读取记录、真实/无关冲突、重读恢复、应用/撤销、按示例自动摆放、同轮混合调用、重复工具名、结果 ID、跨协议去重、循环耗尽、批内停止、绘制时停止、请求中止、预览宿主缺失/恢复与异常。改动文件 ESLint 无错误；引擎原有两条未使用导入警告保留。未跑全量构建、全项目类型检查、真实模型或 iPhone 实机测试。无云函数、APP ZIP 或静态资源副本变更。

### 挂念后台预约误发与同步展示（0.9.28）

- 云端停止没有有效计划关联的挂念预约，修复其绕过发送间隔的问题；新哨兵带独立编号，历史计划中的旧哨兵和本地残留哨兵也拦截生成。其他 APP 的预约规则不变。
- 同步状态统一在后台折叠展示；后台新增当前角色最近 50 条云端发送记录，包含已收取和当前计划未关联的消息，不依赖手机留有计划。
- 沿用 schema 12；需要发布宿主、更新个人云网关/生成函数并导入 0.9.28。验证与限制见 [本轮修复说明](archive/gua-nian/gua-nian-orphan-wake-repair-2026-09-08.md)。



### 小卷统一编辑与桌面音乐联动（2026-09-07）

- 新增读取、准备草稿、预览、应用、记录和撤销工具。角色/DIY 的旧写入入口也走同一管线；版本或快照变化时拒绝覆盖，目标数据、修改记录和原角色卡版本备份用 IndexedDB 事务一起提交。记录最多 20 项/8MB，两个助手入口均可直接打开记录。
- 读取真实图标、位置、Dock、文件夹、组件源码与配置；支持保留原图标的整套布局调整、单实例改款、按唯一原文局部修改代码、主题外观字段与图像素材导入。改尺寸发生占位冲突时整体拒绝，保留原桌面。
- 角色读写支持 ID/唯一名字，补齐标签增删、头像、时区、微信号、卡内世界书等字段。`配角`标签的跨 APP 筛选/后台策略不在本轮。
- DIY 沙箱接入内部当前音乐状态和播放/暂停/前后曲/进度控制；挑选器和小卷预览使用同一 API，预览只读音乐，真实控制在桌面实例执行。补上 iframe 来源校验、请求超时与错误诊断。
- 范围、接口、验证与限制见 [小卷编辑架构](mascot-editing.md)。仅宿主更新，无云函数与自定义 APP ZIP 变更。

### 挂念整体复查 R1–R3 修复（2026-09-07，本地未发布）

- 宿主 IndexedDB 版本 2 增加与气泡同事务保存的收取凭据；确认重试不再写回旧缓存，跨页编辑、删除整轮及空正文处理保持幂等。旧已落盘批次可补凭据，现实桥固定 ID 输入重试同样保留已保存的编辑。
- 镜像支持 `chat-mirror-batches` 能力：读取本机完整已提交批次，在现有镜像表保存原子快照，支持编辑和空快照删除；云端独立查询整轮，避免上传/查询窗口截断导致事实缺失。移除旧镜像仅按补收时间排除新发言的逻辑。
- 无个人云 SQL 或挂念 ZIP 变更，仍使用 0.9.27 与 schema 12；更新宿主和三个个人云函数后生效，静态缓存 v25。相关回归、升级及故障注入记录见 `docs/archive/gua-nian/gua-nian-integrated-fix-2026-09-07.md`，其中包含原审计 29 项覆盖表和待实测项。


### 小卷 DIY 预览弹窗修复（2026-09-07）

- DIY 预览的监听器、状态与弹窗统一移入始终挂载的 `MascotPreviewHost`，修复全屏 AI 助手聊天时桌宠收起、工具报告“已弹出”却没有渲染弹窗的问题。与线上状态栏预览互斥显示，关闭后可以重新预览；保留原尺寸和 iframe 沙箱。
- 专项验证：`node scripts/check-mascot-preview.mjs`，仅打包小型 React 测试页面并用 Chromium 验证收起场景的可见弹窗、HTML、关闭/重开、两种预览切换和卸载清理，不运行 Next.js 全量构建。尚未做 iPhone 实机验证。
- 仅需更新宿主，无云函数或安装包变更。


### 预设一键补齐功能条目（2026-09-07）

- 预设详情的条目列表上方新增「一键补齐功能条目」，用户点击后只为当前预设补齐 `PATCHABLE_PROMPT_IDS` 必要入口清单中的缺项，目前为单聊、群聊 APP 实时状态。旧自创、新建、导入及内置预设均可使用；不自动批量修改其他预设。
- 保留原有内容、排序及关闭状态；识别改名后手动写入 `{{customAppContext}}` 的同场景条目，避免重复注入。新入口追加在原有条目之后，兼容没有顺序表、条目未列入顺序表和残留关闭记录的旧预设。以后增加必要入口时维护同一份清单。
- 专项验证：`node scripts/check-preset-feature-repair.mjs`。

### 挂念调度四项修复（0.9.25 / schema 12，本地未发布）

角色发言仅在有约定线索时核对账本，不触发普通聊天起念；用户新消息、自发起念和约定分别过门禁。普通配额和间隔排除约定与被动回复，间隔等待直接排至下一次允许时间。复核与投递异常退避并在 6 次失败后停止，界面提供显式重试，保留已有成文。schema 12 引入计划 state_version、重试元数据、原子上传和提交后撤旧触发器，云端和手机基于已读版本写回；裁决 ACK 不使手机版本失效。APP 恢复被确认删除或改期的普通时刻，UI 配额与规则一致。

公开安装包 `public/custom-apps/gua-nian-0.9.25.zip`；先更新宿主、完整执行 schema 12 和更新三个个人云函数，再升级 ZIP。多页面消费与设备接管不在本轮。验证见 `docs/archive/gua-nian/gua-nian-scheduler-repair-2026-09-07.md`。


### 云端消息接续、补收和历史修复（2026-09-07，本地未发布）

- 云端回箱只按确切 outbox 批次去重，移除 `armAt`、follow-up 次数和同批 `trigger_key` 的误丢判断。延后回复回执保留实际处理的用户消息 ID；旧轮次完成时，尚未处理的新消息进入具有独立任务 ID 的下一轮。
- 前台每 20 秒检查个人回箱，启动、回前台、恢复联网立即检查；读回箱不再依赖通知订阅，请求有 15 秒超时，事件合并保留强制补拉意图。后台系统冻结期间不承诺执行页面轮询。
- 云端成文后先加密保存回复和生成时间，租约、计划读取或回箱写入失败时恢复投递；新任务克隆模板时清除旧回复，保存模板不夹带本轮临时历史。外部动作执行结果不明时停止自动重放并保留回复。
- 历史优先使用明确批次编号；旧镜像仅在收取时间附近完整、连续且唯一匹配时合并。生成器只追加一份云端历史，统一使用角色日计划时区或宿主上传时区。公开云函数副本已重建，SW 缓存版本升至 v21。

验证与尚存边界见 [修复记录](archive/gua-nian/cloud-message-repair-2026-09-07.md)。本次不增加挂念 APP 版本，宿主与个人云函数需分别更新后才生效。


### 挂念约定修复（0.9.24，本地未发布）

安装包提供于 `public/custom-apps/gua-nian-0.9.24.zip`，网站发布后使用 `/custom-apps/gua-nian-0.9.24.zip` 下载。ZIP 内 5 个文件已与当前 APP 文件逐字节核对；旧归档保留。下载后直接升级，不卸载旧 APP；仍需先更新宿主和个人云。

修复空 sessionId 导致复核失败、过点预约低于宿主下限。云端复核开启时约定由云端统一预约，手动账本操作先合并最新状态，改期导入撤销旧本地登记并支持失败重试。schema 11 新增事件版本保护和原子撤旧触发器，跨天保留同一任务，旧上传不能回退版本或复活已完成事件；生成器识别孤儿与同事件重复输出。需要重新执行最新 schema 11 并更新网关和两个 worker，APP 用 promise-tasks-v2 核对能力。具体边界见挂念 README 与 ARCHITECTURE；其他审计项未全部处理。


### 云端补收保留消息生成时间（2026-09-07）

- 普通个人云 outbox 回复沿用云端 `created_at`，多气泡按毫秒递增；补收时按原时间重排会话并刷新预览，避免 16:09、17:14 生成的两轮回复在 18:52 打开手机后全部显示为 18:52。缺失或无效的旧时间字段沿用本地时间兜底。
- 仅需发布宿主，不修改挂念预约、云函数或 SQL；已确认消费并写入本地的旧消息不会自动回填时间。本地专项验证覆盖两轮补收、夹有新消息时的顺序、落盘后重载和确认失败重试。

### 拾光独立 APP（2026-09-07，2.0）

- 2.1.1（2026-09-09）改善关键词覆盖与本地召回：整理提示词要求具体名称、简短叫法及摘要细节，落库去重复、过滤独立泛词；检索分为完整关键词、标题/关键词分词、摘要/后续分词三档，旧记录无需重跑模型。保留原预算、优先携带、约定日期和删除保护。新增 `check-shiguang-recall.mjs` 正反例并接入拾光专项；没有引入向量服务或额外 API 调用。

- 2.1.0（2026-09-09）普通文字私聊改为当轮召回：宿主新增通用 `extensions.prompt.contextProvider` / `chat.registerContextProvider`，通过现有 iframe handler 通道等待 APP 返回本次记忆，默认最多 2000ms。请求结果覆盖本轮该 APP 的状态，不写共享缓存；无命中/关闭/失败/超时省略，其他 APP 内容保留。拾光只读最新设置与记录、沿用现有预算和关键词规则，不调模型、不运行整理。APP 未打开时可后台执行；群聊、追发、线下模式、云端主动消息沿用原路径。需同步更新宿主和拾光 2.1.0，旧数据无需迁移。验证入口见拾光架构说明。

- 2.0.3 修复同文注入不续期：`syncContext` 每次同步都写 `chat.setContext`，避免跨天或超过宿主 6 小时过期后，即使继续收到事件也因文本相同而一直漏掉记忆。专项脚本 `check-shiguang-context.mjs` 使用真实宿主状态格式化器验证过期后恢复、跨天刷新、角色隔离和关闭撤销，已接入 `check:shiguang-app`；首轮事件时序边界保持不变。
- `custom-apps/shiguang` 是真正的独立 APP：记录存在 APP 自己的 db，整理（`ai.chat`）、回忆选取、注入（`chat.setContext`）、自动触发（`chat.message.created` 后台事件）全在 APP 内。目录结构与挂念一致（`src/domain/*.mjs` 纯函数 + 闭包模块 + `bundle.json`），`scripts/build-shiguang.mjs` 合成单文件。架构与关键决定见 `custom-apps/shiguang/ARCHITECTURE.md`。
- 宿主删除了整个拾光管线：`lib/shiguang-summarizer.ts`、`lib/shiguang-domain.ts`、`memory-service` 的注入、`memory-summarizer` / `follow-up-service` 的触发、`memory-storage` 的编辑与水位函数、运行器里的六个专属 bridge 动作及 `memory.writeShiguang` / `memory.organizeShiguang` 权限。只保留只读的 `memory.readShiguang`（`lib/shiguang-app-api.ts`），供 APP 第一次打开时把 2.0 之前存在记忆库里的旧记录搬走。`lib/shiguang-types.ts` 与 `MemoryEntry.type = "shiguang"` 保留，旧数据仍可备份恢复。
- 记忆库的「拾光」标签与设置区只剩打开 APP 的入口（`components/memory/shiguang-panel.tsx`），不再统计拾光条数。
- 校验：`check:shiguang-app`（Node，领域层 + 产物一致 + manifest，已接入 `check-fork-regressions`）、`shiguang:browser`（Chromium 端到端，宿主 SDK 用内存假实现）。旧的 `check-shiguang*.mjs` 与 fixtures 删除。
- 已知边界：注入按最近八句在消息入库后重算，作用于下一轮；`db.list` 单表 500 行上限。

### 正则按历史发送者筛选与空消息过滤（2026-09-07）

- 正则新增 `historyRole`（用户/角色，省略为原有全部发送者行为），管理页可直接选择「仅用户消息」。按消息原始 role 匹配，单聊、群聊、线上和线下共用；用户文字中出现 XML 不影响识别，无标签角色回复也不会误删。选择发送者会启用仅历史、仅 Prompt 和输入处理；深度计数方式不变。
- `buildProviderRequest` 在三种模型格式转换前移除空白纯文本消息与空 text part，不写占位符、不改本地记录；保留图片、原生工具调用和工具结果。请求、日志、提示词查看器以及新生成的云端请求快照使用同一过滤结果，避免空 user 的 400。
- 正则整组/单条导入及 AI 助手读写保留发送者条件；旧规则未设此条件时行为不变。整组导入同时补齐原先遗漏的 historyOnly 字段。仅需发布宿主，无云函数或 SQL 变更；已上传的旧请求快照需重新生成。

### 忙碌回复允许角色选择沉默（2026-09-07）

- `busy-reply` 1.1.0 新增默认开启的「允许角色选择不回复」：由当前回复模型结合人设、关系、情绪、剧情与整段待回应消息判断；支持不想回答、独处、争执、错过回应时机等情境，不使用随机漏回。总开关或此开关关闭即恢复普通回复；紧急优先开启时按现有紧急词保护整段待回应输入。
- 宿主只提供 `prompt.system.replyText/allowSilence` 与显式 `[本轮不回复]` 协议，情境规则属于插件。沉默是成功结束：前台、后台、流式与原生工具通道不生成气泡、不安排追问，也不会因最后一条仍是用户消息而自动重试；新消息会重新判断。调用模型仍计入用量。群聊、通话、线下剧情、自定义 APP 任务和主动追问不注入此规则。
- 延后回复和普通回复兜底快照携带沉默授权；个人云完成任务但不写 outbox、不发通知、不补回。共享协议由 `push:build-dist` 注入 worker 并由 `check:push` 校验。旧云函数不接收沉默快照：等待留在本地，普通回复的离线兜底暂不挂单。
- 需配套更新宿主、插件、个人云网关与 `push-generate`，无 SQL 迁移。插件产物和 SW 缓存同步更新；`npm run check:chat-silence` 覆盖实际回复循环、流式片段、插件规则、云端任务及旧版本保护。手机端和真实模型的情境表现仍需体验验证。

### 忙碌回复迁为聊天插件（2026-09-07）

- 新增官方 `busy-reply` 插件，将被动回复的等待、概率、睡眠和紧急优先设置移出挂念。挂念 0.9.21 仅发布 source-only 作息和一次性迁移种子；主动消息的忙与睡保持独立。首次安装导入旧配置，随后 APP 不覆盖插件编辑。
- 新增同步 `chat.replyGate` 扩展点和原始/有效 gate 的分离；源数据仍服务在线状态，停用插件不复活旧规则。手动 presenceOverride 无需挂念，按绝对时间到期，跨午夜不续期。
- 启动/重载完成后才判定和冻结规则。插件或手动状态变化同步未执行云端任务，关闭规则立即释放等待；已生成中的请求不重建。需新宿主、插件、网关和 push-generate，无新 SQL。
- 新集成回归覆盖迁移、关闭/零值、设置隔离、手动状态与云端释放；更新插件产物生成和 SW 缓存版本。

### 延后回复复用个人离线通道（2026-09-07）

- 挂念 0.9.20：进入等待时上传完整加密请求和绝对时间作息；确认后关闭小手机仍能等待、概率偷空并回复，沿用既有云端生成、通知和 outbox 回填。每分钟扫描可能带来延迟。
- 新增 `deferred-reply-cloud.ts`、共享 `deferred-reply-timing.ts` 和网关 `deferred-reply` 动作。上传后由云端单独执行；消息/API/绑定/预设/闸门变化更新 pending 快照，保留下一检查时间。running 请求保持原快照，离线期间使用最后成功上传的数据。
- 条件更新与认领、单调版本、取消墓碑和项目绑定防止重复执行及迟到上传恢复任务；上传响应丢失只重试同一键。新任务完成、失败、取消后清除请求凭据，能力缺失回退本地并提示。
- 新集成测试覆盖实际客户端到云端入口与模型/outbox。需更新宿主、网关和 push-generate，无新 SQL；同包精力修复仍需更新 push-recheck。未做手机端关闭 APP 的实测。

### 忙碌回复按日程找空档（2026-09-07）

- 挂念 0.9.19 新增「根据日程找空档」开关，默认开启；宿主从标题识别会议/上课/驾驶等专注事项，按设置间隔检查、默认每次 25% 概率偷空回，没有细排也适用。进入明确休息可回，一直未命中则忙完正常回；概率可调 0–100，0 只等休息/结束后缓冲，100 首次检查时回。重复发送不加抽，关闭期间不补抽。普通事务仍按等待分钟数回复；关闭开关、0 分钟与紧急词保持原约定，不增加模型调用。
- `lib/chat-reply-gate.ts` 新增可选 adaptive / focusedPeekProb / breaks 数据及延迟记录上下文，到点核对活动变化、错过休息与睡眠接续。`chat-room.tsx` 合并等待期间发送，含已到点未领取的间隙；生成中不追加等待。`check-reply-gate.mjs` 覆盖实际入口与打包 APP 接线。本地等待在关闭后需重新打开；0.9.20 已增加可确认的个人云接管（见上节）。
- 需要宿主与 APP 同时更新；和同包精力修复所需的云函数更新分开说明。聊天页已有 lint 问题不纳入本次修复。

### 挂念细排与精力尺度（2026-09-07）

- APP 0.9.17 为整天生成、单条重写和细排拆分预设标签。细排仅保存时段内的 steps；详情的预计精力改取结束时刻，修正之前拿开始时刻冒充“做完之后”的显示。
- 日程单项变化从 ±40 收紧到 ±15，身体状况负向合计上限从 25 降到 12；新生成身体状况每条 ±8。新提示建议正常起床基线 70–90、普通会议/工作消耗 3–8，避免情绪低落与身体不适重复扣减。旧日程读取也应用单项上限，保留已有基线和历史原文。
- 本机、push-recheck、push-generate 同步计算规则，新增实际产物及云函数回归；云函数公开副本重新生成，SW 缓存升级到 v15。交付需安装 APP 并更新两个云函数，无 SQL 迁移；未自动操作用户手机或个人云。

### 提示词查看器补全缓存预设（2026-09-06）

- `lib/llm-provider-adapter.ts`：Anthropic 开启提示缓存时，顶层 `system` 从字符串变成带 `cache_control` 的文本块数组；查看器原来只认字符串，导致预设与角色人设漏显示，列表直接从短期记忆开始。现在同时读取两种格式，按请求顺序展示完整系统文本；实际发给模型的请求不变。
- fork 回归覆盖缓存开关、普通请求、原生工具及工具流式请求、多段系统文本和空系统字段，并验证读取快照不修改请求。

### 拾光重要记忆（2026-09-05）

- 现有记忆详情页新增「拾光」标签，使用确认过的紧凑奶油纸张卡片。默认折叠，标题 17px；展开显示缘由、事件、细节、意义和后续。搜索标题/正文，支持类型多选、时间范围组合筛选，每页 20 条。原消息按引用从聊天读取，气泡最长 85%，用户右对齐、角色左对齐；原消息不可用时明确说明。
- `lib/shiguang-summarizer.ts` 为独立请求管线：默认每 20 轮私聊回复触发（5—80 轮可调，同批多个气泡只计一轮），有独立自动开关、时间水位和跨标签页锁。使用现有「记忆总结 API」绑定，但与长期记忆的事件阈值、请求和进度完全独立；长期自动总结关闭时拾光仍可自动运行。可手动「整理新消息」。普通回复、原生工具回复及追发/离线回端消息接入检查。
- 仅从尚未处理的聊天原消息提取，尊重来源开关；每批约 24,000 字的完整消息边界，同时间戳不拆分，剩余消息留到下一批。频率按私聊计数，手动整理也可处理可见群聊/线下聊天。没有重要内容允许空列表；格式错误、无效引用、截断、存储失败不推进水位。自动失败冷却 5 分钟，避免每轮重复消耗；手动可立即重试。
- 沿用现有记忆 IndexedDB，以 `type=shiguang` 保存结构化内容，不改写核心或长期记忆。事务批量写入，支持同一事件追加进展；用户编辑的正文优先保留，仍可追加明确后续。删除项从界面和注入排除，保留删除标记抑制重复提取；没有归档流程。记忆备份包含拾光及独立进度。长期条目上限清理只处理 `long_term`，防止误删核心/拾光。
- `memory-service` 在既有记忆注入入口加入拾光：本地关键词/词组及临近日期召回，不额外请求模型或向量 API；持续重要信息优先，默认独立预算 800 Token（可调）。按完整信息选取，过长条目不会挡住其他较短记录；明确标记最新进展，抑制与已选记忆的完全重复。卡片不展示模型用的精简内容。语义相近但措辞不同的匹配/合并仍取决于提取质量与本地检索，不能保证全量语义去重。
- `scripts/check-shiguang.mjs` 接入 fork 回归，覆盖独立频率/进度、来源引用、幂等更新、用户编辑与删除保护、预算及角色隔离。`node scripts/check-shiguang-browser.mjs` 只打包实际组件做轻量浏览器验证，覆盖 IndexedDB、筛选、分页、编辑删除、手机气泡对齐及深色主题；不运行 Next 全量构建、不调用真实模型。核心提示词建议另存 `docs/shiguang-core-memory-prompt.txt`，不会覆盖用户现有自定义提示词。静态缓存版本 v14。

### 离线主动消息的插件处理（2026-09-05）

- 好感插件升级为 `1.6.0`：气泡旁小爱心切换消息下方的奶油色便利贴卡片，沿用内置卡片的胶带、正文与落款样式。宿主新增通用 `message.panel` 插槽，插件负责展开状态和内容；原有 `message.footer` 不变。
- 卡片明确区分模型给出 0、没写变化量、每日/单轮上限及数值边界。兼容“好感度”、全角加减号和 Unicode 减号；保留用户涨跌配置。满 100 时按实际增量记账，避免显示虚增或占用每日上涨额度；旧记录不追溯重算。
- 已运行实际插件的浏览器卡片预览及展开/切换检查，并测试 9 种好感结算边界。发布副本由 `plugins:build-dist` 生成，SW 缓存升级到 v13，保证插件脚本刷新。
- 40 项 fork 回归与插件专项检查通过。聊天页全文件 lint 仍有原有的 40 个错误、30 个警告；与修改前逐项对照无新增，其余本次修改文件无 lint 错误。本机未运行 Next.js 全量构建。
- `lib/push-outbox-client.ts`：离线回传先等待聊天插件启动，再依次执行 `llm.response`、输出正则和消息解析，普通主动消息与现实桥回复共用处理。此前跳过回复钩子，好感插件输出的 `[内心]` 被内置面板解析，好感也没有结算；本次不改用户的状态栏开关。
- 回传使用固定消息批次 ID，确认请求失败后再次拉取已落库消息时，不重复运行插件或增加好感。
- `node scripts/check-push-outbox-plugins.mjs` 使用实际好感插件与消息解析器验证冷启动等待、多气泡归属、好感结算、重复投递和禁用插件；已接入 fork 回归脚本。未做 iPhone 真机验证。
- 通知头像旧代码仍在。iPhone 主屏幕 Web App 忽略通知的自定义 `icon`，仍显示安装时的 App 图标；[WebKit 问题 280162](https://bugs.webkit.org/show_bug.cgi?id=280162) 当前未解决。本次没有把网页头像缓存调整当作 iOS 系统通知头像修复。

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
   - `232b863` 曾新增第二台设备接入已有个人云的独立入口；现移除该重复入口及专用表单状态、处理函数，统一使用上游「连接已有云服务」连接云备份并探测推送、微信服务。已有连接配置与云端数据保留。
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
- `37ec2ed` 桌面：拖图标到别的页放不下（翻页动画中途按页缓存到滑动中的网格矩形）——改成拖起时量一次全程复用；边缘区 48px、连翻 200ms、末页已空不再新开、翻页瞬间页码圆点回弹
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

复查修补（第二轮报告三项）：
1. 「已发」凭据改成 `push_jobs` 的执行结果（`timedwake:<wakeId>` 的 `result_note` 以 generated / sent 开头），
   云端回音账与 App `settleFired` 都不再拿邻近聊天冒充；没配云的本地预约才退回看聊天记录
2. 设备锁任期号 `context.ownerSeq`：换人 / 接管 +1；普通上传带着走，库里是别台的锁或任期号更旧就拒 409 `taken`，
   App 收到就记下新持有者停手。老版 App 不寄任期号时只按名字校验
3. 回执改走 SQL 函数 `push_recheck_ack_decisions` 原子过滤 `at <= before`；函数不存在（404）退回读-过滤-写。
   **要在 Supabase 重跑一遍 schema**

### 复审修复：外部请求与预约结算（挂念 0.9.12）

- `lib/server/safe-outbound-fetch.ts`：fetch 与 Agent 统一来自 npm Undici；DNS lookup 支持 `all: true` 和指定地址族，保留公网地址校验。
- `push-recheck`：回音账等到实际成功发送满 3 小时再结算，镜像查询失败保留重试。
- `ai-phone-push` 的 jobs GET 支持 `triggerKeys` 精确批量查询（每批最多 20 个），响应回显查询键；挂念按此结算，不再把最近 20 条诊断记录当作完整执行记录。
- 网关未更新或暂未查到任务时，不永久标记结算完成。设备锁并发覆盖问题按本轮约定暂缓。
- 发布需更新宿主、重部署网关和 push-recheck、导入挂念 0.9.12；无新增数据库迁移。
- 验证：`node scripts/check-fork-regressions.mjs` 覆盖请求兼容、DNS 多地址、实际发送后的回应窗口、精确查询和旧网关兼容。

### 挂念源码分文件维护

- `custom-apps/gua-nian/src/`：页面模板、CSS 和 23 个按职责组织的 JS 文件，仍共享原来的闭包和初始化顺序；不是独立 ES modules。
- `scripts/build-gua-nian.mjs`：合成单入口 HTML、检查源码/产物一致性、打包安装 zip。宿主构建和 fork 回归已接入。
- `custom-apps/gua-nian/ARCHITECTURE.md`：文件导航、主要依赖、编辑和打包方式。
- 首次拆分前后 HTML 逐字节一致，保留 0.9.12 的修复与安装方式，不额外升版本。

### 挂念小范围独立模块重构

- `src/domain/time.mjs` 与 `scoring.mjs` 使用 ESM 导出和独立作用域；日期、设置、当前时间通过参数传入，旧调用位置保留薄封装。
- 时间边界、评分权重、未回应分轮规则保持原样；三个时区与旧实现对照结果一致。
- 构建使用已有 TypeScript 编译器把两个模块内联进各自作用域，安装包仍只有单个 HTML 入口。
- `npm run gua-nian:test` 验证跨零点、夏令时、评分约束、模块独立导入和产物接线；设备锁与其他业务模块不在此次重构范围。


### 挂念发送回执与同步反馈（0.9.13）

- 详情和记录页用精确预约回执判断发送结果；普通聊天不再充当发送证据。无可靠回执显示待确认，取消聊天推断的回复率，详情可刷新回执。
- 计划上传返回成功、失败、部分同步、只读等结果，保存设置分别报告本地保存和云端计划同步。跨页签提示保留失败原因与重试入口，状态按角色、日期与云地址保存。
- 同角色上传串行化；重试先成功读取并合并云端裁决，再上传现有计划，避免读失败时覆盖云端新增预约。短请求 15 秒超时，不重新编排或改设备锁协议。
- 增加 `scripts/check-gua-nian-delivery.mjs`，接入 `npm run gua-nian:test`。安装包升为 0.9.13，继续使用已在 0.9.12 修复中的精确查询网关，无新增数据库迁移。


### 挂念设置生效说明与中性回音（继续完善 0.9.13）

- 修正「保存还要重置才能上传」的旧说明。保存会上传现有计划的上下文，但不会重建已有预约；根据本次变更明确提示重新编排、冻结的降速阈值、模式切换及明日生成原料的生效范围。
- 云端回音权重不再按回复率扣分；未回应保持中性，已有历史未回应也不再造成负权重。累计至少 3 次后续接话才有有限正向加权，最高 1.20；提示词不把用户忙碌、睡眠或未读造成的沉默解释为不喜欢。
- 诊断页同步展示正向参考和中性状态，原有未回应降速仍用于避免连续打扰。需要重部署 push-recheck，无新增 schema。
- 验证：设置保存范围、已有预约保持、失败提示并存、沉默不扣分、历史数据兼容及本地/云端公式一致性。本轮仅更新源码和生成的 HTML/云函数副本，未重新生成 zip。


### 挂念可选用户睡眠时段（默认关闭）

- 新增独立的用户睡眠开关和起止时间，只暂停回音统计等待时长，不依赖角色作息、不要求手动忙碌操作，保留未回复中性规则。
- App 上传 IANA 时区和 UTC 偏移，网关显式接收；push-recheck 累计 3 小时非睡眠时间后统计，支持跨零点及夏令时，尚未结束的窗口不提前结算。
- 今天的统计接上昨晚未完成的回音并去重；昨天的计划不恢复起念，读取失败继续保留重试。
- 更新设置说明、诊断页及回归检查。生效需重部署网关和 push-recheck，无新增数据库迁移；本轮未打包、提交或部署。


### 挂念与个人云联通修复（schema 8，随 0.9.14 发布）

- 普通保存也先成功读取、合并云端裁决再上传；读取失败保留本地设置和重试状态，避免旧计划覆盖云端新增预约。
- 云端复核开关新增实际确认：网关探测 worker 能力，调用数据库函数只改今天和未来已寄存计划的开关，保留回音、生成原料与已有预约；关闭失败仍显示重试，重新开启失败不遗失控制操作。
- 睡眠选项同时核对实际运行的 worker 能力及网关保存回显，旧版云函数不再被当成同步成功；应用和网关按记录内容合并最多 60 条回音去重键。
- 新增 `push_recheck_set_enabled`，schema 升为 8；上线须更新数据库 schema、离线推送网关和 push-recheck。生成副本同步更新，未打包、提交、推送或部署。
- 验证覆盖普通保存失败/成功合并、停用失败后重试、重新开启、旧云函数兼容、字段回显及满容量回音去重；数据库函数在隔离 PostgreSQL 17 中验证开关往返、角色/日期隔离、保留其他字段及访问权限。


### 聊天镜像超时与暂停期间的变更（随 0.9.14 宿主发布）

- 镜像能力探测、上传、清空均使用 15 秒超时，覆盖响应正文读取；超时中止客户端请求并保留待传操作，释放共享上传任务供重试。迟到的响应不确认新编辑的队列版本。
- 曾开启镜像后，暂停期间的编辑、删除和整批重生成只在本地排队，重新开启后同步；个人云暂未激活时，已开启镜像的新消息也保留在队列。未曾开启镜像的用户不记录这些操作。
- 重新开启和启动时按本地原件校正已有队列，不局限于最近 200 条回填；原件已删除则改为删除操作。聊天数据尚未加载时禁止上传或把空缓存当成删除，加载恢复后再校正。
- 历史回填不挤掉已有的待传删除和编辑。仍沿用最多 5000 条待传记录、20 个会话各 200 条历史回填；无法追溯恢复旧版本已经漏记且不在队列中的删除操作。
- 新增回归覆盖超时四阶段、迟到响应、暂停期间编辑/删除/重生成、旧队列校正、数据未加载和默认不开启。仅改宿主源码，无新增 schema 或云函数改动；未打包、提交、推送或部署。


### 挂念 0.9.14 发布汇总

- 0.9.14 安装包统一包含上述模块拆分、发送回执、同步状态、中性回音、可选睡眠及云端联通修复；宿主同时包含聊天镜像修复。上文“未打包/未提交”的描述记录各次本地修复阶段，本次统一发布。
- 导入预设时，将未校验的参数数组明确标为 unknown[] 后经过现有类型守卫过滤，修正阻断生产构建的 TypeScript 推断错误，不改变筛选和去重行为。
- 安装前需更新个人云 schema 8、离线推送网关和 push-recheck；推送宿主不会自动更新用户自己的 Supabase。设备接管并发问题仍按约定暂缓。


### 朋友圈重复发布、草稿外露与挂念记录缺失（0.9.15）

- 修复 moments-engine 把本轮朋友圈先交给通用动作分发、再用剩余草稿发帖的问题。现在同轮只发布一条完整标签正文，返回真实帖子编号；其他类型跨入口动作保留，思考标签区和未标记草稿不作为正文发布。
- 自定义 APP 可传 requestId，宿主按 APP 和角色隔离并保存到 MomentPost；相同请求重试返回原帖子编号。
- 挂念发布前重新校验最小间隔、周额度；云端积压仅保留最新起意，其余记录合并未发布。用实际时间发布，云端的预留起意计数不再冒充实际成功数量。
- “记录”页新增持久发圈记录，区分已发布、等待、失败、未发布，保存帖子编号。成功记录与周计数一并保存；跨日不依赖旧计划去重，运行日志不再是唯一线索。历史旧帖无法据此自动补认来源。
- 回归覆盖真实宿主生成入口与通用动作解析、草稿/多块输出、同请求重试、积压/配额、失败及记录展示。本次随 0.9.15 统一发布，需要更新宿主和 APP；无需新增 schema 或云函数更新。


### 挂念记录页发圈布局调整（待发布）

朋友圈记录归入对应日期卡片，放在私聊记录后，默认折叠显示条数。只有发圈、没有当天计划的日期也会显示；无发圈记录时不显示空板块。保留原有发布状态、帖子编号与去重逻辑。


### 挂念本机复核重复调用与预设冲突（待发布）

- 打开与定时复核共用持久化的 `recheckAttemptAt` 间隔，先保存尝试时间再调用模型；保存失败不调用，回复后处理失败也不在间隔内重判。成功时间仍独立保存在 `recheckAt`，未完成的聊天到期可以重试。无须模型的未回应降速继续立即执行。
- 复核锁通过 finally 释放，上下文同步失败不再永久占锁；日志标明本机触发来源，并明确处理失败可能已有部分改动落库。
- 起意预设删除过时的 decisions-only 示例，以当前任务的完整字段为准；无候选消息时刻不再误称生活日程已全部结束。JSON 代码块兼容与解析失败后的一次显式格式重试保留。
- 新增回归复现旧代码在处理失败后连调两次，覆盖重新打开、到期重试、新消息间隔、无新消息、并发入口、代码块和同步异常。上述间隔限定本机自动复核，不声称解决跨设备或云端与本机并发；本次未修改宿主和云函数，尚未打包、推送或安装验证。


### 挂念整体审阅 P1 修复（待发布）

- A：自动复核改为严格读取云端，失败不调用模型、不回写旧计划；手动日程编辑共用严格同步入口，复核内部编辑由外层统一提交。
- B：本地模型了结惦记时先撤关联待发预约，再保存计划和账本；复核暂存 items 同步更新，不在末尾恢复已撤项。撤销/保存失败保留原编号和未了结状态以便重试。
- C：云端接管持久保存 cloudAdopting 阶段标记，plan 写入失败后可续接；兼容旧版已写 cloud day、未写 plan 的情况。完成接管后清标记，分钟循环补齐中断接管。
- H：关闭 autoGen 或 cloudGen 时通过 generation-stop 停用今天及未来尚未执行的生成原料；只改 genEnabled 与版本时间，不删已生成日程、已有预约或复核设置。停用失败独立持久展示，提供重试按钮，重开时继续确认。worker 在生成前后检查停用状态，最终写回保留原有版本保护。
- 新增 push_recheck_stop_generation RPC，个人云 schema 升至 9；gateway 探测实际 worker 的 generation-stop-v1 能力，原子停用后再次读取验证。需更新 APP、个人云数据库、网关及 push-recheck 才能全部生效。
- 新增 11 项 P1 回归并接入 gua-nian:test，涵盖读取失败、关联撤销及保存失败、接管续接、旧版半成品、停用持久重试、模型在途停用和网关拒绝旧能力/旧 schema/确认不一致。尚未打包、提交、推送或真实个人云验证；P2 六项继续待处理。


### 挂念六项 P2 修复（本地待发布，2026-09-05）

- 预约接管与往返上传保留惦记关联、有效期和顺延信息；单条日程重写保留其他属性，移动开始时间同步移动结束时间。
- 本机及云端尊重明确的闲状态；未标注 busy 才按旧标题规则推断。
- 用量失败显示未知/上次成功数据，支持立即刷新；限额开启且合计未确认时暂停本机新调用。
- 本机与云端共享原子判断租约和已处理聊天游标，完成回执可恢复，避免同段聊天重复复核；schema 升到 10，不改变设备接管锁。
- 云端使用包含人设、世界书与起意预设的专用判断快照；daily/impulse 预设结构跟随具体任务，朋友圈成文管线保持原路径。

验证：18 项 P2 回归、11 项 P1 回归、28 项投递/同步回归、40 项 fork 回归及三个时区领域测试；另有 PostgreSQL WASM 实际执行的 19 项判断租约断言。相关部署副本重新生成并校验。本批尚未打包、提交、推送或部署，未调用真实模型或个人云。


### 挂念 0.9.16 发布汇总

0.9.16 统一包含此前待发布的记录页布局、复核间隔与预设修复、4 项 P1 和 6 项 P2 修复。上文“待发布/未打包”记录各次修改阶段，以本节为本次发布范围。个人云升级到 schema 10，并更新网关、push-recheck、push-generate；安装包直接升级保留数据。暂缓的设备接管锁不在本次范围。


### 朋友圈个人主页 + 个性签名插件（2026-09-05）

- 动态里点头像或名字进入那个人的主页（`components/chat/moment-profile-page.tsx`）：封面（按角色各存一张，点封面换；没设就用头像放大糊一层）、头像、名字、动态数、签名，下面只列TA自己的动态，评论/回复/删除照走动态页那套。你自己的主页复用动态页原来的封面和签名。
- 签名不取角色卡描述，由官方插件 `chat-plugins/profile-signature.js` 让TA自己写：回消息时小概率在末尾附 `[签名]xxx`，截下来存变量池 `profile`（scope character），主页监听变量变化实时刷新。主页上点签名可以替TA改。提示词走插件 `prompt.system` 的 hint 通道，不需要改预设。
- 另：GPT 的 `1c2e75e` 修了聊天镜像队列按 id 压缩、延后回复重试和世界书导入导出。


### 小卷「聊天插件套件」（2026-09-06）

- 小卷新增第 11 套工具 `chat_plugin_pack`：读取插件规格 / 列出插件 / 读取插件 / 安装插件 / 更新插件 / 启停插件（执行器 `lib/chat-plugin-mascot-tools.ts`，规范 `CHAT_PLUGIN_PROMPT`）。照独家特调套件的样子做：先读规格再写，没有卸载工具。
- 规范里写死能力边界：只能用宿主已开的钩子，落不进去时如实说"要宿主加钩子"并给具体的点名/时机/payload 建议，不许编钩子名。官方插件（index.json 里的 id）拒绝安装/更新，防止被自动升级覆盖；想改就换 id 装副本。
- 上游同日合入（`96492ab`）：机括 rawReply / lastReply 钩子、核对材料、旧轮次懒加载、线下摘要自动补提开关。`docs/mixology-supabase.sql` 的 kind 约束补了 preface，已建过表的 Supabase 要手动 ALTER。


### 钩子 `message.beforeReveal` + 官方插件「打字节奏」（2026-09-06）

- 宿主原来有一段写死的节奏：一轮回复切成多条气泡后，关流式时第二条起各等 800ms 再放出，开流式则一次放完，插件碰不到。现在这段改走新 transform 点 `message.beforeReveal`（`components/chat/chat-room.tsx` 的 `paceBubbleReveal`，五处放出路径都过它：单聊 `splitAndSaveAIMessages`、群聊 `processGroupParts` 的正文/拍一拍/群管理通知、群聊流式 `onTextPart`）。payload 带会话/角色/批次 id、序号与总数、内容、`streamed`；插件改 `delayMs`（上限 120 秒）宿主去等，`cancelled=true` 这条不展示不落库。默认值等于原行为，没装插件零变化。等待期间 `isGenerating` 仍为 true，顶部「对方正在输入」一直显示。
- `chat-plugins/typing-rhythm.js`：每条等待 = 去空白字数 ÷ 每秒字数 × 随机浮动，夹在最短/最长之间；表情图片固定时长；第一条可单独设；开了流式是否照样按节奏、群聊是否生效都是开关。只改 delayMs，不 sleep（会撞 8 秒 transform 超时）。
- 小卷的插件规范加了一条：做"一句句慢慢发"用这个钩子，不要在处理函数里 sleep；用户只想调速度就让 ta 改插件设置。


### 会话列表未读角标（2026-09-06）

- `ChatSession.unreadCount` 字段一直存在但从没人加过。现在 `pushChatMessage` / `upsertImportedChatMessage` 落库角色消息（role=assistant 且能进列表预览的）时 +1 并广播 `chat-unread-updated`；聊天页可见时（挂载、visibilitychange、focus、本会话有新消息落库）调 `markChatSessionRead` 清零。后台生成、离线推送、镜像同步进来的消息在页面不可见时才会累计。
- 列表头像右上角红色数字（`.chat-unread-badge`，99+ 封顶），免打扰会话只给红点（`.chat-unread-dot`）。角标放在头像外层的 relative 容器里，避免被群头像的 overflow-hidden 裁掉。`getTotalChatUnread()` 备着给桌面图标用，还没接。


### 离线回传持久化、KV 迁移重试与代理超时（2026-09-06，本地待发布）

- 离线普通回复与现实桥回复使用显式消息批次：先准备气泡，再将整批消息、所属会话及红包/转账等消息状态更新放入同一 IndexedDB 事务；提交成功后才更新聊天缓存、发布事件和确认云端消费。失败不会留下半批气泡作为去重依据，云端条目保持待消费。桥输入同样等待落盘；已有内存去重命中也要经过持久化确认。纯来电、快捷动作提示沿用同一回传批次编号，回执失败后重拉不重复插入。
- 同页写盘重试复用准备好的气泡 ID 和插件输出，避免再次执行回复变换及落库前插件。确认成功后释放重试缓存。插件自己的 KV 状态和购物等非聊天数据仍属于原有独立存储，不声称提供跨数据库、跨页面崩溃的插件事务；不能自动修复旧版本已经确认或只写入一部分的历史消息。
- KV 初始化迁移每次重试都重新提交来源数据，不能因内存值相等而跳过写盘。初始化与晚注册迁移均在写入成功后按原值删除 localStorage，保留写入失败的来源，以及提交期间产生的更新值。
- 工具代理的超时覆盖响应正文、SSE 发现、消息 POST 与回复等待；后续 POST 继承同一取消信号。成功/失败统一清理计时器、SSE reader 和请求级代理连接，超时提示显示实际配置的秒数。
- 验证：`scripts/check-persistence-and-proxy.mjs` 接入 fork 回归，覆盖异常写盘、整批回滚、同页/新页重试、去重及代理全流程超时；`scripts/check-persistence-browser.mjs` 使用 Chromium 的真实 IndexedDB 和项目 Dexie 验证跨表事务回滚与迁移重试。无需更新个人云 schema 或云函数。本次仅本地修改，未提交、推送或部署；未进行手机端完整验收。

### 用量 APP 接入工坊日志（2026-09-06，本地待发布）

- 修复工坊已计入每日统计、但用量 APP 调用日志和统计卡片下钻为空的问题：宿主 `usage.readLogs` 合并普通日志与工坊日志，按时间排序后保留用户配置的最近 50–500 条，再执行筛选；详情接口可读取两个原始日志环。保留既有 `usage.read` / `usage.logs` 权限边界。
- 设置中的日志条数和体积估算使用同一合并视图。工坊原始日志仍受独立的 50 条及体积上限约束，两个原始环仍独立清空；读取不改写日志、不重复累计每日统计。已淘汰的历史明细无法从统计还原。
- 更新 SDK 制作说明，增加 `scripts/check-usage-logs.mjs` 回归，覆盖工坊 19 次和普通 9 次的混合记录、筛选、详情、权限、跨时区排序、容量及独立清空。现有用量 APP 无需重新安装；需要宿主发布后生效。本次未修改工坊 Token 采集路径，未提交、推送或部署。
- 验证：7 项日志回归及 TypeScript 检查通过；SDK 一致性无错误（保留原有 5 项提醒）；相关文件 lint 无错误、保留原有 1 项图片标签警告。未运行本机全量构建，未进行手机端验收。

### 主动等待按事实判断与非流式打字节奏（2026-09-07）

挂念 0.9.22：忙时延后，不再按 until 或最长押后强制作废；原时长设置改作等待概率的半衰期。空闲机会按等待时长衰减概率，复用成文请求核对最新聊天，已提过/已解决时作罢且不推送。心动页列表与统计使用真实回执，已过点不等于已发出。需要更新挂念包与个人云函数；历史已结束预约不重发。

宿主补齐后台回复与个人云消息接收的 message.beforeReveal 钩子，非流式同样按打字节奏设置逐条显示；个人云仍先完整原子落盘，再按间隔展示，失败不展示半批，待展示消息在重新进入聊天时隐藏。前台展示等待插件启动就绪。宿主发布即生效，插件无须重新导入。专项检查见 check:reply-delivery，原云消息持久化故障注入继续验证批次重试。


## 挂念约定任务与离线连续上下文（2026-09-07，0.9.23）

- 复用 promise 账本类别，增加角色／用户／双方归属、来源消息和事件版本；按约定时间预约，同一事件改期、取消、完成，发送进展不冒充完成。APP 时间线显示“约定”，按预约编号区分同刻事件。
- 判断与生成共享会话镜像/outbox 合并历史；新镜像传 responseBatchId 去重，读失败重试，连续多轮未被手机收取也可见。普通主动间隔取实际生成时间，发送事实独立于回音统计。
- schema 11 增加镜像批次字段、会话生成租约、原子挂约定任务与跨计划取消 RPC；提前寄存未来 31 天内任务，未执行任务的计划保留。复核扫描统一为 5 分钟，新约定可提早判断，已有总调用上限仍有效。
- 需要新版宿主、0.9.23 APP、schema 11 和网关/push-recheck/push-generate；静态缓存 v19。源码与部署副本由 push:build-dist/check:push 校验。专项覆盖真实 worker、打包 APP、PostgreSQL 事务与现有被动等待；不等同于个人云/手机实测。


### 挂念 B20 / B21 / B17（2026-09-07，0.9.26，本地未发布）

镜像上传仅在 PGRST204/42703 明确指出 response_batch_id 缺列时退回旧字段，其余错误不确认成功。云回复和现实桥输入在持久化前只给新增消息分配 order，保留旧消息 order/内容；前台静默补收按同一顺序插入，不再全量时间重排。极端旧顺序或浮点间隔耗尽时只给新批次分配末尾顺序。

挂念了结惦记通过网关 cancel-wake 核实任务：已生成记录保留，pending 按状态及 updated_at 条件撤销，执行中/暂存待投递/无法确认时保留并提示。部分成功中断也保存进度。已发记录不改作罢、不释放普通配额。本轮不新增 SQL；0.9.26 需宿主、网关发布，未装此前修复仍需 schema 12 和三个云函数。验证与边界见 docs/archive/gua-nian/gua-nian-b20-b21-b17-repair-2026-09-07.md。


### 挂念 A5 / A7 / B19（2026-09-07，0.9.27，本地未发布）

旧镜像先做全局归属匹配，含糊资料单列且不计 fresh/未回应轮数、不重复列出已知正文；保留数据库原始证据。同源回传箱以 Web Locks 覆盖解析、事务提交和 ACK；每条处理前从 IndexedDB 补齐会话缓存，已提交批次只确认，BroadcastChannel 通知其他页面更新。无共享锁支持时保留消息并暂停，不能假装页面内布尔锁能防跨页面竞争。

APP/网关传独立 tzOffsetMin；两个 worker 严格校验偏移，从有效上下文、IANA 区名或冻结请求恢复，缺失则明确停止/退避，不猜 UTC；复核临时预约不再从旧时刻反推，显式零偏移不被用量时区替换。更新需宿主、三个云函数和 ZIP，沿用 schema 12；A6、B18 不在范围。验证见 docs/archive/gua-nian/gua-nian-a5-a7-b19-repair-2026-09-07.md。


### 挂念约定证据与诊断显示（2026-09-08）

- 本机和云端的约定更新核验真实消息编号及发言人：角色的要求不能作为用户/双方约定的成立、改期或恢复证据。取消短句可触发语义复核，规则要求明确取消落入事件状态，旧同意不能恢复已关闭的同一事件；角色自身承诺仍可正常记录。发送前事实核对补充用户拒绝优先于角色坚持，取消后的跟进应作罢。
- 约定卡片显示摘要，完整执行指令留给模型；跨日时刻及云端执行回执补足日期。复核次数分母读取云端计划门禁，本机无唤醒不再误报云端未预约，无未来时刻也不再直接宣称停止复核。
- 验证：约定/历史与复核 worker 专项检查、改动文件 lint、挂念生成及云函数副本一致性。自动化使用模拟模型输出，未做真实模型或手机端验收；手机现有约定与预约未改动。随 0.9.29 安装包交付；无需 schema 迁移，使用时需更新宿主、挂念及个人云相关 worker。


### 挂念当天展示与诊断样式补齐（2026-09-08）

- 今天/心动的时刻、计数及下一次提示仅展示本地日期为当天的项目，未来约定留在账本；过滤只作用于渲染，不修改任务时间、计划原数据或云端执行。记录页的约定原文遗漏也统一改为摘要。
- 云端同步、云端发送记录补用现有折叠栏样式与继承字体，去掉浏览器默认大标题/三角和同步详情的多层卡片边框。
- 验证：挂念产物生成、相关文件 lint、日界过滤与原任务不变/记录摘要检查，以及 390px Chromium 截图检查（演示数据）。随 0.9.29 安装包交付，需在手机端导入升级。


### 挂念线上/线下独立回看（2026-09-08）

- 设置拆为线上回看轮数、线下摘要回看轮数，各 1–100，新安装默认各 40；旧回看数迁移到线上。两类独立限额，合并后用于本机/云端判断，线上同轮气泡不重复计数。
- SDK 显式支持独立窗口；线下只读存储 summary，绕过显示正则，不包含用户输入、角色正文、原始 XML 或思维链。摘要增删改和历史回填进入现有单聊镜像，云端单独查询；原 SDK limit 路径保留。
- 摘要以概述来源参与约定复核，不冒充角色原话、不计入未回应轮数；新窗口能力需两个 worker 均支持。无 schema 变更，未上传或落在窗口之外的旧记录不保证参与判断。
- 验证包含独立窗口专项、镜像历史集成、摘要取消 worker 模拟、相关 lint/类型检查和 SDK/云副本一致性。未做真实模型或手机验收；随 0.9.29 安装包交付，需同步更新宿主及个人云。


### 自创预设选择性同步内置条目（2026-09-08）

- 自创预设详情页的补齐入口改为「同步内置条目」：从当前已安装的内置预设比较，包含自定义 APP（如挂念）安装的新条目，而非只读出厂入口清单。弹窗列出缺少/有差异的条目，可逐项查看当前与内置字段并勾选；默认不选，确认后才写入。内置预设本身继续保留原来的必要入口补齐。
- 根据稳定 identifier 匹配，比较内容、名称、角色、标签、深度、位置等；仅开关和排序不同不列为差异。选中更新保留目标的开关、排序及额外条目，新增项沿用源开关并参考源顺序插入。重复标识不盲目覆盖，同名异标识提示将新增同名条目。
- 确认时重新读取当前存储；预览后所选字段发生变化会停止写入，要求重新比较，避免覆盖未审阅的内容。对话框复用现有样式，标题 14px、条目 12px、说明及差异 11px，缩小字号且保留点按区域；支持取消、全选/取消全选、Esc 和键盘焦点限制。
- 验证：`node scripts/check-preset-entry-sync.mjs` 覆盖真实挂念声明的新旧差异、选择性写入、开关/顺序/额外数据保留、冲突及重复条目；`node scripts/check-preset-sync-browser.mjs` 在 320/390px Chromium 运行真实 React 弹窗，每个宽度 17 项交互检查。相关类型检查通过；预设管理页与通用弹窗已有的 7 个 lint 错误、3 个警告未扩大处理。本地未执行 Next 全量构建，发布由 GitHub Actions 构建；手机预设需用户勾选确认才会更新。

本批发布同时将静态缓存升为 `ai-phone-pwa-v27`，以刷新个人云部署脚本副本。
