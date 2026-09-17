// 挂念直连 VPS 后端：起一个真实的后端 HTTP 服务（内存库、影子模式、不跑定时轮），
// 1) 真 Chromium 跑挂念产物，界面读写这个后端；2) 小手机宿主的 guanian-server-sync 在 vm 里连同一个后端。
process.env.TZ = "Asia/Shanghai";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

import { Auth } from "../companion-server/src/auth.ts";
import { hhmm, localDate } from "../companion-server/src/life.ts";
import { Runner } from "../companion-server/src/runner.ts";
import { createApp } from "../companion-server/src/server.ts";
import { Store } from "../companion-server/src/store.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "out/gua-nian-server-direct");
await fs.mkdir(out, { recursive: true });

// ─── 后端
const KEY = "sb_secret_test";
const store = new Store(":memory:");
const now = Date.now();
const TZ = 480;
const today = localDate(now, TZ);
const hm = ms => hhmm(ms, TZ);
const engine = {
  store, userId: "u1",
  rest: async path => new Response(path.startsWith("rpc/push_recheck_") ? "0" : "[]", { status: 200, headers: { "Content-Type": "application/json" } }),
  fetchModel: async () => { throw new Error("测试里不该调模型"); },
  push: async () => ({ total: 0, sent: 0, removed: 0, skippedShell: 0, errors: [] }),
  now: () => Date.now(), random: () => 0.5, log: () => undefined,
};
const runner = new Runner(engine, "shadow");
store.saveCharacter({
  characterId: "c1", sessionId: "sess-c1", name: "赵兖", enabled: true, importedAt: now, updatedAt: now,
  settings: { tzOffsetMin: TZ, quietStart: "23:59", quietEnd: "00:00", quota: 3, momentsOn: 1, momentsWeekly: 3, momentsGapH: 6 },
  state: {
    threads: [
      { id: "t1", kind: "topic", text: "下午开会", since: now - 3600_000, at: now - 3600_000, done: false, by: "cloud" },
      { id: "t2", kind: "topic", text: "晚上吃什么", since: now - 3600_000, at: now - 3600_000, done: false, by: "cloud" },
    ],
    outbox: [{ id: "mo_old", at: now - 7200_000, hint: "旧的起意" }, { id: "mo_new", at: now - 600_000, hint: "窗外的晚霞" }],
    momentsLast: now - 600_000, momentsWeekN: 1, momentsWeekStart: now - 86400_000,
  },
});
store.saveDay({
  characterId: "c1", date: today, selfUsed: 0, recheckCount: 0, judgedAt: now - 600_000, judgedChatAt: 0,
  genTries: 1, genError: "", genLog: [], source: "server", updatedAt: now,
  day: { tz: TZ, mood: "平静", moodEmoji: "🙂", energy: 70, wake: "00:00", bed: "23:59", doing: "上班", location: "公司",
    schedule: [{ time: "00:00", end: "23:50", title: "开会", place: "公司", cost: -5, busy: true }, { time: "23:55", end: "23:58", title: "健身", cost: -3 }], conds: [] },
  items: [
    { time: hm(now - 1800_000), fireAt: now - 1800_000, act: true, why: "早上想到", intent: "早安", wakeId: "w0", generatedAt: now - 1800_000, source: "早安", kind: "plan" },
    { time: hm(now + 1800_000), fireAt: now + 1800_000, act: true, why: "惦记着", intent: "问下午的会开完没", wakeId: "w1", from: "t1", source: "惦记", kind: "thread" },
  ],
});
store.addTimer({ id: "w1", characterId: "c1", date: today, fireAt: now + 3600_000, kind: "thread", status: "pending", note: "在开会，押后" });
store.addDecision("c1", "defer", "押后到开完会", "shadow", { wakeId: "w1" }, now - 60_000);

const server = createApp({ rest: engine.rest, store, userId: "u1", auth: new Auth("admin", async key => key === KEY), startedAt: new Date(), runner, engine });
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const admin = async p => (await fetch(BASE + p, { headers: { Authorization: "Bearer admin" } })).json();

try {
  await browserCheck();
  await hostCheck();
} finally {
  server.close();
}

// ─── 1) 挂念界面
async function browserCheck() {
  const appHtml = await fs.readFile(path.join(root, "custom-apps/gua-nian/index.html"), "utf8");
  const HOST = String.raw`<script>
    (() => {
      const rows = { settings: [{ id: 's1', characterIds: ['c1', 'c2'], characterId: 'c1', serverBrain: true, serverUrl: '${BASE}',
        cloudUrl: 'https://cloud.invalid', cloudKey: '${KEY}', quota: 3, injectChat: true, momentsOn: true }], logs: [] };
      let seq = 0;
      const copy = v => JSON.parse(JSON.stringify(v));
      window.toasts = []; window.calendarWrites = []; window.frozen = [];
      window.confirm = () => true;
      window.AiPhone = {
        app: { getLaunchContext: async () => ({ characterId: 'c1' }) },
        characters: { list: async () => [{ id: 'c1', name: '赵兖' }, { id: 'c2', name: '沈烬言' }] },
        db: {
          list: async (c) => copy(rows[c] || []),
          create: async (c, d) => { const r = { id: c + (++seq), ...d }; (rows[c] = rows[c] || []).push(r); return copy(r); },
          update: async (c, id, d) => { const r = rows[c].find(x => x.id === id); Object.assign(r, d); return copy(r); },
        },
        chat: { readHistory: async ({ characterId }) => ({ sessionId: 'sess-' + characterId, messages: [] }), setContext: async () => ({}), clearContext: async () => ({}), setReplyGate: async () => ({}) },
        push: { freeze: async (spec) => { window.frozen.push(spec.characterId + ':' + spec.key); return { armed: true, id: 'tpl' }; }, unfreeze: async () => ({}), listWakes: async () => [], cancelWake: async () => ({ ok: true }), wake: async () => ({}) },
        variables: { get: async () => null, set: async () => ({}), unset: async () => ({}) },
        calendar: { read: async () => ({ plan: { items: [] } }), write: async (p) => { window.calendarWrites.push(p); return { ok: true }; } },
        moments: { post: async () => ({ postId: 'p1' }) },
        usage: { readDaily: async () => ({ days: [] }) },
        ai: { generate: async () => { throw Error('不该调模型'); } },
        ui: { toast: (m) => { window.toasts.push(String(m)); } },
      };
    })();
  </script>`;
  const TEST = String.raw`
  (async () => {
    const BASE = '${BASE}';
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const until = async (fn, msg, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return; } catch (e) {} await sleep(100); } throw Error('timeout: ' + msg + ' · toasts=' + JSON.stringify(toasts)); };
    let checks = 0;
    const check = (c, m) => { if (!c) throw Error(m); checks++; };
    const admin = async p => (await fetch(BASE + p, { headers: { Authorization: 'Bearer admin' } })).json();
    const c1 = async () => (await admin('/app/state?ids=c1')).characters[0];
    const idle = () => until(() => !cur().busy, 'idle');

    await until(() => S.byId.c1 && S.byId.c1.server && S.byId.c2 && S.byId.c2.server && S.byId.c2.server.exists, 'init pulled and created c2');
    await until(() => frozen.includes('c2:chat'), 'templates frozen');
    check(document.querySelector('.hero .mood-text').textContent.includes('平静'), 'today mood from backend');
    check($('#view').textContent.includes('开会'), 'timeline from backend');
    const created = (await admin('/app/state?ids=c2')).characters[0];
    check(created.sessionId === 'sess-c2' && created.settings.tzOffsetMin === 480 && created.enabled, 'c2 created with session and tz');
    check((await c1()).settings.dayPrompt, 'c1 settings pushed on open');

    switchTab('heart');
    check($('#view').textContent.includes('押后'), 'held badge on heart page');
    check($('#btn-replan').textContent.includes('立刻判一次'), 'replan relabelled');
    check($('#view').textContent.includes('VPS 后端'), 'server tag');
    document.querySelector('.tl-item.wake[data-wake="w1"]').click();
    check($('#dsheet-body').textContent.includes('后端 · ') && $('#dsheet-body').textContent.includes('押后到开完会'), 'detail shows server trace');
    check(!$('#btn-refresh-receipt'), 'no cloud receipt button');
    closeDetail();

    $('#th-plus').click();
    const form = $('#th-add'); form.text.value = '周五面试'; form.when.value = '';
    await form.onsubmit({ preventDefault() {} });
    await until(async () => (await c1()).threads.some(t => t.text === '周五面试'), 'thread added on backend');
    await idle();
    check($('#view').textContent.includes('周五面试'), 'new thread shown');

    S._thOpen = 't1'; render();
    document.querySelector('.th-row[data-tid="t1"] button[data-act="done"]').click();
    await until(async () => { const s = await c1(); return s.threads.find(t => t.id === 't1').done && s.plan.items.find(i => i.wakeId === 'w1').act === false; }, 'done cancels hanging item');
    await idle();
    check(decStatus(cur().plan.items.find(i => i.wakeId === 'w1')).status === 'skipped', 'cancelled item shows skipped');

    S._thOpen = 't2'; render();
    document.querySelector('.th-row[data-tid="t2"] button[data-act="drop"]').click();
    await until(async () => !(await c1()).threads.some(t => t.id === 't2'), 'drop removes topic');
    await idle();

    switchTab('today');
    const si = cur().day.schedule.findIndex(s => s.title === '健身');
    openSchedDetail(si); $('#sd-del').click(); $('#sd-del').click();
    await until(async () => !(await c1()).day.schedule.some(s => s.title === '健身'), 'schedule edit saved on backend');
    check(calendarWrites.some(w => /^guanian_/.test(w.id || '')), 'schedule written back to calendar');

    await idle();
    $('#btn-regen').click();
    await until(() => toasts.some(t => t.includes('影子模式')), 'regenerate reaches backend');
    await idle();
    switchTab('heart'); $('#btn-replan').click();
    await until(() => toasts.some(t => t.includes('后端判了一轮') || t.includes('后端这一轮')), 'tick reaches backend');
    await idle();

    switchTab('archive');
    await until(() => $('#view').textContent.includes('早安'), 'archive from backend');
    check($('#view').textContent.includes('已发出'), 'sent status in archive');

    switchTab('back');
    await until(() => $('#view').textContent.includes('后端判断记录'), 'server diagnostics');
    check($('#view').textContent.includes('了结「下午开会」'), 'decision log shows ledger op');

    openSheet(); $('#set-quota').textContent = '5'; await saveSettings();
    await until(async () => (await c1()).settings.quota === 5, 'settings synced');
    check(toasts.includes('已保存，后端已同步'), 'save toast');

    openSheet(); document.querySelector('.char-cell[data-id="c2"]').classList.remove('sel'); await saveSettings();
    await until(async () => (await admin('/app/state?ids=c2')).characters[0].enabled === false, 'removed character disabled on backend');
    check(S.order.join() === 'c1', 'removed character left the switcher: ' + S.order.join() + ' hidden=' + $('#who-switch').hidden);

    window.guanianCheck = { passed: true, checks };
  })().catch(error => { window.guanianCheck = { passed: false, error: String(error.stack || error) }; });
`;
  let page = appHtml.replace("<script>", HOST + "<script>");
  page = page.replace(/  init\(\);\s*\}\)\(\);\s*<\/script>/, "  init();\n" + TEST + "\n})();</script>");
  if (!page.includes("guanianCheck")) throw Error("init hook not found");
  await fs.writeFile(path.join(out, "index.html"), page);
  const profile = await fs.mkdtemp(path.join(out, "profile-"));
  const child = spawn("chromium", ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-proxy-server", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
    { stdio: "ignore", env: { ...process.env, TZ: "Asia/Shanghai" } });
  process.on("exit", () => { try { child.kill("SIGKILL"); } catch {} });
  let socket;
  try {
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    if (!port) throw new Error("Chromium did not start");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    socket = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
    const pending = new Map(); let serial = 0;
    socket.onmessage = event => { const m = JSON.parse(event.data); if (m.id) { const t = pending.get(m.id); pending.delete(m.id); if (m.error) t.reject(new Error(m.error.message)); else t.resolve(m.result); } };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
    await send("Page.navigate", { url: `file://${out}/index.html` });
    let report;
    for (let i = 0; i < 900; i++) {
      const result = await send("Runtime.evaluate", { expression: "JSON.stringify(window.guanianCheck || null)", returnByValue: true });
      report = JSON.parse(result.result.value || "null");
      if (report) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const shot = await send("Page.captureScreenshot", { format: "png" });
    await fs.writeFile(path.join(out, "last.png"), Buffer.from(shot.data, "base64"));
    if (!report?.passed) throw new Error(JSON.stringify(report || { error: "browser check timed out" }));
    console.log(`PASS 挂念界面直连后端：${report.checks} 项（读今天/心动/详情轨迹/账本增了删/改日程/生成/立刻判/记录/诊断/设置/移除角色）`);
  } finally {
    socket?.close(); child.kill();
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
    await fs.rm(profile, { recursive: true, force: true });
  }
}

// ─── 2) 小手机宿主
async function hostCheck() {
  const read = p => fs.readFile(path.join(root, p), "utf8");
  const strip = src => stripTypeScriptTypes(src).replace(/^import\s[\s\S]*?;\s*$/gm, "").replace(/^export /gm, "");
  const vars = new Map(), gates = new Map(), contexts = new Map(), calendar = new Map(), kv = new Map(), posts = [];
  const events = new EventTarget(), doc = new EventTarget();
  doc.visibilityState = "visible";
  // 地址和钥匙由小手机「离线执行」和「云服务部署」给，挂念设置里不再存
  const settings = { characterIds: ["c1"], serverBrain: true, injectChat: true, routineOn: true };
  calendar.set("c1", [{ id: "cal1", date: today, startTime: "09:00", endTime: "10:00", title: "考试·忙", location: "" }]);
  vars.set("c1:affection", { score: 60, tier: "亲近", relation: "恋人" });
  vars.set("c1:routine", { items: [{ id: "r1", kind: "sleep", from: "23:00", to: "07:00" }] });
  const ctx = vm.createContext({
    console, Date, JSON, Math, Number, String, Object, Array, Map, Set, Promise, AbortController, URLSearchParams, Error,
    fetch, document: doc,
    window: Object.assign(events, { setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout }),
    CUSTOM_APPS_UPDATED_EVENT: "apps", CUSTOM_APP_DATA_UPDATED_EVENT: "data", CHAT_PLUGIN_VARS_CHANGED_EVENT: "vars",
    loadInstalledCustomApps: () => [{ id: "app_gua", manifest: { id: "gua.nian", name: "挂念" }, permissions: ["chat.context"] }],
    readCustomAppCollection: (_app, c) => c === "settings" ? [settings] : [],
    getChatPluginVar: (name, _s, id) => vars.get(`${id}:${name}`) ?? null,
    setChatPluginVar: (name, value, _s, id) => { vars.set(`${id}:${name}`, value); },
    unsetChatPluginVar: (name, _s, id) => { vars.delete(`${id}:${name}`); },
    normalizeReplyGate: g => g, setCustomAppReplyGate: (app, id, g) => { gates.set(id, g); },
    setCustomAppChatContext: (app, name, input) => { contexts.set(input.characterId, input); },
    clearCustomAppChatContext: (app, id) => { contexts.delete(id); },
    postCustomAppMoment: async (record, appId) => { posts.push({ ...record, appId }); return { postId: "post1" }; },
    readCustomAppCalendar: ({ ownerId, date }) => ({ plan: { items: (calendar.get(ownerId) || []).filter(it => it.date === date) } }),
    writeCustomAppCalendar: r => {
      const list = calendar.get(r.ownerId) || [];
      if (r.operation === "delete") calendar.set(r.ownerId, list.filter(it => it.id !== r.itemId));
      else calendar.set(r.ownerId, [...list.filter(it => it.id !== r.id), { id: r.id, date: r.date, startTime: r.startTime, endTime: r.endTime, title: r.title }]);
      return { ok: true };
    },
    kvGet: k => kv.get(k) ?? null, kvSet: (k, v) => { kv.set(k, v); }, registerKvMigration() {},
    companionServerUrl: () => BASE, personalCloudCredentials: () => ({ url: "https://cloud.invalid", key: KEY }),
  });
  vm.runInContext(strip(await read("lib/guanian-presence.ts")) + "\n" + strip(await read("lib/guanian-server-sync.ts")) + "\nglobalThis.start = startGuanianServerSync;", ctx);
  const wait = async (fn, msg) => { for (let i = 0; i < 150; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error("timeout: " + msg); };

  // 浏览器那段「立刻判一次」会整理待发朋友圈，这里重新放两条
  const seeded = store.getCharacter("c1");
  seeded.state.outbox = [{ id: "mo_old", at: Date.now() - 7200_000, hint: "旧的起意" }, { id: "mo_new", at: Date.now() - 600_000, hint: "窗外的晚霞" }];
  seeded.state.momentHistory = [];
  store.saveCharacter(seeded);
  const stop = ctx.start();
  await wait(async () => (await admin("/app/state?ids=c1")).characters[0].moments.history.length === 2, "moments acked");
  const presence = vars.get("c1:presence");
  assert.equal(presence.managedBy, "guanian-server");
  assert.equal(presence.syncStatus, "synced");
  assert.ok(gates.get("c1"), "reply gate published");
  assert.match(contexts.get("c1").text, /在做的事：开会/);
  assert.match(contexts.get("c1").label, /\d\d:\d\d 的状态/);
  const wrote = calendar.get("c1").filter(it => /^guanian_/.test(it.id));
  assert.ok(wrote.some(it => it.title === "开会"), "schedule written back");
  assert.ok(calendar.get("c1").some(it => it.id === "cal1"), "manual calendar entry kept");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].requestId, "server:mo_new");
  const st = (await admin("/app/state?ids=c1")).characters[0];
  assert.deepEqual(st.moments.history.map(h => [h.id, h.status]).sort(), [["mo_new", "sent"], ["mo_old", "skipped"]]);
  assert.equal(vars.get("c1:moments").weekN, st.moments.weekN);
  assert.equal(vars.get("c1:moments").weeklyTarget, 3);
  await wait(() => store.getCalendar("c1", today), "inputs uploaded");
  assert.deepEqual(store.getCalendar("c1", today).items.map(i => [i.startTime, i.title, i.lock]), [["09:00", "考试", "busy"]]);
  assert.deepEqual(store.getCalendar("c1", today).routine, { wake: "07:00", bed: "23:00" });
  assert.equal(store.getCharacter("c1").settings.affection.relation, "恋人");

  // 再跑一轮：不重发、不重写日程
  const writesBefore = JSON.stringify(calendar.get("c1"));
  settings.injectChat = false;
  events.dispatchEvent(new CustomEvent("data", { detail: { collection: "settings" } }));
  await wait(() => contexts.get("c1") && contexts.get("c1").text === "", "injectChat off clears context");
  assert.equal(posts.length, 1);
  assert.equal(JSON.stringify(calendar.get("c1")), writesBefore);

  // 挂念里不再挂念这位：撤掉状态
  settings.characterIds = [];
  events.dispatchEvent(new CustomEvent("data", { detail: { collection: "settings" } }));
  await wait(() => !vars.has("c1:presence") && gates.get("c1") === null && !contexts.has("c1"), "released when removed");
  stop();
  console.log("PASS 宿主从后端取状态：在线状态/回复闸门/注入聊天/写回日程/朋友圈补发与回执/好感与作息上传/关注入/移除角色");
}
