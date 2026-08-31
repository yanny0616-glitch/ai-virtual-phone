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

**详见 [docs/fork-changes.md](docs/fork-changes.md)**（23 个提交 / 56 个文件，2026-08-30 核对）。

一句话概括：部署基础设施（CI + systemd）自建、SillyTavern 角色卡与卡内世界书导入、
提示词缓存与按角色卡的用量统计、出站请求 SSRF 加固、若干 UI 与 CI 修补。

改了功能请更新那个文件，不要往本文件里堆。

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
