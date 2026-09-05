import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { checkGuaNianBuild } from "./build-gua-nian.mjs";

checkGuaNianBuild();
const source = fs.readFileSync(new URL("../custom-apps/gua-nian/index.html", import.meta.url), "utf8").match(/<script>([\s\S]*)<\/script>/)[1];
const now = Date.parse("2026-09-04T16:00:00Z");
class Clock extends Date { static now() { return now; } }
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function app() {
  const h = { sheet: {}, toasts: [], calls: [], cloudFetch: async () => ({ ok: true }), stored: null };
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "", hidden: false, disabled: false,
      querySelectorAll(selector) {
        if (selector !== "[data-sync-retry]") return [];
        return [...this.innerHTML.matchAll(/data-sync-retry="([^"]+)"([^>]*)/g)].map((m) => ({ dataset: { syncRetry: m[1] }, disabled: m[2].includes("disabled") }));
      },
    });
    return elements.get(id);
  };
  const classes = new Set();
  const document = {
    body: { classList: { add: (x) => classes.add(x), remove: (x) => classes.delete(x), contains: (x) => classes.has(x) } },
    querySelector: (id) => id === "#btn-refresh-receipt" && !el("#dsheet-body").innerHTML.includes('id="btn-refresh-receipt"') ? null : el(id),
    querySelectorAll: (selector) => selector === ".char-cell.sel" ? [{ dataset: { id: "c" } }] : [],
  };
  const ctx = vm.createContext({ Date: Clock, document, h, URLSearchParams, console, AbortController,
    setTimeout: (fn) => { h.timeout = fn; return 1; }, clearTimeout: () => {},
    AiPhone: { db: {
      list: async (table) => table === "plans" ? [h.cx.plan] : [],
      update: async (table, _id, patch) => {
        if (table === "plans") return h.cx.plan = { ...h.cx.plan, ...patch };
        h.stored = { ...h.stored, ...patch }; return h.stored;
      },
    } },
  });
  const expose = `
    cloudFetch = (...args) => { h.calls.push(args); return h.cloudFetch(...args); };
    cloudContext = () => ({ quota: S.settings.quota, ...userSleepContext() });
    log = async () => {};
    render = () => renderCloudSync();
    toast = (message) => h.toasts.push(message);
    syncChatContext = async () => {};
    syncUsageCloud = async () => {};
    readSheet = () => h.sheet;
    globalThis.api = { S, ctxOf, cur, refreshReceipts, decStatus, detailHtml, openDetail, closeDetail,
      uploadPlanCloud, syncSavedPlan, pullCloudDecisionsBody, planSyncState, retryPlanSync, renderCloudSync, saveSettings, renderArchive, todayStr, settingsSaveEffects, validateUserSleepSettings, userSleepContext, SET_DEF };
  `;
  vm.runInContext(source.replace(/  init\(\);\s*\}\)\(\);\s*$/, expose + "\n})();"), ctx);
  const a = ctx.api;
  a.S.settings = h.stored = { id: "settings", cloudUrl: "https://cloud.invalid", cloudKey: "test", cloudRecheck: true, quota: 4, characterIds: ["c"], deviceId: "mine" };
  const cx = a.ctxOf({ id: "c", name: "角色" });
  h.cx = cx;
  cx.plan = { id: "p", date: a.todayStr(), characterId: "c", items: [] };
  a.S.byId.c = cx; a.S.cur = "c"; a.S.order = ["c"]; a.S.characters = [cx.character];
  return { a, cx, h, el };
}
const slot = (key = "w") => ({ act: true, wakeId: key, time: "09:00", fireAt: now - 3600000, delivery: "push" });
const job = (key = "w", status = "done", resultNote = "generated, pushed 1") => ({ triggerKey: "timedwake:" + key, status, resultNote, updatedAt: new Date(now - 10000).toISOString() });
function answerJobs(h, jobs) { h.cloudFetch = async (_action, _init, p) => ({ ok: true, queriedTriggerKeys: JSON.parse(p.triggerKeys), jobs }); }
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("✓ " + name); }

await test("普通聊天、无回执、旧网关都不会被标为已发出", async () => {
  const { a, cx, h } = app(), w = slot();
  const ordinary = [{ role: "assistant", t: w.fireAt, c: "普通回复" }, { role: "user", t: now, c: "回话" }];
  assert.equal(a.decStatus(w, ordinary).status, "unknown");
  h.cloudFetch = async () => ({ ok: true, jobs: [job()] });
  await a.refreshReceipts(cx, [w]);
  assert.equal(a.decStatus(w).status, "unknown");
  assert.match(a.decStatus(w).explanation, /版本偏旧/);
  answerJobs(h, []); await a.refreshReceipts(cx, [w], true);
  assert.equal(a.decStatus(w).status, "unknown");
  assert.equal(a.decStatus({ ...w, wakeId: "", fireAt: now + 10000 }).status, "pending");
  assert.equal(a.decStatus({ ...w, wakeId: "" }).status, "unknown");
});
await test("25 条回执分批精确匹配，其他预约和角色不串号", async () => {
  const { a, cx, h } = app(), slots = Array.from({ length: 25 }, (_, i) => slot("w" + i));
  answerJobs(h, [...slots.map((w) => job(w.wakeId)), job("unrelated")]);
  await a.refreshReceipts(cx, slots);
  assert.deepEqual(h.calls.map((x) => JSON.parse(x[2].triggerKeys).length), [20, 5]);
  assert.ok(slots.every((w) => a.decStatus(w).status === "sent"));
  assert.equal(a.decStatus(slot("unrelated")).status, "unknown");
  assert.equal(a.decStatus(slot("w0"), null, a.ctxOf({ id: "other" })).status, "unknown");
  a.S.settings.cloudUrl = "https://other.invalid";
  assert.equal(a.decStatus(slot("w0")).status, "unknown");
});
await test("成功、失败、取消、拦截、押后和生成中分别显示", async () => {
  const { a, cx, h } = app();
  for (const [status, note, expected] of [
    ["done", "generated, pushed 0", "sent"], ["done", "sent", "sent"],
    ["failed", "model failed", "failed"], ["cancelled", "cancelled", "cancelled"],
    ["done", "presend skip: busy", "skipped"], ["done", "guanian asleep", "skipped"],
    ["done", "no_subscription", "skipped"], ["done", "", "unknown"], ["done", "sentinel", "unknown"],
    ["pending", "hold: busy", "pending"], ["running", "generating", "running"],
  ]) {
    answerJobs(h, [job("w", status, note)]); await a.refreshReceipts(cx, [slot()], true);
    assert.equal(a.decStatus(slot()).status, expected, note);
  }
});
await test("刷新失败保留已确认结果，进行中旧状态改为待确认，重试可恢复", async () => {
  const { a, cx, h } = app();
  answerJobs(h, [job(), job("running", "running", "working")]);
  await a.refreshReceipts(cx, [slot(), slot("running")]);
  h.cloudFetch = async () => { throw Error("offline"); };
  await a.refreshReceipts(cx, [slot(), slot("running")], true);
  assert.equal(a.decStatus(slot()).status, "sent");
  assert.equal(a.decStatus(slot("running")).status, "unknown");
  assert.match(a.detailHtml(slot(), cx.plan), /本次刷新失败/);
  answerJobs(h, [job("running")]); await a.refreshReceipts(cx, [slot("running")], true);
  assert.equal(a.decStatus(slot("running")).status, "sent");
});
await test("详情按钮确实刷新回执，失败原因经过 HTML 转义", async () => {
  const { a, cx, h, el } = app();
  answerJobs(h, [job("w", "failed", '<img src=x onerror="bad()">')]);
  a.openDetail(slot(), cx.plan); await cx._receiptQ;
  await Promise.resolve();
  assert.match(el("#dsheet-body").innerHTML, /发送失败/);
  assert.ok(!el("#dsheet-body").innerHTML.includes('<img src=x'));
  assert.equal(typeof el("#btn-refresh-receipt").onclick, "function");
  answerJobs(h, [job()]); await el("#btn-refresh-receipt").onclick();
  assert.match(el("#dsheet-body").innerHTML, /已发出/);
  assert.ok(!el("#dsheet-body").innerHTML.includes("你还没回"));
});
await test("上传失败持久保留提示，重启后能重试；成功后清除失败状态", async () => {
  const { a, cx, h, el } = app();
  h.cloudFetch = async () => { throw Error("offline"); };
  const first = await a.uploadPlanCloud(cx, true);
  assert.equal(first.status, "failed"); assert.equal(h.stored.planSync.c.resetDecisions, true);
  assert.match(el("#cloud-sync").innerHTML, /云端同步未完成/);
  assert.match(el("#cloud-sync").innerHTML, /重试同步/);
  delete cx._planSync; // 模拟页面重开，只保留设置中的持久状态。
  assert.equal(a.planSyncState(cx).status, "failed");
  h.cloudFetch = async (_action, init) => init.method === "GET" ? { ok: true, plan: null } : { ok: true };
  await a.retryPlanSync(cx);
  const post = h.calls.filter((x) => x[1].method === "POST").at(-1);
  assert.equal(JSON.parse(post[1].body).resetDecisions, true);
  assert.equal(a.planSyncState(cx).status, "synced"); assert.equal(h.stored.planSync.c.resetDecisions, false);
  assert.ok(!el("#cloud-sync").innerHTML.includes("重试同步"));
});
await test("重试前读云端失败时不上传，避免覆盖未合并的预约", async () => {
  const { a, cx, h } = app();
  h.cloudFetch = async () => { throw Error("offline"); };
  await a.retryPlanSync(cx);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][1].method, "GET");
  assert.equal(a.planSyncState(cx).status, "failed"); assert.equal(cx._planLock, false);
});
await test("同步请求 15 秒超时后退出处理中，可以再次重试", async () => {
  const { a, cx, h } = app(), started = deferred();
  h.cloudFetch = async (_action, init) => {
    started.resolve();
    await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Error("aborted"))));
  };
  const run = a.uploadPlanCloud(cx, false); await started.promise; h.timeout();
  assert.equal((await run).status, "failed");
  assert.match(a.planSyncState(cx).message, /15 秒/);
});
await test("连续上传串行执行，最终状态属于最新请求", async () => {
  const { a, cx, h } = app(), gate = deferred(), started = deferred();
  let posts = 0;
  h.cloudFetch = async () => { if (++posts === 1) { started.resolve(); await gate.promise; throw Error("old failed"); } return { ok: true }; };
  const first = a.uploadPlanCloud(cx, false); await started.promise;
  const second = a.uploadPlanCloud(cx, false);
  assert.equal(posts, 1); gate.resolve(); await Promise.all([first, second]);
  assert.equal(posts, 2); assert.equal(a.planSyncState(cx).status, "synced");
});
await test("部分上传和其他设备负责不误报成功，跨天不上传旧计划", async () => {
  const { a, cx, h } = app();
  h.cloudFetch = async () => ({ ok: true, dropped: ["day"] });
  assert.equal((await a.uploadPlanCloud(cx, false)).status, "partial");
  cx.owner = { id: "other", name: "电脑" };
  const calls = h.calls.length;
  assert.equal((await a.uploadPlanCloud(cx, false)).status, "readonly");
  await a.retryPlanSync(cx); assert.equal(h.calls.length, calls);
  cx.owner = null; cx.plan.date = "2020-01-01";
  assert.equal((await a.uploadPlanCloud(cx, false)).status, "no-plan");
  assert.equal(a.planSyncState(cx), null);
});
await test("保存设置明确区分本地保存与云端同步结果", async () => {
  for (const [outcome, expected] of [["failed", /本地已保存，云端同步未完成/], ["partial", /云端同步未完成/], ["synced", /现有计划已同步云端/]]) {
    const { a, h } = app();
    h.sheet = { quota: 7 };
    h.cloudFetch = async (_action, init) => {
      if (init.method === "GET") return { ok: true, plan: null };
      if (outcome === "failed") throw Error("offline");
      return { ok: true, ...(outcome === "partial" ? { dropped: ["day"] } : {}) };
    };
    await a.saveSettings();
    assert.equal(h.stored.quota, 7); assert.match(h.toasts.at(-1), expected);
  }
});
await test("设置生效提示按实际改动区分新规则、已有预约和明日生成", async () => {
  const { a } = app();
  const before = { ...a.S.settings, impulseMode: 1, maxUnanswered: 2, autoGen: false, cloudGen: false };
  assert.equal(a.settingsSaveEffects(before, { ...before }).length, 0);
  const live = a.settingsSaveEffects(before, { ...before, quota: 5 }).join(" ");
  assert.match(live, /下一次云端起念/); assert.match(live, /已有预约保持原样/);
  assert.ok(!live.includes("重置今天"));
  const fixed = a.settingsSaveEffects({ ...before, impulseMode: 0 }, { ...before, impulseMode: 0, minGapMin: 90 }).join(" ");
  assert.match(fixed, /重新编排/);
  assert.match(a.settingsSaveEffects(before, { ...before, maxUnanswered: 4 }).join(" "), /临时起念也不会自动更新/);
  assert.match(a.settingsSaveEffects(before, { ...before, impulseMode: 0 }).join(" "), /已有预约不会自动转换/);
  assert.match(a.settingsSaveEffects(before, { ...before, autoGen: true, cloudGen: true }).join(" "), /不代表明日设置已更新/);
});
await test("保存显示生效说明，同时保留云端失败提示和当前预约", async () => {
  const { a, cx, h, el } = app();
  cx.plan.items = [slot()]; const original = JSON.stringify(cx.plan.items);
  h.sheet = { quota: 6, maxUnanswered: 5 };
  h.cloudFetch = async () => { throw Error("offline"); };
  await a.saveSettings();
  assert.match(el("#settings-effects").innerHTML, /生效说明/);
  assert.match(el("#settings-effects").innerHTML, /已有预约保留原阈值/);
  assert.match(el("#cloud-sync").innerHTML, /同步未完成/);
  assert.equal(JSON.stringify(cx.plan.items), original);
});
await test("用户睡眠默认关闭，独立保存且非法时段不写入设置", async () => {
  const { a, h } = app();
  assert.equal(a.SET_DEF.userSleepOn, false);
  a.validateUserSleepSettings({ userSleepOn: false, userSleepStart: "", userSleepEnd: "" });
  a.validateUserSleepSettings({ userSleepOn: true, userSleepStart: "01:00", userSleepEnd: "09:00" });
  for (const [start, end] of [["01:00", "01:00"], ["24:30", "09:00"], ["01:00", ""]]) {
    h.sheet = { userSleepOn: true, userSleepStart: start, userSleepEnd: end };
    await assert.rejects(a.saveSettings(), /睡眠/);
    assert.equal(h.stored.userSleepOn, undefined);
  }
  h.sheet = { userSleepOn: true, userSleepStart: "01:00", userSleepEnd: "09:00" };
  await a.saveSettings();
  assert.equal(h.stored.userSleepOn, true);assert.equal(h.stored.userSleepStart, "01:00");
  const cloud = a.userSleepContext();
  assert.equal(cloud.userSleepOn, 1);assert.equal(cloud.userSleepEnd, "09:00");
  assert.equal(typeof cloud.userSleepTimeZone, "string");assert.equal(typeof cloud.userSleepTz, "number");
  assert.match(a.S._settingsEffects.join(" "), /旧|已结算记录不重算/);
  h.sheet = { userSleepOn: false, userSleepStart: "01:00", userSleepEnd: "09:00" };
  await a.saveSettings();assert.equal(a.userSleepContext().userSleepOn, 0);
  assert.match(a.S._settingsEffects.join(" "), /恢复按发送后 3 小时/);
});
await test("普通保存遇到读取失败不上传旧计划，重试保留重置标记", async () => {
  const { a, cx, h } = app();
  cx._planSync = { date: a.todayStr(), cloudUrl: a.S.settings.cloudUrl, resetDecisions: true };
  h.sheet = { quota: 5 };
  h.cloudFetch = async () => { throw Error("offline"); };
  await a.saveSettings();
  assert.equal(h.stored.quota, 5);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][1].method, "GET");
  assert.match(a.planSyncState(cx).message, /未上传本地计划/);
  assert.equal(a.planSyncState(cx).resetDecisions, true);
  assert.match(h.toasts.at(-1), /云端同步未完成/);
});
await test("关闭复核必须收到云端确认，失败提示在关闭状态和重开页面后仍可重试", async () => {
  const { a, cx, h, el } = app();
  h.sheet = { cloudRecheck: false };
  h.cloudFetch = async () => { throw Error("旧云端不支持"); };
  await a.saveSettings();
  assert.equal(a.S.settings.cloudRecheck, false);
  assert.equal(h.calls[0][0], "recheck-control");
  assert.equal(JSON.parse(h.calls[0][1].body).enabled, false);
  assert.match(el("#cloud-sync").innerHTML, /可能仍在运行/);
  assert.match(el("#cloud-sync").innerHTML, /重试同步/);
  delete cx._planSync; cx.plan = null;
  assert.equal(a.planSyncState(cx).operation, "control");
  h.cloudFetch = async () => ({ ok: true }); // 旧接口的空成功不能确认停用。
  await a.retryPlanSync(cx); assert.equal(a.planSyncState(cx).status, "failed");
  h.cloudFetch = async () => ({ ok: true, recheckEnabled: false, capabilities: ["recheck-control-v1"] });
  await a.retryPlanSync(cx);
  assert.equal(a.planSyncState(cx).status, "synced");
  assert.match(el("#cloud-sync").innerHTML, /云端已确认关闭/);
  assert.ok(h.calls.every(call => call[0] === "recheck-control"));
});
await test("普通保存先合并云端新增预约再上传，保留新预约的任务编号", async () => {
  const { a, cx, h } = app();
  const extra = { ...slot("cloud-new"), time: "18:00", fireAt: now + 3600000, kind: "extra" };
  h.sheet = { quota: 5 };
  h.cloudFetch = async (_action, init) => init.method === "GET" ? {
    plan: { plan_date: a.todayStr(), context: {}, items: [extra], decisions: [{ at: now - 1, by: "cloud", time: "18:00", kind: "extra" }] },
  } : { ok: true };
  await a.saveSettings();
  const uploaded = JSON.parse(h.calls.find(call => call[1].method === "POST")[1].body);
  assert.equal(uploaded.items[0].wakeId, "cloud-new"); assert.equal(cx.plan.items[0].wakeId, "cloud-new");
  assert.equal(a.planSyncState(cx).status, "synced");
  assert.deepEqual(h.calls.map(call => call[1].method), ["GET", "DELETE", "POST"]);
});
await test("重新开启时上传失败不遗失云端开关操作，重试会恢复未来计划", async () => {
  const { a, cx, h } = app();
  a.S.settings.cloudRecheck = false; h.sheet = { cloudRecheck: true };
  h.cloudFetch = async (_action, init) => { if (init.method === "GET") return { plan: null }; throw Error("upload failed"); };
  await a.saveSettings();
  assert.equal(a.planSyncState(cx).operation, "control"); assert.equal(a.planSyncState(cx).enabled, true);
  h.cloudFetch = async (action, init) => action === "recheck-control"
    ? { ok: true, recheckEnabled: true, capabilities: ["recheck-control-v1"] }
    : init.method === "GET" ? { plan: null } : { ok: true };
  await a.retryPlanSync(cx);
  assert.equal(a.planSyncState(cx).status, "synced");
  assert.equal(h.calls.at(-1)[0], "recheck-control");
  assert.equal(JSON.parse(h.calls.at(-1)[1].body).enabled, true);
});
await test("睡眠设置检查实际云函数能力和字段回显，旧版或不匹配不报同步成功", async () => {
  const { a, cx, h } = app();
  Object.assign(a.S.settings, { userSleepOn: true, userSleepStart: "01:00", userSleepEnd: "09:00" });
  h.cloudFetch = async () => ({ ok: true, capabilities: [] });
  assert.equal((await a.uploadPlanCloud(cx)).status, "failed");
  assert.ok(h.calls.every(call => call[0] === "recheck-capabilities"));
  let ack;
  h.cloudFetch = async action => action === "recheck-capabilities"
    ? { ok: true, capabilities: ["user-sleep-feedback-v1"] } : { ok: true, acceptedUserSleep: ack };
  assert.equal((await a.uploadPlanCloud(cx)).status, "partial");
  const expected = a.userSleepContext();
  ack = { enabled: 1, start: expected.userSleepStart, end: expected.userSleepEnd, timeZone: expected.userSleepTimeZone, tz: expected.userSleepTz + 60 };
  assert.equal((await a.uploadPlanCloud(cx)).status, "partial");
  ack.tz = expected.userSleepTz;
  assert.equal((await a.uploadPlanCloud(cx)).status, "synced");
});
await test("回音去重记录满 60 条仍合并云端新键，重复读取不丢本地未上传键", async () => {
  const { a, cx, h } = app();
  cx.plan.fbSeen = Array.from({ length: 60 }, (_, i) => "w" + i);
  const cloudSeen = Array.from({ length: 60 }, (_, i) => "w" + (i + 1));
  h.cloudFetch = async () => ({ plan: { plan_date: a.todayStr(), context: { fbSeen: cloudSeen }, decisions: [] } });
  await a.pullCloudDecisionsBody(cx, true);
  assert.equal(cx.plan.fbSeen.length, 60); assert.ok(cx.plan.fbSeen.includes("w60"));
  cx.plan.fbSeen = ["local-only", "w60"];
  h.cloudFetch = async () => ({ plan: { plan_date: a.todayStr(), context: { fbSeen: ["w60", "cloud-only"] }, decisions: [] } });
  await a.pullCloudDecisionsBody(cx, true); await a.pullCloudDecisionsBody(cx, true);
  assert.deepEqual(Array.from(cx.plan.fbSeen), ["local-only", "w60", "cloud-only"]);
});
console.log(`Passed ${passed} gua-nian delivery/sync checks.`);
