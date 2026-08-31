# CLAUDE.md — Float / ai-virtual-phone 本地部署说明

给 Claude Code 看的项目上下文。**动手前先读「构建纪律」那一节。**

## 构建纪律（最重要）

> **禁止在这台机器上跑 `npm run build`。构建只在 GitHub Actions 上做。**

原因：本机内存/CPU 扛不住 Next.js 全量构建，构建产物也不该混进工作区。

正确流程：

1. 在 `/root/vibe-coding/ai-virtual-phone` 改代码
2. `git commit` → `git push origin main`
3. GitHub Actions（`.github/workflows/float-release.yml`）自动 `npm ci` + `npm run build`，打包成 `float-standalone.tar.gz`，发成 GitHub Release，tag 为 `float-build-<12位sha>`
4. 本机 systemd timer 每 5 分钟拉一次最新 Release，校验 sha256 → 解包 → 切软链 → 重启服务
5. 想验证结果：等 timer，或手动 `sudo systemctl start float-deploy.service`，再看 `cat /opt/float/current/VERSION`

本地只允许 `npm run dev`（调试用）、`npm run lint`、`npm run check:*`。

## 仓库地址

| | |
|---|---|
| 本项目（fork，推这里） | https://github.com/yanny0616-glitch/ai-virtual-phone |
| 原项目（upstream，只拉不推） | https://github.com/xiaolongbao0709/ai-virtual-phone |

同步上游：`git fetch upstream && git merge upstream/main`

## 部署链路

```
git push origin main
   └─> GitHub Actions: float-release.yml
         npm ci → npm run build → 打包 .next/standalone + .next/static + public
         → gh release create float-build-<sha12>  (只保留最近 3 个 release)
              └─> 本机 float-deploy.timer (每 5min)
                    /usr/local/sbin/float-deploy  (源码在 ops/float-deploy.sh)
                      校验 tag 格式 + sha256 → 解到 /opt/float/releases/<tag>
                      → 切 /opt/float/current 软链 → restart float-ai-phone.service
                      → 健康检查 http://172.17.0.1:3001/api/auth/me
                      → 失败自动回滚到上一个 release
```

运行态：

- 服务：`float-ai-phone.service`，`node /opt/float/current/server.js`，监听 `172.17.0.1:3001`
- 环境变量：`EnvironmentFile=/root/vibe-coding/ai-virtual-phone/.env.local`
  （键：`NEXT_PUBLIC_SELF_HOSTED_MODE` `PORT` `SUPABASE_URL` `SUPABASE_SECRET_KEY` `SUPABASE_ANON_KEY` `ACCOUNT_GATE_SECRET`）
- 版本记录：`/opt/float/current/VERSION`、`/var/lib/float-deploy/deployed-version`
- `ops/` 下的 4 个文件是 systemd 单元和部署脚本的**源码副本**，改完要同步到 `/etc/systemd/system/` 和 `/usr/local/sbin/float-deploy`，再 `systemctl daemon-reload`

另一条流水线：`.github/workflows/android-shell.yml`，手动触发，出 Android 壳 APK（可选签名，走仓库 Secrets）。

## 本地版本相对 upstream 的改动

`git diff upstream/main...main` 共 23 个提交、56 个文件（2026-08-30 核对）。分三类：

### A. 部署基础设施（upstream 没有，纯自建）

- `.github/workflows/float-release.yml` — 上面那条构建+发布流水线
- `ops/float-deploy.sh` / `.service` / `.timer` — 拉取、校验、切换、回滚、健康检查
- `ops/float-ai-phone.service` — 生产服务单元
- `next.config.mjs` — 加 `output: "standalone"`，让 CI 产出自包含运行时，服务器上不需要 `npm install` / `next build`

### B. 功能与修复

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

### C. 提示词缓存 + 用量统计（这一块最大，跨 10 个提交）

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

### D. 安全加固（`6962264`）

- `lib/server/safe-outbound-fetch.ts` — **新增**。所有出站请求（图片生成、OAuth 回调、tool-proxy）走它：解析 DNS 后校验目标 IP，挡内网/回环/链路本地地址，限制重定向次数，防 SSRF
- `components/ui/story-html-renderer.tsx` — 渲染模型输出的 HTML 前做清洗
- ⚠️ 已知遗留：`safe-outbound-fetch.ts:135` 有个 `LookupFunction` 的 TS2322，`npx tsc --noEmit` 会报，不是新引入的

## 常用命令

```bash
# 看当前跑的是哪个提交
cat /opt/float/current/VERSION

# 手动触发一次拉取部署（不用等 5 分钟）
sudo systemctl start float-deploy.service
journalctl -u float-deploy.service -n 50 --no-pager

# 服务日志
journalctl -u float-ai-phone.service -n 100 --no-pager

# 本地开发（唯一允许的本地跑法）
npm run dev

# 同步上游
git fetch upstream && git merge upstream/main
```

## 注意事项

- `.env.local` 含真实密钥，永远不要提交、不要打印内容
- 静态大资源（字体/3D 模型/图片）在 `netlify.toml` 里设了一年 immutable 缓存，**更新这类文件必须改文件名**，否则老客户端一直吃缓存
- 只保留最近 3 个 Release，回滚要用更旧版本的话得重新触发构建
- commit 消息带 `[skip ci]` 可以跳过构建（改 ops/文档时用）
- **可能有别的 agent（codex 等）在同一个仓库并行改代码**。动手前先 `git log --oneline -5` 看有没有你不认识的提交；改公共文件（`custom-app-runner.tsx`、`llm-provider-adapter.ts`、`api-usage-stats.ts`）之前尤其要看
- 既有的 lint/tsc 报错：`safe-outbound-fetch.ts` 的 TS2322、`preset-manager.tsx` 的 `Date.now` purity 与 `custom-app-runner.tsx` 的 `set-state-in-effect`。**改动前后对比错误数量**，别把它们当成自己引入的
