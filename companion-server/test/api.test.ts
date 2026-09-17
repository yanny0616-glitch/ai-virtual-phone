import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { handleApp, type AppDeps } from "../src/api.ts";
import { Auth, supabaseKeyCheck } from "../src/auth.ts";
import { chatContextText } from "../src/context.ts";
import type { EngineDeps } from "../src/engine.ts";
import { fixedForDay } from "../src/routine.ts";
import { Runner } from "../src/runner.ts";
import { createApp } from "../src/server.ts";
import { Store } from "../src/store.ts";

const CID = "char_api";
const at = (local: string) => Date.parse(local + ":00+08:00");

function setup(nowLocal = "2026-09-16T15:00") {
  const store = new Store(":memory:");
  let now = at(nowLocal);
  const logs: string[] = [];
  const engine: EngineDeps = {
    store, rest: async () => new Response("[]", { status: 200 }), userId: "u1",
    fetchModel: async () => { throw new Error("不该调模型"); },
    push: async () => ({ total: 0, sent: 0, removed: 0, skippedShell: 0, errors: [] }),
    now: () => now, random: () => 0.5, log: line => { logs.push(line); },
  };
  const runner = new Runner(engine, "shadow");
  const deps: AppDeps = { store, runner, engine };
  const call = async (method: string, path: string, body?: unknown) => {
    const [p, q = ""] = path.split("?");
    const r = await handleApp(deps, method, p, new URLSearchParams(q), async () => body ?? {});
    assert.ok(r, "应当是 /app 路由");
    return r as { status: number; body: any };
  };
  return { store, engine, runner, deps, call, logs, setNow: (l: string) => { now = at(l); } };
}

async function withCharacter(env: ReturnType<typeof setup>) {
  const r = await env.call("POST", `/app/characters/${CID}`, { name: "赵兖", sessionId: "sess1", settings: { tzOffsetMin: 480, quietStart: "23:30", quietEnd: "07:30", bogus: 1 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, true);
  env.store.saveDay({
    characterId: CID, date: "2026-09-16", selfUsed: 0, recheckCount: 0, judgedAt: 0, judgedChatAt: 0,
    genTries: 0, genError: "", genLog: [], source: "server", updatedAt: 0,
    day: { tz: 480, mood: "平静", energy: 70, wake: "08:00", bed: "23:30", doing: "上班", schedule: [{ time: "14:00", end: "18:00", title: "开会", cost: -5 }, { time: "20:00", end: "21:00", title: "健身", cost: -5 }], conds: [] },
    items: [
      { time: "16:30", fireAt: at("2026-09-16T16:30"), act: true, why: "想问问", intent: "问下午忙不忙", wakeId: "w1", from: "t1", kind: "thread" } as any,
      { time: "10:00", fireAt: at("2026-09-16T10:00"), act: true, why: "早上", intent: "早安", wakeId: "w0", generatedAt: at("2026-09-16T10:00") } as any,
    ],
  });
  env.store.addTimer({ id: "w1", characterId: CID, date: "2026-09-16", fireAt: at("2026-09-16T17:00"), kind: "thread", status: "pending", note: "押后：在开会" });
  env.store.addDecision(CID, "defer", "押后到 17:00", "shadow", { wakeId: "w1" }, at("2026-09-16T14:59"));
}

test("新建角色只收设置键，缺 sessionId / 时区时拒绝", async () => {
  const env = setup();
  const bad = await env.call("POST", `/app/characters/x`, { name: "a", settings: { tzOffsetMin: 480 } }).catch(e => e);
  assert.equal(bad.status, 400);
  await withCharacter(env);
  const c = env.store.getCharacter(CID)!;
  assert.equal(c.settings.quietStart, "23:30");
  assert.equal("bogus" in c.settings, false);
  const again = await env.call("POST", `/app/characters/${CID}`, { enabled: false });
  assert.equal(again.body.created, false);
  assert.equal(env.store.getCharacter(CID)!.enabled, false);
});

test("state：今天的生活面、念头带押后状态和轨迹、注入聊天的文字", async () => {
  const env = setup();
  await withCharacter(env);
  const r = await env.call("GET", `/app/state?ids=${CID},nobody`);
  assert.equal(r.status, 200);
  const [c, missing] = r.body.characters;
  assert.equal(missing.exists, false);
  assert.equal(c.date, "2026-09-16");
  assert.equal(c.day.mood, "平静");
  const w1 = c.plan.items.find((i: any) => i.wakeId === "w1");
  assert.equal(w1.held, true);
  assert.equal(w1.fireAt, at("2026-09-16T17:00"));
  assert.equal(w1.origFireAt, at("2026-09-16T16:30"));
  assert.equal(w1.serverStatus.status, "pending");
  assert.equal(w1.hist[0].kind, "defer");
  assert.equal(c.plan.items.find((i: any) => i.wakeId === "w0").serverStatus.status, "sent");
  assert.match(c.chatContext, /在做的事：开会/);
  assert.match(c.chatContext, /接下来：20:00 健身/);
  const host = await env.call("GET", `/app/host?ids=${CID}`);
  assert.equal(host.body.characters[0].context, c.chatContext);
});

test("账本：记下、了结会撤掉挂在上面的念头、删掉", async () => {
  const env = setup();
  await withCharacter(env);
  const add = await env.call("POST", `/app/characters/${CID}/threads`, { op: "add", thread: { kind: "topic", text: "面试结果" } });
  assert.equal(add.body.threads.length, 1);
  const c = env.store.getCharacter(CID)!;
  c.state.threads = [...c.state.threads!, { id: "t1", kind: "topic", text: "下午开会", since: env.engine.now(), at: env.engine.now(), done: false } as any];
  env.store.saveCharacter(c);
  const done = await env.call("POST", `/app/characters/${CID}/threads`, { op: "done", id: "t1" });
  assert.equal(done.body.dropped, 1);
  assert.equal(env.store.getTimer("w1")!.status, "cancelled");
  assert.equal(env.store.getDay(CID, "2026-09-16")!.items.find(i => i.wakeId === "w1")!.act, false);
  const newId = add.body.threads[0].id;
  const drop = await env.call("POST", `/app/characters/${CID}/threads`, { op: "drop", id: newId });
  assert.equal(drop.body.threads.find((t: any) => t.id === newId), undefined);
  await assert.rejects(env.call("POST", `/app/characters/${CID}/threads`, { op: "done", id: "nope" }), (e: any) => e.status === 404);
});

test("撤掉念头；已发的撤不了", async () => {
  const env = setup();
  await withCharacter(env);
  await assert.rejects(env.call("POST", `/app/characters/${CID}/items/cancel`, { wakeId: "w0" }), (e: any) => e.status === 409);
  const r = await env.call("POST", `/app/characters/${CID}/items/cancel`, { wakeId: "w1" });
  assert.equal(r.body.cancelled, true);
  assert.equal(env.store.getTimer("w1")!.status, "cancelled");
});

test("改日程、朋友圈回执、宿主寄来的日程表和作息", async () => {
  const env = setup();
  await withCharacter(env);
  const day = await env.call("PUT", `/app/characters/${CID}/day`, { date: "2026-09-16", schedule: [{ time: "19:00", title: "吃饭", end: "18:00" }, { time: "", title: "坏的" }] });
  assert.deepEqual(env.store.getDay(CID, "2026-09-16")!.day!.schedule!.map(s => s.title), ["吃饭"]);
  assert.equal(day.body.day.schedule[0].end, "");

  const c = env.store.getCharacter(CID)!;
  c.state.outbox = [{ id: "p1", hint: "晚霞", at: env.engine.now() } as any];
  env.store.saveCharacter(c);
  const fail = await env.call("POST", `/app/characters/${CID}/moments/ack`, { id: "p1", status: "failed" });
  assert.equal(fail.body.tries, 1);
  assert.equal(env.store.getCharacter(CID)!.state.outbox!.length, 1);
  await env.call("POST", `/app/characters/${CID}/moments/ack`, { id: "p1", status: "sent", postId: "x" });
  assert.equal(env.store.getCharacter(CID)!.state.outbox!.length, 0);
  const dup = await env.call("POST", `/app/characters/${CID}/moments/ack`, { id: "p1", status: "sent" });
  assert.equal(dup.body.duplicate, true);

  const inputs = await env.call("PUT", `/app/characters/${CID}/inputs`, {
    affection: { score: 80, tier: "亲密", relation: "恋人" },
    days: [{ date: "2026-09-17", calendar: [{ id: "c1", date: "2026-09-17", startTime: "09:00", endTime: "11:00", title: "考试·忙" }, { id: "guanian_20260917_0", date: "2026-09-17", startTime: "12:00", title: "自己写回的" }],
      routine: [{ id: "r1", kind: "sleep", from: "23:00", to: "07:00" }, { id: "r2", kind: "busy", from: "09:00", to: "10:00", title: "早会" }, { id: "r3", kind: "focus", from: "14:00", to: "16:00" }], exceptions: [] }],
  });
  assert.deepEqual(inputs.body.saved, ["affection", "2026-09-17"]);
  const cal = env.store.getCalendar(CID, "2026-09-17")!;
  assert.deepEqual(cal.items.map(i => [i.startTime, i.title, i.lock]), [["09:00", "考试", "busy"], ["14:00", "专注", "busy"]]);
  assert.deepEqual(cal.routine, { wake: "07:00", bed: "23:00" });
  const same = await env.call("PUT", `/app/characters/${CID}/inputs`, { affection: { score: 80, tier: "亲密", relation: "恋人" } });
  assert.deepEqual(same.body.saved, []);
});

test("影子模式不让重新生成", async () => {
  const env = setup();
  await withCharacter(env);
  await assert.rejects(env.call("POST", `/app/characters/${CID}/regenerate`), (e: any) => e.status === 409);
});

test("锁：一轮在跑时改动排队，跑完才落地", async () => {
  const env = setup();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const order: string[] = [];
  const first = env.runner.exclusive(async () => { await gate; order.push("tick"); });
  const second = env.runner.exclusive(() => { order.push("op"); return 7; });
  assert.equal(env.runner.running, true);
  assert.deepEqual(await env.runner.tick(), []); // 占着锁时不叠一轮
  release();
  await first;
  assert.equal(await second, 7);
  assert.deepEqual(order, ["tick", "op"]);
  assert.equal(env.runner.running, false);
  await assert.rejects(env.runner.exclusive(() => { throw new Error("坏"); }), /坏/);
  assert.equal(env.runner.running, false);
});

test("routine：跨夜作息的例外、推迟睡觉", () => {
  const now = at("2026-09-16T12:00");
  const r = fixedForDay([], [{ kind: "sleep", from: "23:30", to: "07:30" }, { kind: "busy", from: "09:00", to: "12:00", title: "上课", days: [3] }], [
    { op: "shift", kind: "sleep", from: at("2026-09-16T23:59"), maskFrom: at("2026-09-16T23:30"), until: at("2026-09-17T08:00") },
    { op: "skip", kind: "busy", title: "上课", from: at("2026-09-16T09:00"), until: at("2026-09-16T23:00") },
  ], "2026-09-16", 480, now);
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.routine, { wake: "07:30", bed: "23:59" });
});

test("context：今天没排时按昨天作息过夜", () => {
  const prev = { tz: 480, wake: "07:00", bed: "23:00", schedule: [] } as any;
  const text = chatContextText({ day: null, prev, settings: {}, threads: [], nowMs: at("2026-09-17T02:00"), tz: 480 });
  assert.match(text, /^在睡觉（07:00 左右才醒）/);
  assert.match(text, /今天的日程还没排/);
  assert.equal(chatContextText({ day: null, prev: null, settings: {}, threads: [], nowMs: 0, tz: 480 }), "");
});

test("auth：运维令牌、个人云密钥校验只做一次、限速", async () => {
  let checks = 0;
  let t = 0;
  const auth = new Auth("admin-token", async key => { checks++; return key === "sb_secret_good"; }, () => t);
  assert.equal(await auth.allow("Bearer admin-token"), true);
  assert.equal(await auth.allow(undefined), false);
  assert.equal(await auth.allow("Bearer sb_secret_good"), true);
  assert.equal(await auth.allow("Bearer sb_secret_good"), true);
  assert.equal(checks, 1);
  for (let i = 0; i < 30; i++) await auth.allow("Bearer bad" + i);
  assert.equal(checks, 20);
  t += 61_000;
  assert.equal(await auth.allow("Bearer bad99"), false);
  assert.equal(checks, 21);

  const seen: { url: string; headers: Record<string, string> }[] = [];
  const check = supabaseKeyCheck("https://x.supabase.co", (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string> });
    const good = (init.headers as Record<string, string>).apikey === "eyJgood";
    return new Response(good ? '[{"id":1}]' : '[]', { status: 200 });
  }) as typeof fetch);
  assert.equal(await check("eyJgood"), true);
  assert.equal(seen[0].headers.Authorization, "Bearer eyJgood");
  assert.match(seen[0].url, /push_server_config/);
  assert.equal(await check("sb_publishable_x"), false);
});

test("HTTP：CORS 预检、401、带密钥可读 state", async () => {
  const env = setup();
  await withCharacter(env);
  const auth = new Auth("admin", async () => false);
  const server = createApp({ rest: env.engine.rest, store: env.store, userId: "u1", auth, startedAt: new Date(), runner: env.runner, engine: env.engine });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of ["/%ZZ", "/%FF", "/app/characters/%"]) {
      assert.equal((await fetch(base + path)).status, 400);
    }
    const pre = await fetch(`${base}/app/state`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    assert.equal((await fetch(`${base}/app/state?ids=${CID}`)).status, 401);
    const ok = await fetch(`${base}/app/state/?ids=${CID}`, { headers: { Authorization: "Bearer admin" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), "*");
    const body = await ok.json() as any;
    assert.equal(body.characters[0].name, "赵兖");
    const bad = await fetch(`${base}/app/characters/${CID}/threads`, { method: "POST", headers: { Authorization: "Bearer admin" }, body: JSON.stringify({ op: "zzz", id: "x" }) });
    assert.equal(bad.status, 404);
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  } finally {
    server.close();
  }
});

test("交接失败保持 VPS 停用，确认旧云端后也须由 App 明确启用", async () => {
  const env=setup(); await withCharacter(env);
  env.engine.rest=async()=>new Response("unavailable",{status:503});
  await assert.rejects(env.call("POST",`/app/characters/${CID}/handoff`,{owner:"device"}));
  assert.equal(env.store.getCharacter(CID)!.enabled,false);
  assert.equal(env.store.getMeta("handoff:"+CID),"pending");
  env.engine.rest=async path=>Response.json(path.startsWith("rpc/")?0:[]);
  const r=await env.call("POST",`/app/characters/${CID}/handoff`,{owner:"device"});
  assert.equal(r.body.stopped,true);assert.equal(env.store.getCharacter(CID)!.enabled,false);
  const st=await env.call("GET",`/app/state?ids=${CID}`);assert.equal(st.body.characters[0].legacyStopped,true);
  await env.call("POST",`/app/characters/${CID}`,{enabled:true,settings:{chatEditsDay:false}});
  assert.equal(env.store.getCharacter(CID)!.enabled,true);assert.equal(env.store.getCharacter(CID)!.settings.chatEditsDay,false);
  env.store.close();
});

test("Runner：撤销排队时立刻挂标记，落地后撤掉", async () => {
  const env = setup();
  await withCharacter(env);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const busy = env.runner.exclusive(async () => { await gate; });
  const cancel = env.call("POST", `/app/characters/${CID}/items/cancel`, { wakeId: "w1" });
  await new Promise(r => setImmediate(r)); // 读完请求体就挂上，不等锁
  assert.equal(env.engine.halted!(CID, "w1"), true);
  assert.equal(env.engine.halted!(CID, "w2"), false);
  const stop = env.call("PUT", `/app/characters/${CID}/settings`, { enabled: false });
  await new Promise(r => setImmediate(r));
  assert.equal(env.engine.halted!(CID, ""), true);
  release();
  await busy; await cancel; await stop;
  await new Promise(r => setImmediate(r));
  assert.equal(env.engine.halted!(CID, "w1"), false);
  assert.equal(env.store.getTimer("w1")!.status, "cancelled");
});

test("新角色建空账本；固定作息原件存下，第三天后端自己展开；重启恢复生成中的任务", async () => {
  const env = setup();
  await withCharacter(env);
  assert.deepEqual(env.store.getCharacter(CID)!.state.threads, []);
  await env.call("PUT", `/app/characters/${CID}/inputs`, {
    days: [{ date: "2026-09-16", calendar: [], routine: [{ id: "r1", kind: "sleep", from: "23:00", to: "08:00" }], exceptions: [] }],
  });
  assert.equal(env.store.getCalendar(CID, "2026-09-19"), null);
  const { generateDayNow } = await import("../src/engine.ts");
  const snap = { characterId: CID, purpose: "daily" as const, sessionId: "sess1", capturedAt: 0, notify: {}, merge: {},
    request: { url: "https://m.example/v1/messages", headers: {}, providerKind: "anthropic" as const, body: { model: "m", messages: [{ role: "user", content: "x" }] } } };
  env.store.saveSnapshot(snap);
  let prompt = "";
  env.engine.fetchModel = async (_u, init) => { prompt = String(init.body); return Response.json({ content: [{ type: "text", text: "不是 JSON" }] }); };
  await generateDayNow(env.engine, CID, "2026-09-19");
  assert.match(prompt, /08:00 起床，23:00 上床/);

  env.store.addTimer({ id: "wr", characterId: CID, date: "2026-09-16", fireAt: 0, kind: "quiet", status: "running", note: "生成中" });
  assert.equal(env.store.recoverRunningTimers(), 1);
  assert.equal(env.store.getTimer("wr")!.status, "pending");
});
