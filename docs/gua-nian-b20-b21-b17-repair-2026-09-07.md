# B20、B21、B17 修复（2026-09-07）

状态：本地实现与专项验证完成。挂念 0.9.26，沿用 schema 12；未提交、推送或部署，未在个人云和真实手机上实测。本次不处理设备锁、多页面消费、旧历史模糊去重及缺失时区。

| 编号 | 修复后行为 | 实现位置 |
|---|---|---|
| B20 | 旧数据库明确缺 response_batch_id 时仅移除该字段重试，聊天内容和其他字段保留。权限、连接、其他缺列和重试写入失败仍返回错误，客户端不误清上传队列。下次仍先尝试新字段，升级后自动恢复批次上传。 | supabase/functions/ai-phone-push/index.ts 的 chat-mirror |
| B21 | 云端回复和现实桥输入写盘前只分配新消息的 order，旧消息不全量重排。发送事件使用同一顺序插入当前聊天，消息列表预览不被补收的旧回复顶替；重载与回执重试保持顺序。 | lib/chat-storage.ts、lib/follow-up-service.ts、lib/push-outbox-client.ts、lib/reality-bridge/engine.ts、components/chat/chat-room.tsx |
| B17 | 了结惦记时先核实对应任务。已有输出或成功回执保留已生成记录、act 和 wakeId，不回吐普通配额；pending 通过状态与 updated_at 条件原子撤销。执行中、已存正文待投递、查询失败或状态竞争不记作已撤销。部分成功在后续失败时也保存进度。 | 网关 cancel-wake、挂念 planning/threads.js、ui/details.js |

## 边界

B20 只提供镜像旧字段兼容；约定和调度仍要求 schema 12，不能省略整体升级。B21 不回滚以前已经被重排的历史；旧顺序无法可靠插入或浮点间隔耗尽时，只给新批次分配末尾顺序，不改写旧记录。微信独立同步和用户主动合并会话原有的排序流程不在本次云端回箱修复范围内。

B17 使用真实任务/outbox 凭据，不把普通聊天时间匹配当发送证据。没有个人云时，已经到点且本地登记不存在的任务保持待确认，不能凭消失推断已取消。已被旧版本改错的历史不自动恢复。新网关未部署时操作失败并保留原记录，不静默降级成未确认的撤销。

## 验证

- `node scripts/check-gua-nian-b20-b17.mjs`：真实网关与打包 APP；旧字段重试、其他错误不降级、已经生成、已存正文、执行中、并发认领、缺记录、查询失败及部分撤销进度。
- `FLOAT_CHECK_FILTER='B21|Cloud timestamp|Outbox|New page|Existing memory|Call-only' node scripts/check-persistence-and-proxy.mjs`：14 项通过，包含旧消息 order 与时间相反、无效旧时间、浮点间隔耗尽、固定 ID 桥输入、事务失败、确认重试、重载和来电消息。
- P1（11 项）、约定修复、调度 APP 专项通过；宿主 TypeScript 检查通过；构建产物与云函数副本一致性通过。没有运行 Next.js 全量构建。
- 涉及宿主文件 lint 未全通过：follow-up-service 原有 4 处显式 any，使用修改前快照核实同样存在；现实桥原有 1 个未使用导入提醒。未为通过检查扩大修改范围。

## 交付与升级

安装包：`public/custom-apps/gua-nian-0.9.26.zip`。需要发布宿主、更新个人云网关 ai-phone-push，再导入 ZIP。若此前修复尚未升级，仍须完整执行 schema 12 并更新 push-recheck、push-generate。本次无新增 SQL。放入 public 与本地归档不表示已经上线。
