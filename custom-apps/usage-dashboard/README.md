# 用量

模型调用面板。看每天烧了多少 token、花在谁身上、哪个 APP 花的，以及哪些调用失败了。

- **统计页**：按天柱状图（点柱子看单天）、总量与缓存命中率、按角色卡 / 模型 / 来源三种排行。点角色卡直接跳到只看它的调用日志。
- **调用日志页**：最近 150 条底层调用，按来源、角色、成功失败筛选。点进单条能看发给模型的原始消息、思维链和回复原文。

## 数据从哪来

只读宿主的两个接口，不自己记账：

- `AiPhone.usage.readDaily({ days })` —— 按天的累加桶。`bySource` 的键就是发起方的 appId（`chat` / `xiaohongshu` / `moments` / `checkphone_*` / `custom_app:<id>` …），常见的在 `SOURCE_LABEL` 里翻成中文，没收录的原样显示 id。
- `AiPhone.usage.readLogs({ source, characterId, failedOnly })` / `readLogDetail({ id })` —— 日志列表与单条原文。

`calls` 只算成功的，`failedCalls` 是报错、超时、空回复的次数。失败照样可能计费（空回复也吃掉了输入 token），token 数把两者都算进去了，所以「平均每次」除的是 `calls`。

## 权限

`usage.read` 拿计数与日志列表；`usage.logs` 是重权限，拿的是原封不动发给模型的提示词，包含角色卡人设、世界书和完整上下文。
