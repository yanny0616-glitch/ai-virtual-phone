# 拾光独立 APP

`src/page.html`、`src/styles.css`、`src/app.js` 由 `scripts/build-shiguang.mjs` 合并成单文件 `index.html`；ZIP 只有 manifest、入口、SVG 图标和说明书。无远程脚本、字体、云连接或独立数据库。

APP 负责卡片、搜索/分类、编辑、设置及手动整理入口。宿主通过窄权限 SDK 提供已有拾光数据读写、关联消息、配置和整理服务：`lib/shiguang-app-api.ts`。所有入口在 custom-app-runner 中先鉴权，写入只能操作指定角色已有的拾光记录，不能改长期或核心记忆；配置只允许四个拾光字段。编辑/删除在同一 IndexedDB 事务内检查 expectedUpdatedAt 和原角色，拒绝旧编辑覆盖新内容。

宿主继续负责自动整理触发、存储、聊天选取和提示词组装。这样 APP 关闭时功能仍可工作；卸载管理 APP 不会删除拾光，也不改变既有记录开关。整理模型继续走宿主的记忆模型绑定。记忆库中的旧拾光页和设置区改成打开独立 APP 的入口。

`lib/shiguang-domain.ts` 是实际发送文字的正本。`promptSummary` 是唯一可编辑摘要；合并候选为控制整理用量只发送其前 1200 字，聊天注入使用完整候选并按预算整条取舍。旧数据没有该字段时，从可见卡片事实即时生成，不写回、不要求重新总结。legacy stableSummary 只决定旧记录的默认发送方式，recallSummary 仅在可见事实全空时兜底。发送文字由摘要 + 状态 + 后续组成，APP 的 promptText 与聊天发送共用函数。详情修改不默默重写用户的摘要；用户可明确点击「从卡片生成」。

`recallMode` 为 priority / relevant / off。旧记录有 stableSummary 则默认 priority，否则 relevant。priority 在预算内优先；relevant 沿用标题/关键词文字匹配及临近待办日期；off 不发送。按完整候选文字计算预算，不截断正文、不追加第二份隐藏摘要、不宣称卡片属于某一轮。

验证：`check:shiguang-app` 覆盖真实领域选择、API 编辑/隔离/配置和安装包权限；`shiguang:browser` 使用 Chromium 执行独立 HTML 和真实宿主存储/API 的轻量 fixture，检查旧数据接续、编辑后发送一致、删除、设置、原消息、窄屏和深色布局。不得在本机运行 Next 全量构建。
