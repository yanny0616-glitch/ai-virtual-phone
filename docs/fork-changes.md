# Fork 改动清单

相对 upstream `xiaolongbao0709/ai-virtual-phone` 的全部改动。
主文档见 [../CLAUDE.md](../CLAUDE.md)，构建纪律和部署链路都在那边。

> 加了新功能就在这里补一段，**别往 CLAUDE.md 里堆**。

`git diff upstream/main...main` 共 23 个提交、56 个文件（2026-08-30 核对）。分三类：

## A. 部署基础设施（upstream 没有，纯自建）

- `.github/workflows/float-release.yml` — 构建+发布流水线（链路图见 CLAUDE.md 的「部署链路」）
- `ops/float-deploy.sh` / `.service` / `.timer` — 拉取、校验、切换、回滚、健康检查
- `ops/float-ai-phone.service` — 生产服务单元
- `next.config.mjs` — 加 `output: "standalone"`，让 CI 产出自包含运行时，服务器上不需要 `npm install` / `next build`

## B. 功能与修复

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
   - `232b863` 第二台设备可以直接接入已有的个人云，不用重新建
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
