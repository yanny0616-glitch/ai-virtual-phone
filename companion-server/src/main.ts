// 挂念后端入口：HTTP 接口 + 每分钟一轮的大脑 + 唤醒后端（每 15 秒领一次事件）+ 离线任务 + 微信助手。第一次启动时从个人云迁入设置、账本和提示词模板。

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { Auth, supabaseKeyCheck } from "./auth.ts";
import { loadConfig } from "./config.ts";
import type { EngineDeps } from "./engine.ts";
import { importFromCloud } from "./importer.ts";
import { PushWatch, tickAge, WATCHDOG_MS } from "./health.ts";
import { guardedFetch } from "./net-guard.ts";
import { runOfflineJobs } from "./jobs.ts";
import { sendPushMessages } from "./push.ts";
import { Runner } from "./runner.ts";
import { createApp } from "./server.ts";
import { Store } from "./store.ts";
import { createCloud, createRest, resolveUserId } from "./supabase.ts";
import { localGateway, WakeService } from "./wake.ts";
import { WeixinService } from "./weixin.ts";

const config = loadConfig();

if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
chmodSync(config.dataDir, 0o700);
const dbPath = join(config.dataDir, "companion.db");
const store = new Store(dbPath);
chmodSync(dbPath, 0o600);

const recovered = store.recoverRunningTimers();
if (recovered) console.log(`[companion] 上次退出时有 ${recovered} 条正在生成，已放回待发（重发前先核对投递凭据）`);
const recoveredJobs = store.recoverRunningJobs(Date.now());
if (recoveredJobs) console.log(`[companion] 上次退出时有 ${recoveredJobs} 条离线任务正在跑，已放回待发（已成文的不重新生成）`);

const rest = createRest(config);
const cloud = createCloud(config);
const userId = await resolveUserId(rest, config.userId);

if (!store.listCharacters().length) {
  const report = await importFromCloud(rest, store, userId);
  console.log("[companion] 从个人云迁入：" + report.characters.map(c => `${c.name || c.characterId}（${c.skipped || `日子 ${c.days.length}，快照 ${c.snapshots.join("/") || "无"}`}）`).join("；"));
}

// 模型 / MCP 地址是手机寄来的：指向本机或内网的不请求，不跟随跳转
const outbound = guardedFetch(config.allowHosts);
// 退出时用它打断挂念这一轮里还没回来的模型调用（唤醒和回复兜底不打断，它们各有自己的重启恢复）
const shutdown = new AbortController();
let stopping = false;

// 每次推送的结果记一笔，/health 和 /status 看得到「推不出去」
const pushWatch = new PushWatch();
const engine: EngineDeps = {
  store, rest, userId,
  fetchModel: (url, init) => outbound(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, shutdown.signal]) : shutdown.signal }),
  stopping: () => stopping,
  push: async messages => {
    try {
      const result = await sendPushMessages(rest, userId, messages, undefined, undefined, cloud);
      pushWatch.record(Date.now(), result);
      return result;
    } catch (e) { pushWatch.record(Date.now(), null, e instanceof Error ? e.message : String(e)); throw e; }
  },
  cloud,
  cloudKey: config.personalKey,
  now: () => Date.now(),
  random: Math.random,
  log: line => console.log(line),
};
const runner = new Runner(engine, config.mode, { detachGeneration: true });
const auth = new Auth(config.apiToken, supabaseKeyCheck(config.personalUrl));
// 唤醒后端：领本机事件网关里交给后端的事件（令牌文件缺失时每轮报错但不影响挂念）
const wake = new WakeService(
  { store, rest, userId, fetchModel: outbound, fetchMcp: outbound, push: engine.push, now: () => Date.now(), log: line => console.log(line) },
  localGateway(config.wakeGatewayUrl, config.wakeGatewayTokenFile),
);
// 微信助手：小手机「离线执行」选后端并开着自动回复时，由这里代替云函数轮询（开关存在 meta，重启后照旧）
const weixin = new WeixinService({ store, url: config.personalUrl, key: config.personalKey, log: line => console.log(line) });
const deps = { rest, store, userId, auth, startedAt: new Date(), runner, engine, wake, weixin, pushWatch };
// 每个地址一个 server：127.0.0.1 给命令行，Docker 网桥地址给站点反代（/companion/…）
const servers = config.bind.map(host => {
  const server = createApp(deps);
  server.listen(config.port, host, () => console.log(`[companion] 监听 ${host}:${config.port}`));
  return server;
});
console.log(`[companion] 已启动，模式 ${runner.mode === "live" ? "真发" : "影子"}`);
runner.start();
if (config.wakeEnabled) wake.start();
weixin.start();
// 离线任务（回复兜底要在 App 被杀后 90 秒左右接上）：每 15 秒看一次，上一轮没跑完就跳过
let jobsRunning = false;
const jobsTimer = setInterval(() => {
  if (jobsRunning) return;
  jobsRunning = true;
  runOfflineJobs(engine).catch(e => console.log(`[companion] 离线任务执行失败：${e instanceof Error ? e.message : String(e)}`)).finally(() => { jobsRunning = false; });
}, 15_000);

// 看门狗：一轮卡住半小时（某个没设超时的调用挂死了）就自己退出，systemd 会拉起来；
// 重启时正在生成的念头放回待发，重发前先核对投递凭据，不会重复发
const watchdog = setInterval(() => {
  const age = tickAge(runner, deps.startedAt.getTime(), Date.now());
  if (age <= WATCHDOG_MS) return;
  console.error(`[companion] 已经 ${Math.round(age / 60_000)} 分钟没跑完一轮，判定卡死，退出等 systemd 重启`);
  process.exit(1);
}, 60_000);
watchdog.unref();

// 优雅退出：先不接新活，给正在跑的一轮留时间自然跑完（消息写到一半就让它发完）；
// 还没完就打断模型调用，让它走完收尾（放掉个人云里的会话租约、把念头放回待发），再关库退出。
// 以前是直接退：会话租约要在个人云里占满 10 分钟，重启后模型还得重新调一遍。
const NATURAL_MS = 30_000, ABORT_MS = 10_000;
async function waitIdle(ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  const busy = () => runner.busy || jobsRunning;
  while (busy() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 200));
  return !busy();
}
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[companion] 收到 ${signal}，收尾后退出`);
  runner.stop();
  wake.stop();
  weixin.stop();
  clearInterval(jobsTimer);
  clearInterval(watchdog);
  for (const server of servers) server.close();
  if (!await waitIdle(NATURAL_MS)) {
    console.log("[companion] 这一轮还没跑完，打断模型调用，重启后接着做");
    shutdown.abort(new Error("后端正在重启"));
    if (!await waitIdle(ABORT_MS)) console.log("[companion] 收尾超时，直接退出（正在生成的念头重启时会放回待发）");
  }
  for (const server of servers) server.closeAllConnections();
  store.close();
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void stop(signal); });
