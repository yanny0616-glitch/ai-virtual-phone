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

`git diff upstream/main...main` 共 6 个提交、10 个文件。分两类：

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
