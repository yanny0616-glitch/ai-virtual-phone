# 小剧场 APP 架构

独立 APP，库和收藏全在 APP 自己的 db；宿主只提供通用 SDK（角色、用户资料、`ai.generate`、`ai.chat`、`chat.readHistory`、`memory.add`、`media.*`、`db`）。没有 `presets.json`，所有提示词都由 APP 拼进 `instruction`。

## 目录

`src/**/*.js` 共享一个闭包，顺序见 `src/bundle.json`；`core/runtime.js` 开头开的 IIFE 由 `bootstrap.js` 末尾闭合。`scripts/build-xiao-ju-chang.mjs` 把它们和 `styles.css` 注入 `page.html`，产出单文件 `index.html` 并打包 zip，构建时用 `node:vm` 做一次语法检查。

| 文件 | 职责 |
|---|---|
| `core/runtime` | `$`/`el`、toast、底部抽屉、确认框、视图切换、标签输入、分段选择、开关、步进器 |
| `core/macros` | `{{user}} {{char}} {{time}} {{篇幅}} {{random::a::b}} {{roll:1d6}} {{随机词:名}} {{随机数:名}}`，三遍展开 |
| `data/defaults` | 两条前置、15 条提示词、6 条随机、3 个宏、5 个默认组合、默认设置、篇幅口径 |
| `data/validation` | 导入包/数据行校验；旧库坏行隔离保留至原始备份 |
| `data/scan` | 不认识的 JSON 递归扫成「名字 + 长文本」候选列表，供导入抽屉勾选 |
| `data/storage` | 七个集合 + 一行 settings；分页读全量；读改写串行排队与重复保存合并；播种、导入导出、暗柜档案转换 |
| `gen/assemble` | 组合 → 前置 + `<Brief>` → 调模型 → 切段；随机抽取、权重随机、AI 自选、写回记忆 |
| `ui/render` | 沙盒 iframe 渲染、高度回传、`data-action` 冒泡、结果卡、全屏、复制 |
| `ui/theme` `ui/stage` `ui/library` `ui/favorites` `ui/settings` | 四套主题 + 四个页面 + 编辑组合页 |

## 关键决定

- **注入闸门用白名单，不是黑名单**。`ai.generate` 的 `promptProfile.include` 在宿主侧是白名单（`applyCustomPromptProfileToPreset`），只放 `charDescription` `charPersonality` `characterRelations` `worldInfoBefore` `worldInfoAfter`，再按组合追加 `personaDescription`（我是谁 = 宿主人设时）和三条记忆标记（记忆 = 跟宿主时）。用户自制预设里那些没打标签的聊天格式条目因此进不来，不会把「正文怎么写、要带什么标签」的规则串进小剧场。
- **任务与记忆独立**。宿主单角色 SDK 给聊天引擎显式传递 `requiredTask`，历史 marker 被过滤时组装器仍保留本次任务，普通聊天无此参数不受影响。App 的 `recent` 模式分页读取当前角色会话（清除启动时 sessionId，校验返回角色），过滤 App 媒体和撤回后保留 N×2 条正文，作为 `<RecentChat>` 拼进本次 instruction；`messages` 留空、`history: "none"`，避开宿主 recent 的 50 条上限。只有 `host` 模式包含三种宿主记忆 marker。无会话视为空历史，其他读取失败明确报错。
- **用户身份按角色捕获**。启动和切角按 characterId 刷新名称；生成每次读取所选角色的资料用于宏。裸通道显式传递 characterId 选择模型，根据组合读取 `user.getPersona` 和三类 `memory.read*`，不支持的权限明确报错，不静默降级。
- **宏在 APP 里展开**。宿主的宏引擎只处理预设条目和世界书，`instruction` 里的 `{{...}}` 不会被展开，所以随机词、骰子、篇幅都在 `core/macros` 里先算好再发出去。
- **整段 HTML 直接渲染，不做正则**。模型返回的 HTML 原样塞进 `srcdoc` 的沙盒 iframe（`allow-scripts allow-forms allow-modals allow-popups`，同源被沙盒切断，拿不到 APP 的 db 和 SDK）。iframe 内的脚本用 `postMessage` 回传高度，父页面据此调整普通卡片高度（测量独立内容容器，不测视口；全屏使用固定可滚动视口）；带 `data-action` 的元素被点击时也回传，父页面验证 `event.source`、frame id、连接状态和当前可见性后，从 iframe 绑定的作品读取原组合与角色，携带原文和「用户选了 X」续写。关闭或隐藏的 iframe 不再触发生成。主题色以 `--xjc-bg/ink/acc/line/font` 注进 iframe，「严格」风格约束下只许用这几个变量。
- **播种时重映射 id**。默认组合里写的是 `p_scene_store` 这类种子 id，但 `db.create` 由宿主分配真实 id，所以播种按顺序建表并记 `种子 id → 新 id`，最后修正组合的 `preambleId` 和 `promptIds`。「补齐默认库」按标题比对，已存在的条目跳过但仍进映射表，不会重复建也不会把用户删掉的条目复活（那是 `seeded` 闸门管的，只有手动点补齐才强制跑）。
- **导入分三档**。本 APP 整包走 `validateBundle` 全量校验后合并；暗柜档案按固定字段转成两条提示词加一个组合；其余 JSON 一律交给 `scanLooseJson`：按文档顺序递归，对象里短的 `name/title/comment/identifier` 当名字，≥24 字且含空白或汉字的字符串当正文，跳过 `avatar/url/data:` 这类字段，同文去重、最多 400 条，列出来让用户勾选导成提示词 / 前置 / 随机。不猜格式，所以酒馆预设、角色卡、别人的生成器导出都能进，但进什么由用户点。
- **流式只做预览，最终以整段响应为准**。`ai.generate` / `ai.chat` 传第二个参数 `{ onChunk }` 时宿主逐段发 `stream.chunk`（老宿主忽略这个参数，照旧整段返回）。增量是模型原文——正则和思维链剥离只在最终文本上做，所以 `previewText` 先剥掉可能还没闭合的 `<think>`，UI 层 160ms 尾随节流。纯文字：每次 `postProcess` 后整段 `postMessage({type:"text"})` 重设 iframe 内容，不重载；出现 HTML 段就只报字数（半截 HTML 没法渲染），结束后正常挂载。分两步出的第二步：每个增量 `parseFill` 出已完整/正在写的槽位，`fill` 消息就地填入。结束时 `refreshResultMeta` 只刷标题和字数，不重挂卡片。设置 `streamPreview` 关掉后不带第二个参数。
- **分两步出是两次调用，和流式叠着用**。开了 `output.staged` 的 HTML 组合走两步：第一步 Brief 只要页面骨架，正文位置留 `<span data-slot="n" data-hint="…"></span>` 空占位，拿到就渲染（iframe 里空占位画成闪动骨架条）；第二步把骨架的文字脉络（去掉 style/script、占位换成 `[[n]]`）和占位清单发回去，要求按 `[[n]]` 逐段回文字，APP 用 `postMessage({type:"fill"})` 送进已显示的 iframe 就地填入，不重载、不打断骨架里的脚本，同时把填好的完整 HTML 存进结果。两步共用同一次抽中的随机；第一步没写占位就当一次性成品，不跑第二步；第二步失败保留骨架并给重试。占位是我们指定的空叶子元素，用正则匹配即可，不违反「整段 HTML 不做正则」的原则（那条针对的是对模型正文做替换规则）。
- **取消只是不再等**。`stage.run` 每次拿一个递增 token，取消或新任务发起后旧 token 失效，旧调用回来的结果、错误和 onShell 回调一律丢弃，不写最近、不计数。宿主没有给 APP 中断请求的接口，费用照算。
- **纯裸通道是逃生口**。打开后不走 `ai.generate`，改用 `ai.chat`：APP 自己从 `characters.get` 取人设、性格和卡内世界书，拼成 `<CharacterSheet>` `<WorldNotes>` `<RecentChat>`，system 完全由前置要求决定。用来对付宿主预设实在洗不干净的情况，默认关。
- **收藏存完整依赖快照**。生成开始时 `captureCombo` 深拷贝组合（保留 AI 自选的 `_virtualPrompts`），在 `comboCopy._dependencies` 保存前置正文、所选提示词、随机池、宏和解析后的篇幅；重放优先用副本，随机仍从保存的池里重新抽。编辑或删除原库、导出后导入均不改变新收藏的任务要求。旧记录优先沿用已有 `comboCopy`，没有副本才查当前组合；旧版未保存的依赖正文和 AI 自选任务无法还原。
- **生成归属在开始时固定**。`stage.run` 捕获角色并显式传给生成器；结果归属、使用计数和写回记忆均使用该角色。等待期间可以切换主演，已发出的任务不会串写。重放删除的组合只生成结果，不重新创建原组合；使用计数基于当前库更新，不覆盖用户等待期间的编辑。

## 预览与自测

`node tools/shoot-xiao-ju-chang.mjs`（在 `float/tools/`）给 `index.html` 套一个内存版 `AiPhone`，`ai.generate` 按 instruction 里的输出要求返回预置的文字或 HTML 样稿，在无头 Chromium 里跑一遍主流程：生成、收藏、全屏、iframe 里点按钮再生成、随机、AI 自选、四个页面、四套主题，产出 33 张截图到 `float/screenshots/xiao-ju-chang/`，并把每次调用的 `promptProfile` 和最后一次的完整 instruction 落盘，用来核对白名单和拼装结果。加 `--build-only` 只生成 `float/design/xiao-ju-chang/preview.html`，可以直接在浏览器里点。

专项回归：`node scripts/check-xiao-ju-chang-regressions.mjs`，覆盖异步切角、AI 自选重放、完整快照及导入导出、iframe 来源与可见性校验、旧记录回退。

## 0.1.1 数据与宿主契约

`db.list({limit, offset})` 由宿主提供分页，App 持续读取到末页，旧宿主重复返回同页时明确停止并提示升级。导出、清空、重置覆盖所有行；格式错误的旧行放进 `state.invalidRecords`，不参与页面渲染但原样进入整包备份，设置页显示隔离数量。导入前校验整个包，错误类型不写入；存储故障仍可能中断逐条导入，错误会显示，不承诺跨 SDK 写入事务。

`upsert` 把取最新行、合并、写入和内存更新放进同一队列；相同草稿用 WeakMap 合并进行中的保存，组合编辑只保存配置字段，避免覆盖生成计数。收藏保存同时检查真实收藏记录和进行中的任务；删除/清空解除最近结果引用。文件导出使用 Blob 下载，另显示完整 JSON 供手机手动复制，不再把内部 media asset 当作备份。

正文字号/行距以经过来源校验的 postMessage 更新，不销毁 HTML 交互状态。版本 0.1.1 需要与宿主任务保留、数据库分页修改一起发布；新增权限仅用于用户已选择的裸通道人设/记忆读取。专项验证入口为 `npm run xjc:test`。
