# companion-server（挂念后端）

挂念的"情绪 / 生活 / 何时发送"迁到 VPS 常驻运行的后端。设计见 `/root/vibe-coding/float/docs-draft/guanian-backend.md`。

独立于 Next.js：不参与 `npm run build`，Node 22 直接运行 TypeScript（类型擦除），只依赖 `web-push`。

## 当前阶段：4（挂念 / 小手机直连后端）

每 60 秒给每个角色跑一轮（`src/engine.ts`）：

1. 生活面：到 `autoGenAt` 用 daily 快照生成今天（影子模式读云端已生成的那份）
2. 不调模型的账：朋友圈骰子、回音账（凭后端自己的发送记录）、约定定时器
3. 门禁 → 由头（到日子 / 想念 / 憋不住 / 刚做完 / 余韵 / 太安静）→ 分量
4. 判断：judge 快照 + 挂念判断提示词 → 改念头、记账本、挂定时器
5. 到点：发送前复核（睡眠 / 忙 / 淡去 / 事项去重 / 用量）→ chat 快照 + 最新聊天事实 + 状态备忘 → 写 `push_outbox` → Web Push

规则与文案逐段搬自云函数 push-recheck / push-generate；`src/vendor/*.mjs` 是原样拷来的约定 / 事项 / 岔子模块。
旧的「早上定完」模式已删；无大脑的云端预约逻辑备份在 git tag `guanian-cloud-legacy-20260916`。

### 模式

| 模式 | 行为 |
|---|---|
| `shadow`（默认） | 读云端当天生活面，跑门禁，只记「这会儿会去判 / 会发」；**不调模型、不写个人云** |
| `live` | 自己生成、判断、到点发送；替代云端 push-recheck / push-generate |

切换：`node src/cli.ts mode live`（存在 SQLite，服务下一轮生效；`COMPANION_MODE` 只是初始默认）。

### 切到真发

1. `node src/cli.ts import --force`：按云端最新计划覆盖后端状态，云端已点亮未发的念头改由后端定时器接手
2. `node src/cli.ts mode live`
3. App 挂念设置里关掉云端复核 / 云端生成，撤掉云端还挂着的 `timedwake:` 预约（否则两边都会发）
4. `node src/cli.ts status` 看判断和定时器

### 直连

- 监听 `COMPANION_BIND`（逗号分隔，默认 `127.0.0.1`）；线上是 `127.0.0.1,172.17.0.1`，Caddy 容器经 `host.docker.internal:18070` 反代到 `https://float.yanny.top/companion/…`（Caddyfile 的 float.yanny.top 块，`uri strip_prefix /companion`）。
- 鉴权：运维令牌 `COMPANION_API_TOKEN`，或挂念设置里存的个人云 Secret key——后端拿它读一行 `push_server_config`（只有 service 级密钥读得到）确认，只缓存 SHA-256（通过 30 分钟、失败 1 分钟），每分钟最多核对 20 次。
- CORS 放开 `*`：挂念跑在沙箱 iframe（null origin），不用 cookie。
- 手机发来的改动在 `Runner.exclusive` 锁里做：正在跑一轮时排到这轮之后，最多等 20 秒，没做完回 202 `{queued:true}`。

### 接口（除 /health 外都要 `Authorization: Bearer <运维令牌或个人云 Secret key>`）

| 接口 | 作用 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /status` | 模式、各角色此刻状态、念头、定时器、最近判断（不含快照内容） |
| `GET /diagnostics` | 各角色最近聊天镜像与快照时间 |
| `POST /mode` `{mode}` | 切模式 |
| `POST /import` `{force}` | 从个人云迁入 |
| `PUT /snapshots` | 手机寄提示词快照（purpose: chat / judge / daily） |
| `POST /push/test` | 测试推送 |
| `GET /characters/:id` | 单个角色状态 |
| `PUT /characters/:id/settings` | App 同步设置 |
| `PUT /characters/:id/calendar/:date` | App 同步日程表已定安排与作息 |
| `POST /characters/:id/regenerate` | 重新生成今天（仅 live） |
| `POST /characters/:id/tick` | 立刻跑一轮 |
| `GET /app/state?ids=a,b` | 挂念界面：生活面（按此刻揭晓变数）、念头（带后端状态、押后、发送前复核、轨迹）、账本、朋友圈记录、判断记录、快照时间、注入聊天的文字 |
| `GET /app/archive?id=a&limit=30` | 记录页：最近几天的生活面和念头 |
| `GET /app/host?ids=a,b` | 小手机宿主：在线状态用的日子、注入聊天的文字、待发朋友圈、发圈节奏 |
| `POST /app/characters/:id` | 建档 / 更新名字、会话、设置、开关 `{name, sessionId, settings, enabled}` |
| `PUT /app/characters/:id/settings` | 设置（只收设置键） |
| `PUT /app/characters/:id/inputs` | 宿主寄原料 `{affection, days:[{date, calendar, routine, exceptions}], routineOn}`，后端按角色时区折成已定安排和起床 / 上床 |
| `PUT /app/characters/:id/day` | 改今天的日程 `{date, schedule, forks, conds}` |
| `POST /app/characters/:id/threads` | 账本 `{op: add\|done\|undone\|drop}`，了结 / 删掉会撤掉挂在上面还没发的念头 |
| `POST /app/characters/:id/items/cancel` | 撤掉一个还没发的念头 `{wakeId}` |
| `POST /app/characters/:id/moments/ack` | 宿主发朋友圈的回执 `{id, status, postId, note}` |
| `POST /app/characters/:id/regenerate` / `tick` | 同上，挂念按钮用 |

CLI：`node src/cli.ts diagnose | push-test | status | import [--force] | mode shadow|live`

### 手机那头（小手机开着就跑，挂念不用开）

`lib/guanian-server-sync.ts`：每分钟取 `/app/host`，写在线状态变量、回复闸门、注入聊天提示词、朋友圈节奏变量；后端起意的朋友圈在前台补成帖子并回执；后端生成的日程写回系统日程表；把好感、系统日程表、「忙碌回复」固定作息和例外寄到 `/app/characters/:id/inputs`。挂念 0.10.0 开着「交给 VPS 后端」时界面直接读写 `/app/*`。
端到端自测：`node scripts/check-gua-nian-server-direct.mjs`（真后端 HTTP + Chromium 跑挂念 + vm 跑宿主同步）。

### 还没搬的

- 线下通话、快捷指令、微信渠道

## 配置

`/etc/float-companion/env`（0600）：

```
PERSONAL_SUPABASE_URL=https://xxxx.supabase.co   # 个人云，不是网站用的 Supabase
PERSONAL_SUPABASE_SECRET_KEY=...                 # service_role / sb_secret_
COMPANION_API_TOKEN=...                          # 接口令牌，openssl rand -hex 32
# 可选
COMPANION_USER_ID=...                            # 订阅表里只有一个账号时可省略
COMPANION_PORT=18070
COMPANION_DATA_DIR=/var/lib/float-companion
```

数据：`/var/lib/float-companion/companion.db`（0600，快照里含模型密钥）。

## 部署

```bash
sudo rm -rf /opt/float-companion/companion-server && sudo mkdir -p /opt/float-companion/companion-server
(cd companion-server && tar --exclude=node_modules -cf - .) | sudo tar -xf - -C /opt/float-companion/companion-server
cd /opt/float-companion/companion-server && sudo npm install --omit=dev
sudo cp float-companion.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now float-companion
curl -s http://127.0.0.1:18070/health
```

## 开发

```bash
cd companion-server
npm install
npm test
```
