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
| `chat/context` | 按最近几句选记忆，`chat.setContext` 覆盖写；关掉写空串 |
| `core/organize` | 一批约两万四千字 → `ai.chat` → 校验 → 落库 → 推水位；失败五分钟内不重试 |
| `core/background` | `chat.message.created` handler：先刷注入，角色回复后看轮数够不够自动整理 |
| `ui/*` | 列表、编辑、原消息、设置 |

## 关键决定

- **注入跟的是上一轮话题。** 宿主在消息入库后才广播事件，此时回复已经在生成；本轮按最近八句重算并写入，作用于下一轮。这是通用 SDK 的边界，不在宿主加钩子。
- **同文也刷新注入。** 宿主会淘汰超过 6 小时或跨天的 APP 状态，所以每次同步均调用 `chat.setContext` 更新时间。查看器中位于聊天历史之后的「自定义 APP 实时状态」→ `【拾光】`。长时间没有刷新后的首轮仍受上述事件时序限制，可先打开拾光刷新再预览。
- **优先携带最多占预算一半**，剩下留给按话题命中的；话题项选完有余量再让优先项补进。整条进或不进，不截断。
- **摘要由模型直接写**（`promptSummary`，≤200 字）。没有摘要的旧记录优先用当年的紧凑 `recallSummary`，再退到卡片事实拼接。
- **写入带版本**：编辑/删除携带 `baseUpdatedAt`，库里版本不一致就拒绝；后台整理遇到用户改过的记录只补进展。删除是墓碑，整理不会重建同题记录。
- **进度每次重读**：前台页面和宿主临时拉起的隐藏环境各有缓存，整理前一律从 db 重读进度与记录。
- **第一次遇到的角色从当下开始整理**，不回头翻整部聊天史；设置里「从头整理」清零水位后可一批批补。
- **模型**：`ai.chat` 按「绑定配置」里给拾光绑的 API，没绑用该角色聊天模型。
- `db.list` 单表上限 500 行；一个角色超过 500 条拾光时旧的不会再被读到（未处理）。

## 验证

`npm run check:shiguang-app`（领域层 + 产物一致性 + manifest）、`npm run shiguang:browser`（Chromium 跑单文件产物，宿主 SDK 全用内存假实现，覆盖接续旧记录、自动整理、注入、编辑冲突、删除墓碑、关闭撤销注入）。不跑 Next 全量构建、不调真实模型。
