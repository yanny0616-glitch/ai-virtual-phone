// 挂念后端入口：HTTP 接口 + 每分钟一轮的大脑 + 唤醒后端（每 15 秒领一次事件）。第一次启动时从个人云迁入设置、账本和提示词模板。

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { Auth, supabaseKeyCheck } from "./auth.ts";
import { loadConfig } from "./config.ts";
import type { EngineDeps } from "./engine.ts";
import { importFromCloud } from "./importer.ts";
import { sendPushMessages } from "./push.ts";
import { Runner } from "./runner.ts";
import { createApp } from "./server.ts";
import { Store } from "./store.ts";
import { createCloud, createRest, resolveUserId } from "./supabase.ts";
import { localGateway, WakeService } from "./wake.ts";

const config = loadConfig();

if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
chmodSync(config.dataDir, 0o700);
const dbPath = join(config.dataDir, "companion.db");
const store = new Store(dbPath);
chmodSync(dbPath, 0o600);

const recovered = store.recoverRunningTimers();
if (recovered) console.log(`[companion] 上次退出时有 ${recovered} 条正在生成，已放回待发（重发前先核对投递凭据）`);

const rest = createRest(config);
const cloud = createCloud(config);
const userId = await resolveUserId(rest, config.userId);

if (!store.listCharacters().length) {
  const report = await importFromCloud(rest, store, userId);
  console.log("[companion] 从个人云迁入：" + report.characters.map(c => `${c.name || c.characterId}（${c.skipped || `日子 ${c.days.length}，快照 ${c.snapshots.join("/") || "无"}`}）`).join("；"));
}

const engine: EngineDeps = {
  store, rest, userId,
  fetchModel: (url, init) => fetch(url, init),
  push: messages => sendPushMessages(rest, userId, messages, undefined, undefined, cloud),
  cloud,
  cloudKey: config.personalKey,
  now: () => Date.now(),
  random: Math.random,
  log: line => console.log(line),
};
const runner = new Runner(engine, config.mode);
const auth = new Auth(config.apiToken, supabaseKeyCheck(config.personalUrl));
// 唤醒后端：领本机事件网关里交给后端的事件（令牌文件缺失时每轮报错但不影响挂念）
const wake = new WakeService(
  { store, rest, userId, fetchModel: (url, init) => fetch(url, init), push: engine.push, now: () => Date.now(), log: line => console.log(line) },
  localGateway(config.wakeGatewayUrl, config.wakeGatewayTokenFile),
);
const deps = { rest, store, userId, auth, startedAt: new Date(), runner, engine, wake };
// 每个地址一个 server：127.0.0.1 给命令行，Docker 网桥地址给站点反代（/companion/…）
const servers = config.bind.map(host => {
  const server = createApp(deps);
  server.listen(config.port, host, () => console.log(`[companion] 监听 ${host}:${config.port}`));
  return server;
});
console.log(`[companion] 已启动，模式 ${runner.mode === "live" ? "真发" : "影子"}`);
runner.start();
if (config.wakeEnabled) wake.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    runner.stop();
    wake.stop();
    let open = servers.length;
    for (const server of servers) server.close(() => { if (--open === 0) { store.close(); process.exit(0); } });
  });
}
