# 挂念云端消息链路审计（2026-09-07）

> 历史记录：以下结论、版本与发布状态保留自记录当时，不代表当前源码或线上状态；归档不表示问题全部解决。见[归档导航](../README.md)。

后续本地修复记录：[消息链路修复](cloud-message-repair-2026-09-07.md)、[调度四项修复（0.9.25 / schema 12）](gua-nian-scheduler-repair-2026-09-07.md)。下文保留审计时的结论，不代表当前代码或线上部署状态。

只读审计，未改代码。基线：线上 `55901a1`（HEAD）；工作区另有未提交的「约定 promise」改动
（push-recheck / push-generate / gateway / schema 11 / 挂念 APP），单独列出。
行号取自审计当时的工作区文件，另一会话仍在编辑，可能略有偏移。

置信度：高 = 逐行核实过路径；中 = 逻辑成立但依赖部署状态或时序；低 = 需特定条件。

---

## A. 线上（HEAD）就存在的问题

### A1. 云端延后回复落地后，用户紧接着发的下一句没人接 【高】
- `lib/push-outbox-client.ts:264-282` 写入云端回复后，不清本地 deferred 记录（`writeDeferredReply/readDeferredReply` 在消费路径零引用）。
- 只靠 `lib/deferred-reply-cloud.ts:194,213-215` 的 20 秒轮询 GET 到 `status=done` 才置 `firedAt`。
- 窗口内用户再发一句 → `components/chat/chat-room.tsx:3989` `held && !held.firedAt` → `queueDeferredReplyCloud` 抬 revision、toast「补充消息正在同步云端」、return，不触发本地回复。
- 网关 `gateway.mjs:786` `row.status !== "pending"` 直接回执 → 宿主置 `firedAt` 并 toast「上一轮已生成，刚补充的内容未合并」。
- 现象：回复弹出后 10 秒内回一句，没人接，要手动点「触发回复」。云端 `running` 期间发消息同样。

### A2. `armAt` 启发式把云端延后回复整条静默丢弃 【中高】
- `lib/push-outbox-client.ts:230-241`：会话里存在任一 assistant 消息 `createdAt ∈ (meta.armAt, passStart)` 即视为"本地已回过"，直接 ack 丢弃，无 responseBatchId 痕迹、无日志。
- 延后回复 `armAt` = 同步时刻（`deferred-reply-cloud.ts:130`）。等待期间同会话来了任何 assistant 消息（挂念云端唤醒、冷场重连、经期关怀、插件产出）→ 延后回复消失。云端 job 日志显示 pushed。
- 不一致：云端复核新建的唤醒克隆哨兵模板（`push-recheck.mjs:1157,1913`），`armAt` 继承哨兵的 `now+48h`（`wakes.js:134`），该保护对云端排的唤醒完全不生效。

### A3. 没有推送订阅就永远不拉 outbox 【中】
- `lib/push-outbox-client.ts:80`：`!screenChat.enabled && !hasAccountPushSubscription()` 直接 return。
- 挂念云端复核自己往 `push_jobs` 插 job、延后回复也不依赖订阅。iOS PWA 重装 / 通知被收回后 `subscribed=false`（`push-client.ts:77-82` 还有 TTL 缓存）→ 云端持续生成，手机一条不取。

### A4. 前台不轮询 【中】
- `installServerOutboxConsumer`（`push-outbox-client.ts:314-334`）只有启动、`visibilitychange`、SW `push_outbox_ready` 三个触发点，启动还有 5 分钟节流（`:78`）。
- iOS 推送不可靠 / 桌面无推送权限时，前台开着 App 看不到新消息，切后台再回来才出现。`deferred-reply-cloud.ts` 却 20 秒轮询，两条链路节奏不一致 → "状态说已生成、聊天里没有"。

### A5. 旧宿主镜像缺 `response_batch_id`，云端历史把已消费消息算两遍 【中】
- `push-generate.mjs:1920-1936` 只在镜像行带 `response_batch_id = push-outbox:<id>` 时跳过 outbox 行；该字段由未提交的 `lib/chat-mirror-client.ts` 改动才开始写，存量镜像行全无。
- 旧宿主镜像 `createdAt` 是入库时间，常晚于 `created_at` 数小时 → `guanianHistoryRounds` 算成两轮 → `hardSkip: 连续 N 轮没等到你回` 误触发，提示词里角色重复自己。

### A6. 设备接管只撤服务端 job，原设备本地登记簿照发 【已知延期】
- `connection.js:94-113`；宿主 `follow-up-service.ts` `fireTimedWake` 独立触发。ARCHITECTURE.md 已注明设备锁并发暂缓。

### A7. 多标签/PWA+浏览器同时前台重复插入 【低】
- `consuming` 锁是页面进程内的（`push-outbox-client.ts:42`），去重靠各自内存 `_messagesCache`。两个上下文同时 `visibilitychange` 各拉一次，先 ack 的删行，另一个照样落盘 → 两份不同 id 的同一条。

### A8. 同 pass 内同 `trigger_key` 只保留第一条 【低】
- `push-outbox-client.ts:106-109` `handledTriggerKeys` 命中即 ack 不落地。recheck 撤销失败后旧 job 和新 job 都执行时第二条静默丢。

---

## B. 未提交「约定 promise」改动会引入的问题

### B1. 云端复核 100% 变 503，整条链路停摆 【高，回归】
- `push-recheck.mjs:1358-1360` 新加 `readGuanianCloudHistory(rest, userId, plan.session_id)`，`:2103` 空 sessionId 直接 throw → 503。
- `push_recheck_plans.session_id` 唯一写入者是网关 `gateway.mjs:1335` 存 `body.sessionId`，而 APP `cloud/plans.js:142` 写死 `sessionId: ""`（`index.html:1527/1728` 同）。
- 后果：每 5 分钟 cron 派发即 503，不 touch `last_recheck_at`，永远排队首。反馈账、裁决、起念、约定预约全不执行。
- 修法方向：APP 上传带 `cx._session`（`index.html:1137` 已取到），或云端按 `character_id` 回退。

### B2. push-generate 硬依赖 schema 11，未跑 SQL 则所有云消息永远卡住 【高】
- `push-generate.mjs:886-895` `rpc/push_generation_lease` 404 → 无上限 `retry()`；`:1013-1021` / `:1914` select `response_batch_id` 400 → 同样 retry。无 `failed` 转换。
- 影响所有带 sessionId 的 kind（timed_task / followup / reply_bailout / deferredReply）。网关对 `promise-tasks-v1` 有 schema≥11 门禁（`gateway.mjs:1136-1142`），push-generate 没有。
- 等 schema 补上后，`until`/freshness 已衰减的 job 又被等待概率掷掉。

### B3. 同一约定双发：本机与云端各挂一条，wakeId 不同，无幂等键 【中高】
- 云端 `push-recheck.mjs:1452` 确定性 id `wakePrefix+promise_<id>_<rev>`；APP `threads.js:175/424` `AiPhone.push.wake()` 随机 id。两边判据都是 `promiseNeedsTask(items 里有没有)`。
- APP 随后 `uploadPlanCloud` 整份覆盖 items（`gateway.mjs:1337`），云端那条 item 消失但 `push_jobs` 里 job 仍 pending；`push_cancel_stale_promises`（sql:657-676）只撤 items 引用到的 job，孤儿不撤。
- 到点 push-generate `loadRecheckPlan` 找不到 item → `item:null` → `promiseIsCurrent` 对 null 返回 true（`push-generate.mjs:1057-1064`）→ 按普通 timed wake 发；APP 那条也发。
- 明天的约定：云端用 `now+31天`（`push-recheck.mjs:1437`）今天就挂进今天的行；APP 只挂 due < 明天 00:00（`threads.js:421`），明天再挂一条。昨天行的 job A 不会被撤（`loadRecheckPlan` 倒序扫 32 行能找到）→ A、B 都发。

### B4. 过点约定让本机复核每轮抛错，留下孤儿预约 【高】
- `threads.js:424` `fireAt = max(+t.due, nowMs + 15000)`，宿主 `lib/custom-app-host-api.ts:2439` 要求 ≥ now+60s → throw。`promises.mjs:419` 接受过去 24h 内的 due，所以"15:40 说他 15:30 回来"必抛。
- 无新消息分支 `recheck.js:45` 抛出即中断，每 recheckMin 重复。
- 有新消息分支 `recheck.js:233` `applyThreads → syncPromiseTasks` 抛在模型调用后、`:238` 落盘前：`:172/193/215` 已挂的预约不写进 plan，`:169/184` 已撤的不记录 → 孤儿照发、下一轮又点亮一遍。
- `ui/main.js:157` 手动记一件无 try/catch：账本已存、plan 未更新、不上传、表单不收起。
- 云端同位置 `push-recheck.mjs:1450` 无 60s 限制，云端 15 秒后就推"核对约定"（配合提示词"不顺移到明天"）。

### B5. `push_arm_promise` 写进 decisions 的 promise 裁决被随后整份写回覆盖 【高】
- `docs/personal-push-supabase.sql:650-652` RPC 追加 `{kind:'promise'}` 到 DB decisions。
- `push-recheck.mjs` `priorDecisions` 是 `:1376` 的旧快照，`reconcilePromises()` 后未刷新（`:1469` 只 select items,context）。`:1665` 门禁 gate note、`:1645` wordSettled、`:2064` 成功路径 `[...priorDecisions, ...applied]` 三处整份覆盖。RPC 不改 `updated_at`，乐观锁不挡。
- APP `decisions.js:96-104` 只靠 `kind==='promise'` 裁决建本地 item → 永远收不到 → 触发 B3。

### B6. 已发过的约定第二天被重新挂上 【中高】
- `promises.mjs:419-423` 只看 items 里有没有同 from/revision 的 act 项；发送后线程不标 done（`threads.js:366` 只加 `said:` nudge，云端只写 `mentionedAt`）。
- 跨零点 plan 换新、items 为空、due 在 24h 内 → 云端 00:05 再挂一次（睡眠押后到早上发）；本机则按 B4 抛错。云端靠 `on conflict do nothing` 挡了 job 重插，APP `syncPromiseTasks` 没有这层。

### B7. 手机上传撤销 / 回退云端的约定改期 【中高】
- `gateway.mjs:1305-1316` 用手机的 threads 整份替换，`:1330-1345` 替换 items，`:1352-1357` 再按手机的 revision 跑 `push_cancel_stale_promises`。
- push-recheck 改期后 revision+1 并 `push_arm_promise`。手机若在拉裁决前上传（`ui/main.js:138/160` 账本操作直接 `uploadPlanCloud` 不先 `pullCloudDecisionsBody`；`recheck.js:32` 有注释警告）→ rev2 job 被撤、线程回退 rev1、下轮复核重挂旧时间。
- 现象："我说改成 9 点，她还是 8 点发"，或旧新各发一次。
- `push_arm_promise` 裁决行无 `wakeId`（sql:635），APP `decisions.js:83` 回退 `byTime[d.time]`，与同 HH:MM 的普通时刻撞车。

### B8. 云端改约后本机旧预约不撤，浏览器开着时旧时间照发 【中】
- `decisions.js:77-86` promise 恢复块只按 wakeId 匹配，`revision !== promiseRevision` 的云端旧项直接 continue；本地旧项 B（rev1, act:true）不动。裁决循环 `:98` 用 `d.wakeId` 找到的是新项 A，不触发撤销。
- 云端 RPC 只撤服务端 job B，宿主 `fireTimedWake` 从本地登记簿独立触发 → B 按旧时间发，A 再按新时间发。

### B9. `threadsOn` 默认开 → 每次上传都要求 worker 有 `promise-tasks-v1`；网关 503 连带清空云端裁决 【中】
- `cloud/plans.js:252` `requireRecheckFeatures(["promise-tasks-v1"])`，worker 没更新则所有计划上传失败（"云端版本尚不支持此设置"），且每次多一次 capabilities 请求。
- `gateway.mjs:1348-1352` 先 upsert 再调 RPC，schema 11 未跑 → RPC 缺失 503 但行已存。APP 记 failed 并保留 `resetDecisions`（`plans.js:241`），下次任何上传都带 reset → 云端期间点亮/起念的裁决和 wakeId 被抹掉，job 成孤儿。
- 旧 zip（0.9.9/0.9.10）用户遇新网关 + schema 10：只要有 `kind:"promise"` 线程就每次 503「计划已保存，旧约定撤销未确认」。

### B10. 账本操作直接上传、不先拉裁决 → 旧 items 覆盖云端刚挂的预约 【中】
- `ui/main.js:138`（了结/删除）、`:160`（手动记一件）调 `uploadPlanCloud(cx,false)` 前不拉。网关 POST 整列替换 items。两次拉取（≤15 min）之间云端点亮/起念的项被覆盖：job 仍 pending 照发，本地无 wakeId 撤不掉，云端 `litCount` 少算可能再点一条。
- 其余入口（`recheck.js:48/243`、`plans.js:206/233`、`wakes.js:161/241`）都有先拉或本就 reset。

### B11. 云端历史注入两遍，且时区不一致 【中高，成本+推理】
- `push-generate.mjs:1014-1021` 追加 `guanianHistoryText(cloudHistory, merge.tzOffsetMin)`（≤80 条×4000 字），`:1226-1236` 事实核对 note 再追加同 80 条。提示词翻倍 → 可能 provider 400 → `finish("failed")` 消息丢失。
- `merge.tzOffsetMin` 无人赋值（只有 `quietWin.tzOffsetMin`），第一份全按 UTC 打印，第二份按 `day.tz` 本地时间，提示词又要求"核对最新时间"，模型看到两个时钟。

### B12. assistant 消息计入 fresh → 推送→裁决→再推送链，降速硬规则失效 【中】
- 云端 `push-recheck.mjs:1491` `freshRows` 由 `role=eq.user` 改为全部，且 `readGuanianCloudHistory` 把 `push_outbox(pushGenerated)` 并进 messages（`:2129-2131`）。云端发一条后下一轮就有 1 条 fresh → 过 `gateMinMsgs` → 调模型 → 可能产 extra。无"最后一句是我说的就不追"检查（仅 selfImpulse 分支 `:1546` 有）。
- `:1483` `!Array.isArray(context.threads)` 网关总给数组，"没待发时刻且额度满"闸门永久失效；`:1474-1477` `hasPromiseUpdate` 正则宽（"到/去/等"+任何时间词），命中时间隔降到 1 分钟并跳过 `gateFreshMin`（`:1614`）。模型失败不推进 `judged_chat_at`，每 5 分钟重打。
- APP 侧 `recheck.js:40/55` 同样：cooling 成立时 TA 自己的话就是新消息 → 永远走模型分支，硬取消不再触发；`promiseUpdate` 正则被 TA 自己带时间的话触发。

### B13. `reconcilePromises` 任一步失败 → 503 且不 touch `last_recheck_at` 【中】
- `push-recheck.mjs:1467-1473`。抛错点：schema 11 未部署（RPC 404）、`:1448` "约定缺少可用模板"（items 的 job 都 done、哨兵不在时必现）、模板读取失败。后续裁决/起念整批跳过并持续占队首。

### B14. 模型调用之后的失败烧掉生成结果 【中】
- `push-generate.mjs:1707-1716`：LLM 回复后 lease `renew` 失败 → `retry()` 从头再生成（双倍 token，无去重）。`loadRecheckPlan`（`:1715`）现在非 OK 即 throw（`:621`），未包 retry → 落外层 catch → `finish("failed")`，已生成消息永久丢。模型前的同一读取（`:1034-1035`）有 retry。

### B15. `minGap` 现在把聊天回复也算进去，每 60 秒重派 【中低】
- `push-generate.mjs:1064-1068` `lastGeneratedAt` 取全部 `pushGenerated` 行最大 `created_at`，含延后回复和 bailout。`minGapMin=90` 的时刻在用户刚被云端回过一句后要等 90 分钟，`retry()` 每分钟重派（每次 2×200 行读 + 32 计划行），不追加裁决面板不显示；`guanianWaitingChance` 从 `origFireAt` 持续衰减，常以"念头淡去了"收场。

### B16. 无锁整份写回 / 刷新前的 items 计算配额 【中低】
- `push-recheck.mjs:1409-1417` 写 `context`（现在 `sentChanged` 时连 items）不带 `updated_at` 锁，读写之间 APP 重排就被打回。
- `:1375-1389` `pending/litCount/nearest/canJudge` 在 `:1472` splice 刷新 items 之前算出。约定 item `act:true` 计入 `litCount` → 每条约定吃一份 `quota`（默认 3）并参与 `tooClose` → "记了约定后 TA 就不主动了"。

### B17. `dropThreadSlots` 会把已发出的时刻改成"已撤" 【中低】
- `threads.js:129` 由 `w.fireAt <= now` 改为 `w.thDone || w.generatedAt`（审计中又改过一次）。`thDone` 由 `settleFired` 事后打（本地投递等 6h、云端回执失败不打），`generatedAt` 非 promise 项本地收不到。用户了结一条惦记时，刚发出未结算的时刻被置 act:false，上传后云端额度回吐一条。

### B18. 约定唤醒强制睡眠押后可能 failed 【低中】
- `push-generate.mjs:1168` `mode = pi.kind === "promise" ? 1 : …`。mode 1 下 `day.wake` 非 HH:MM 且无 `quietEnd` → `guanianLocalHMToMs("undefined")` 返回 0 → `finish("failed", "guanian wake time unavailable")`，约定被丢而不是醒后发。

### B19. 约定 item `time` 时区 / 同刻冲突 【低】
- `push-recheck.mjs:1451/1457` 用 `rowTz`，无 `context.day` 时 NaN→UTC，`time` 成 UTC 时刻；明日约定 HH:MM 与今日某时刻相同时 APP `decisions.js:85` `byTime[d.time]` 取错 item。

### B20. 镜像 POST 无条件带 `responseBatchId`，schema 未到 11 时整批镜像静默停摆 【中】
- `lib/chat-mirror-client.ts:140` 无条件带字段，`gateway.mjs:1000` 无条件写列（sql:595 新增）。只重部署云函数没跑 SQL → 400 → `uploadQueue` 抛错被 `flushQueue` 吞（`:223`），队列一直堆。网关 `:670` 只判 schema≥4 无守卫。后果：云端看不到用户回复 → `cooldownRounds` 降速把唤醒全取消。

### B21. 每条云消息落地都按时间全量重排会话 【中】
- `lib/follow-up-service.ts:1066-1068,1171-1173` 调 `reindexSessionMessageOrdersByTime`（`lib/chat-storage.ts:507-527`），无视 `order` 全会话按 `createdAt` 重排并 `dbPutMessages` 所有变动行。`compareChatMessages`（`:461-475`）本以 `order` 为准，历史上 order≠时间序被容忍；首次跑到会大面积改写。`createdAt` 无效的老消息排到最顶。
- 静默模式下聊天室 `chat-room.tsx:1497-1503` 只 `[...prev, message]` 追加不重排，重进会话才归位。

---

## 已核过、不是问题的点

- owner/ownerSeq 设备锁、`push_recheck_judge` 租约与 `touch` 乐观锁、`push_arm_promise`（`for update` + 唯一键）在 cron 重叠下幂等。
- `feedbackWithPreviousDay` 跨天合并、`feedbackWindowEnd` 睡眠窗计算。
- outbox 拉取/ack 幂等：`existing` 检查（`push-generate.mjs:894-896`）能恢复写后崩溃；ack 失败重拉靠 `responseBatchId` 去重 + `pendingMessageBatches` 复用（`chat-storage.ts:1265-1303`）。
- 镜像与 outbox 竞争由 `readGuanianCloudHistory` "未镜像的已消费输出仍保留"（`lib/guanian-cloud-history.ts:32`）兜住。
- `created_at` 来自服务端含时区，`Date.parse` 正常；`plan_date` 处理一致；`acceptedUserSleep` 回显与 push-recheck 读取一致（push-generate 不读这些键）。

---

## 建议处理顺序

1. B1 + B2 + B9 + B20：发布前必须解掉，否则 promise 改动一上线云端整条停摆。统一原则：schema 11 未跑时降级而不是 503/无限 retry。
2. A1 + A2：线上现在就丢消息，和 promise 无关，可单独发宿主。
3. B3 + B5 + B7 + B8：约定的幂等键与撤销要统一（谁挂、按什么 id、谁撤），否则双发。
4. B4 + B6：过点约定的 60 秒下限与"已发过"标记。
5. 其余按现象再排。
