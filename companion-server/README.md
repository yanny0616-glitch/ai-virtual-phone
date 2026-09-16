# companion-server（挂念后端）

挂念的"情绪 / 生活 / 何时发送"迁到 VPS 常驻运行的后端。设计见 `/root/vibe-coding/float/docs-draft/guanian-backend.md`。

独立于 Next.js：不参与 `npm run build`，Node 22 直接运行 TypeScript（类型擦除），只依赖 `web-push`。

## 当前阶段：1（骨架）

| 能力 | 入口 |
|---|---|
| 健康检查 | `GET /health`（无需令牌） |
| 诊断：各角色最近 20 条聊天镜像、快照时间 | `GET /diagnostics` / `npm run diagnose` |
| 接收提示词快照（每角色一份最新） | `PUT /snapshots`，手机端尚未接入 |
| 测试推送（个人云同一对 VAPID + 订阅） | `POST /push/test` / `npm run push-test` |

还没有 tick，不会主动发消息，不影响现有个人云链路。

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
