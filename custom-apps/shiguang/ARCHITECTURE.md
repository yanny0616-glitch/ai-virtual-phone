# 拾光 APP 架构

2.0 起拾光是真正的独立 APP：记录存在 APP 自己的数据库，整理、回忆选取、注入全在 APP 里跑。宿主只提供通用 SDK（读聊天、后台事件、`chat.setContext`、`ai.chat`、`db`），没有任何拾光专属接口；唯一例外是 `memory.readShiguang`，只读，用来把 2.0 之前存在宿主记忆库里的旧记录搬进来。

## 目录

`src/domain/*.mjs` 是纯函数 ESM，Node 测试直接 import；`src/**/*.js` 共享一个闭包，顺序见 `src/bundle.json`。`scripts/build-shiguang.mjs` 把它们合成单文件 `index.html`，域模块以 `ShiguangText` / `ShiguangRounds` / `ShiguangRecall` / `ShiguangExtraction` 四个常量暴露给闭包。

| 目录 | 职责 |
|---|---|
| `domain/text` | 清洗、双字重叠、token 估算（与宿主同公式）、短 id |
| `domain/rounds` | 轮数口径（角色连发算一轮）、按字数切批不拆问答 |
| `domain/recall` | 默认摘要、发送文字、预算内选取、注入文本 |
| `domain/extraction` | 候选挑选、整理提示词、结果严格校验 |
| `data/storage` | 宿主 db：`settings` 一行、`progress` 每角色一行、`mem_<角色>` 每角色一张表 |
| `data/migrate` | 第一次打开按角色搬旧记录，水位设在当下 |
| `chat/history` | 翻页读聊天到水位为止；按 id 找原消息 |
| `chat/context` | 普通私聊 provider 按本次消息纯读选记忆并返回；事件路径继续用 `chat.setContext` 刷新其他场景 |
| `core/organize` | 一批约两万四千字 → `ai.chat` → 校验 → 落库 → 推水位；失败五分钟内不重试 |
| `core/background` | `chat.message.created` handler：先刷注入，角色回复后看轮数够不够自动整理 |
| `ui/*` | 列表、编辑、原消息、设置 |

## 关键决定

- **普通私聊当轮召回（2.1）。** 通过通用 `extensions.prompt.contextProvider` / `chat.registerContextProvider` 接口，宿主在装配前传入本次会话最近八条用户/角色消息（含当前输入），等待 APP 返回选中的记忆文字。APP 每次直接读库，不用前台缓存；不写共享上下文，不等待自动整理。返回值仅属于本次请求，并发会话和迟到结果不会覆盖它。默认总等待 2000ms，失败/超时省略拾光本轮内容，聊天继续。
- **事件注入作为其他场景的通道。** 群聊、追发、线下模式、云端主动消息不调用新 provider；仍沿用原本事件更新的状态。旧宿主没有新 SDK 方法时保持旧行为；新功能需要同时更新宿主与 APP。
- **同文也刷新事件注入。** 宿主会淘汰超过 6 小时或跨天的 APP 状态，所以每次事件同步均调用 `chat.setContext` 更新时间。普通私聊的请求级结果直接参与装配，不受旧缓存是否过期影响。查看器中仍位于聊天历史之后的「自定义 APP 实时状态」→ `【拾光】`。
- **优先携带最多占预算一半**，剩下留给按话题命中的；话题项选完有余量再让优先项补进。整条进或不进，不截断。
- **2.1.1 本地召回分三档**：完整关键词 > 标题/关键词分词命中 > 摘要/最新后续分词命中。分词使用内置 `Intl.Segmenter`，过滤泛词及纯数字；连续单字专名保留，避免「提拉米苏」被拆散后丢失。不支持分词的旧环境退回完整词串。仅靠泛词不能触发普通话题记忆；优先携带和约定日期加分保持原规则。旧记录只读匹配，不回写关键词，不额外调模型。关键词生成提示词要求覆盖原文具体对象、简称与明确细节；落库时去重复并过滤独立泛词。不做无依据的同义词扩展。
- **摘要由模型直接写**（`promptSummary`，≤200 字）。没有摘要的旧记录优先用当年的紧凑 `recallSummary`，再退到卡片事实拼接。
- **写入带版本**：编辑/删除携带 `baseUpdatedAt`，库里版本不一致就拒绝；后台整理遇到用户改过的记录只补进展。删除是墓碑，整理不会重建同题记录。
- **进度每次重读**：前台页面和宿主临时拉起的隐藏环境各有缓存，整理前一律从 db 重读进度与记录。
- **第一次遇到的角色从当下开始整理**，不回头翻整部聊天史；设置里「从头整理」清零水位后可一批批补。
- **模型**：`ai.chat` 按「绑定配置」里给拾光绑的 API，没绑用该角色聊天模型。
- `db.list` 单表上限 500 行；一个角色超过 500 条拾光时旧的不会再被读到（未处理）。

## 验证

`npm run check:shiguang-app`（领域层 + 产物一致性 + manifest）、`npm run shiguang:browser`（Chromium 跑单文件产物，宿主 SDK 全用内存假实现，覆盖接续旧记录、自动整理、注入、编辑冲突、删除墓碑、关闭撤销注入）。不跑 Next 全量构建、不调真实模型。

当轮路径专项：`node scripts/check-custom-app-prompt-context.mjs`（真实宿主选取/格式化与 APP provider）、`node scripts/check-custom-app-prompt-bridge.mjs`（Chromium 中真实 SDK 与拾光产物，模拟宿主数据）。
