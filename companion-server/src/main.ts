// 挂念后端入口。阶段 1：健康检查、诊断、快照接收、测试推送；还没有 tick。

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "./config.ts";
import { createApp } from "./server.ts";
import { Store } from "./store.ts";
import { createRest, resolveUserId } from "./supabase.ts";

const config = loadConfig();
if (!config.apiToken) throw new Error("COMPANION_API_TOKEN 未配置");

if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
chmodSync(config.dataDir, 0o700);
const dbPath = join(config.dataDir, "companion.db");
const store = new Store(dbPath);
chmodSync(dbPath, 0o600);

const rest = createRest(config);
const userId = await resolveUserId(rest, config.userId);
const server = createApp({ rest, store, userId, apiToken: config.apiToken, startedAt: new Date() });

server.listen(config.port, "127.0.0.1", () => {
  console.log(`[companion] 已启动 127.0.0.1:${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => { store.close(); process.exit(0); });
  });
}
