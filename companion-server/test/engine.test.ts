import assert from "node:assert/strict";
import test from "node:test";

import { tickCharacter, type EngineDeps, type Mode } from "../src/engine.ts";
import type { PushMessage } from "../src/push.ts";
import { Store } from "../src/store.ts";

const CID = "char_test";
const at = (local: string) => Date.parse(local + ":00+08:00");

type Call = { path: string; method: string; body?: unknown };

function setup(mode: Mode, startLocal: string, template = false) {
  const store = new Store(":memory:");
  let now = at(startLocal);
  const calls: Call[] = [];
  const modelCalls: string[] = [];
  const pushes: PushMessage[][] = [];
  const messages = [
    { id: "m1", role: "user", content: "我去上班了", message_at: new Date(at("2026-09-16T12:00")).toISOString() },
    { id: "m2", role: "assistant", content: "路上小心", message_at: new Date(at("2026-09-16T12:01")).toISOString() },
  ];
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  const rest = async (path: string, init: RequestInit = {}) => {
    const method = init.method || "GET";
    calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "POST") return new Response(null, { status: 201 });
    if (path.startsWith("push_chat_mirror?") && path.includes("media_type.is.null,and(")) return json(messages);
    return json([]);
  };
  const fetchModel = async (_url: string, init: RequestInit) => {
    const text = String(init.body);
    modelCalls.push(text);
    const reply = text.includes("后台判断任务")
      ? modelCalls.length === 1
        ? '{"decisions":[],"extra":[{"time":"16:00","matterId":"new:1","about":"想你","intent":"问问下午忙不忙","why":"好久没说话"}],"keep":[],"settle":[]}'
        : '{"decisions":[],"extra":[],"keep":[],"settle":[]}'
      : "下午忙不忙呀\n\n我刚开完会";
    return json({ content: [{ type: "text", text: reply }], usage: { input_tokens: 10, output_tokens: 5 } });
  };
  store.saveCharacter({
    characterId: CID, sessionId: "sess1", name: "赵兖", enabled: true, importedAt: 0, updatedAt: 0,
    settings: { tzOffsetMin: 480, quota: 3, selfImpulseCap: 5, selfSilenceMin: 60, recheckEnabled: 1, genEnabled: 1 },
    state: {},
  });
  store.saveDay({
    characterId: CID, date: "2026-09-16", items: [], selfUsed: 0, recheckCount: 0, judgedAt: 0, judgedChatAt: at("2026-09-16T12:01"),
    genTries: 0, genError: "", genLog: [], source: "server", updatedAt: 0,
    day: { tz: 480, mood: "平静", energy: 70, wake: "08:00", bed: "23:30", schedule: [{ time: "20:00", end: "21:00", title: "健身", cost: -5 }], conds: [] },
  });
  const snapshot = {
    characterId: CID, sessionId: "sess1", capturedAt: now, notify: { title: "赵兖", url: "/chat" }, merge: { characterName: "赵兖", appId: "chat" },
    request: { url: "https://model.example/v1/messages", headers: { "x-api-key": "k" }, providerKind: "anthropic" as const, body: { model: "m", messages: [{ role: "user", content: "当前系统时间：2026年9月14日08:21，星期一\n你当时想着：“挂念后台复核模板，仅供后台调用，不生成聊天消息”" }] } },
  };
  if (template) {
    Object.assign(snapshot.merge, { intentPlaceholder: "__GUANIAN_INTENT__", elapsedMark: 424242, template: true });
    snapshot.request.body.messages[0].content = "（约 424242 分钟前你这么决定的）你当时想着：“__GUANIAN_INTENT__”";
  }
  store.saveSnapshot({ ...snapshot, purpose: "chat" });
  const deps: EngineDeps = {
    store, rest, userId: "u1", fetchModel,
    push: async list => { pushes.push(list); return { total: 1, sent: list.length, removed: 0, skippedShell: 0, errors: [] }; },
    now: () => now, random: () => 0.99, log: () => undefined,
  };
  return { store, deps, calls, modelCalls, pushes, tick: () => tickCharacter(deps, mode, CID), setNow: (local: string) => { now = at(local); } };
}

test("影子模式：安静够久会记下「会去判」，但不调模型、不写个人云", async () => {
  const env = setup("shadow", "2026-09-16T15:00");
  const trace = await env.tick();
  assert.equal(trace.error, undefined);
  assert.equal(env.modelCalls.length, 0);
  assert.equal(env.calls.filter(c => c.method !== "GET").length, 0);
  const judged = env.store.listDecisions(CID, 10).find(d => d.kind === "judge");
  assert.match(judged!.note, /影子：这会儿会去判——自发起念（.*3 小时没联系）/);
  const row = env.store.getDay(CID, "2026-09-16")!;
  assert.equal(row.recheckCount, 1);
  assert.equal(row.selfUsed, 1);
  // 离上次判断不够久：下一分钟只记门禁
  env.setNow("2026-09-16T15:01");
  await env.tick();
  assert.equal(env.store.lastDecision(CID, "gate")?.note, "离上次判断还不够久");
  env.store.close();
});

test("真发模式：判断起念 → 挂定时器 → 到点写 outbox、推送、记发送", async () => {
  const env = setup("live", "2026-09-16T15:00");
  const first = await env.tick();
  assert.equal(first.error, undefined, first.steps.join("\n"));
  assert.equal(env.modelCalls.length, 1);
  const row = env.store.getDay(CID, "2026-09-16")!;
  assert.equal(row.items.length, 1);
  const item = row.items[0];
  assert.equal(item.time, "16:00");
  assert.equal(item.kind, "quiet");
  const timer = env.store.getTimer(item.wakeId)!;
  assert.equal(timer.status, "pending");
  assert.equal(timer.fireAt, at("2026-09-16T16:00"));

  env.setNow("2026-09-16T16:01");
  const second = await env.tick();
  assert.equal(second.error, undefined, second.steps.join("\n"));
  const outbox = env.calls.filter(c => c.method === "POST" && c.path === "push_outbox");
  assert.equal(outbox.length, 1);
  const [written] = outbox[0].body as { trigger_key: string; raw_text: string; session_id: string; meta: Record<string, unknown> }[];
  assert.equal(written.trigger_key, "timedwake:" + item.wakeId);
  assert.equal(written.raw_text, "下午忙不忙呀\n\n我刚开完会");
  assert.equal(written.session_id, "sess1");
  assert.equal(written.meta.pushGenerated, true);
  assert.equal(written.meta.companionServer, true);
  assert.equal(written.meta.characterName, "赵兖");
  const chatRequest = env.modelCalls.find(b => !b.includes("后台判断任务"))!;
  assert.match(chatRequest, /问问下午忙不忙/);
  assert.match(chatRequest, /最新云端聊天事实/);
  assert.match(chatRequest, /当前系统时间：2026年9月16日16:01，星期三\\n你当时想着：“问问下午忙不忙”/);
  assert.deepEqual(env.pushes[0].map(m => m.body), ["下午忙不忙呀", "我刚开完会"]);
  assert.equal(env.store.getTimer(item.wakeId)!.status, "done");
  assert.equal(env.store.pendingFeedback(CID).length, 1);
  assert.ok(env.store.getDay(CID, "2026-09-16")!.items[0].generatedAt);
  env.store.close();
});

test("新式聊天模板：意图填进模板，不再追加意图备忘，冻结后没新聊天就不补", async () => {
  const env = setup("live", "2026-09-16T15:00", true);
  await env.tick();
  env.setNow("2026-09-16T16:01");
  await env.tick();
  const chatRequest = env.modelCalls.find(b => !b.includes("后台判断任务"))!;
  assert.match(chatRequest, /约 61 分钟前你这么决定的）你当时想着：“问问下午忙不忙”/);
  assert.doesNotMatch(chatRequest, /想主动跟对方说的是/);
  // 快照在 15:00 冻结，之后没有新聊天：不补聊天事实
  assert.doesNotMatch(chatRequest, /模板冻结之后的新聊天|最新云端聊天事实/);
  const outbox = env.calls.find(c => c.method === "POST" && c.path === "push_outbox")!;
  const [written] = outbox.body as { meta: Record<string, unknown> }[];
  assert.equal(written.meta.intentPlaceholder, undefined);
  assert.equal(written.meta.template, undefined);
  env.store.close();
});


test("outbox 503 恢复 pending，五分钟后重试成功", async () => {
  const env = setup("live", "2026-09-16T15:00");
  try {
    await env.tick();
    const item = env.store.getDay(CID, "2026-09-16")!.items[0];
    const original = env.deps.rest;
    let writes = 0;
    env.deps.rest = async (path, init) => {
      if (path === "push_outbox" && ++writes === 1) return new Response("unavailable", { status: 503 });
      return original(path, init);
    };
    env.setNow("2026-09-16T16:01"); await env.tick();
    assert.equal(env.store.getTimer(item.wakeId)!.status, "pending");
    assert.match(env.store.getTimer(item.wakeId)!.note, /tries:1/);
    env.setNow("2026-09-16T16:07"); await env.tick();
    assert.equal(writes, 2);
    assert.equal(env.store.getTimer(item.wakeId)!.status, "done");
  } finally { env.store.close(); }
});

test("POST 已落库但响应丢失：精确读回凭据，不再次生成或投递", async () => {
  const env = setup("live", "2026-09-16T15:00");
  try {
    await env.tick();
    const item = env.store.getDay(CID, "2026-09-16")!.items[0];
    const original = env.deps.rest;
    let written: any = null, writes = 0;
    env.deps.rest = async (path, init) => {
      if (path === "push_outbox") {
        writes++; written = JSON.parse(String(init!.body))[0];
        throw new Error("response lost");
      }
      if (path.startsWith("push_outbox?") && path.includes("trigger_key=eq.")) {
        assert.ok(path.includes("user_id=eq.u1&session_id=eq.sess1"));
        return Response.json(written ? [written] : []);
      }
      return original(path, init);
    };
    env.setNow("2026-09-16T16:01"); await env.tick();
    const generated = env.modelCalls.filter(x => !x.includes("后台判断任务")).length;
    env.setNow("2026-09-16T16:07"); await env.tick();
    assert.equal(writes, 1);
    assert.equal(env.modelCalls.filter(x => !x.includes("后台判断任务")).length, generated);
    assert.equal(env.store.getTimer(item.wakeId)!.status, "done");
    assert.equal(env.store.getDay(CID, "2026-09-16")!.items[0].generatedAt, Date.parse(written.created_at));
    assert.equal(env.store.pendingFeedback(CID)[0].outboxId, written.id);
  } finally { env.store.close(); }
});

test("发送凭据读失败时不调用发送模型或写 outbox", async () => {
  const env = setup("live", "2026-09-16T15:00");
  try {
    await env.tick();
    const original = env.deps.rest;
    env.deps.rest = async (path, init) => path.includes("trigger_key=eq.") ? new Response("unavailable", {status:503}) : original(path, init);
    env.setNow("2026-09-16T16:01"); await env.tick();
    assert.equal(env.modelCalls.filter(x => !x.includes("后台判断任务")).length, 0);
    assert.equal(env.calls.filter(x => x.path === "push_outbox" && x.method === "POST").length, 0);
  } finally { env.store.close(); }
});

test("同轮积压的普通消息遵守 60 分钟间隔", async () => {
  const env = setup("live", "2026-09-16T15:00");
  try {
    await env.tick();
    const c = env.store.getCharacter(CID)!;
    c.settings.minGapMin = 60; env.store.saveCharacter(c);
    const row = env.store.getDay(CID, "2026-09-16")!;
    const first = row.items[0];
    row.items.push({ ...first, wakeId: "second", matterId: "different-matter", intent: "分享花园的新花", fireAt: first.fireAt + 60000 });
    env.store.saveDay(row);
    env.store.addTimer({ id: "second", characterId: CID, date: row.date, fireAt: first.fireAt + 60000, kind: "quiet", status: "pending", note: "" });
    env.setNow("2026-09-16T16:02"); await env.tick();
    assert.equal(env.calls.filter(x => x.path === "push_outbox" && x.method === "POST").length, 1);
    assert.equal(env.store.getTimer("second")!.status, "pending");
    assert.equal(env.store.getTimer("second")!.fireAt, at("2026-09-16T17:02"));
  } finally { env.store.close(); }
});

test("聊天复核的 feel/sched 写回生活面，host 上下文立即可读；开关只拦日程", async () => {
  const { appHost } = await import("../src/api.ts");
  const { Runner } = await import("../src/runner.ts");
  for (const edits of [true, false]) {
    const e = setup("live", "2026-09-16T15:00");
    try {
      const c = e.store.getCharacter(CID)!; c.settings.chatEditsDay = edits; c.state.threads = []; e.store.saveCharacter(c);
      const d = e.store.getDay(CID,"2026-09-16")!; d.judgedChatAt = at("2026-09-16T11:00"); e.store.saveDay(d);
      let prompt = "";
      e.deps.fetchModel = async (_u, init) => { prompt = String(init.body); return Response.json({content:[{type:"text",text:JSON.stringify({decisions:[],extra:[],keep:[],settle:[],feel:{mood:"难过",cause:"吵架",energy:-10,intensity:80,hours:3},sched:[{op:"drop",time:"20:00",why:"聊天里取消"}]})}]}); };
      const tr = await e.tick(); assert.equal(tr.error,undefined);
      const day = e.store.getDay(CID,"2026-09-16")!.day!;
      assert.equal(day.conds![0].mood,"难过"); assert.equal(day.conds![0].energyDelta,-10);
      assert.equal(day.schedule!.length,edits ? 0 : 1);
      assert.ok(prompt.includes('feel')); assert.ok(prompt.includes(edits ? '未来日程' : '关闭了聊天改日程'));
      const h=appHost({store:e.store,engine:e.deps,runner:new Runner(e.deps,"live")},[CID]).characters[0];
      assert.match(h.context!,/难过/);
    } finally {e.store.close();}
  }
});

test("自发起念没有新聊天，不接受模型编造的情绪与日程变化", async () => {
  const e=setup("live","2026-09-16T15:00");
  try {
    const before=e.store.getDay(CID,"2026-09-16")!.day;
    e.deps.fetchModel=async()=>Response.json({content:[{type:"text",text:JSON.stringify({decisions:[],extra:[],keep:[],settle:[],feel:{mood:"无依据"},sched:[{op:"drop",time:"20:00"}]})}]});
    await e.tick();assert.deepEqual(e.store.getDay(CID,"2026-09-16")!.day,before);
  } finally {e.store.close();}
});

test("生成失败按生成时刻退避十分钟，不被每分钟保存推后；生成请求带最新聊天", async () => {
  const env = setup("live", "2026-09-17T08:00");
  try {
    const genRequests: string[] = [];
    env.deps.fetchModel = async (_u, init) => {
      const body = String(init.body);
      if (!body.includes("后台判断任务")) genRequests.push(body);
      return Response.json({ content: [{ type: "text", text: body.includes("后台判断任务") ? '{"decisions":[],"extra":[],"keep":[],"settle":[]}' : "不是 JSON" }] });
    };
    for (let m = 0; m <= 9; m++) { env.setNow(`2026-09-17T08:0${m}`); await env.tick(); }
    assert.equal(env.store.getDay(CID, "2026-09-17")!.genTries, 1);
    assert.match(genRequests[0], /最新云端聊天事实/);
    assert.match(genRequests[0], /我去上班了/);
    env.setNow("2026-09-17T08:11"); await env.tick();
    assert.equal(env.store.getDay(CID, "2026-09-17")!.genTries, 2);
  } finally { env.store.close(); }
});

test("零点后今天还没生成：按昨天作息判睡着，押到起床，不在凌晨发", async () => {
  const env = setup("live", "2026-09-17T02:02");
  try {
    const c = env.store.getCharacter(CID)!; c.settings.sleepMode = 1; c.settings.autoGenAt = "07:30"; env.store.saveCharacter(c);
    env.store.saveDay({
      characterId: CID, date: "2026-09-17", day: null, selfUsed: 0, recheckCount: 0, judgedAt: at("2026-09-17T02:01"), judgedChatAt: at("2026-09-16T12:01"),
      genTries: 0, genError: "", genLog: [], source: "", updatedAt: 0,
      items: [{ time: "02:00", fireAt: at("2026-09-17T02:00"), act: true, kind: "quiet", intent: "问睡了没", why: "想你", wakeId: "w_night" } as any],
    });
    env.store.addTimer({ id: "w_night", characterId: CID, date: "2026-09-17", fireAt: at("2026-09-17T02:00"), kind: "quiet", status: "pending", note: "" });
    await env.tick();
    assert.equal(env.calls.filter(x => x.method === "POST" && x.path === "push_outbox").length, 0);
    const timer = env.store.getTimer("w_night")!;
    assert.equal(timer.status, "pending");
    assert.ok(timer.fireAt >= at("2026-09-17T08:00"), new Date(timer.fireAt).toISOString());
  } finally { env.store.close(); }
});

test("账本开关：threadsOn 开着的新角色从空账本记起；关着的旧角色提示词不要 keep", async () => {
  for (const on of [1, 0]) {
    const env = setup("live", "2026-09-16T15:00");
    try {
      const c = env.store.getCharacter(CID)!;
      c.settings.threadsOn = on; c.state = on ? {} : { threads: [] };
      env.store.saveCharacter(c);
      const d = env.store.getDay(CID, "2026-09-16")!; d.judgedChatAt = at("2026-09-16T11:00"); env.store.saveDay(d);
      let prompt = "";
      env.deps.fetchModel = async (_u, init) => {
        prompt = String(init.body);
        return Response.json({ content: [{ type: "text", text: JSON.stringify({ decisions: [], extra: [], settle: [], keep: [{ matterId: "new:1", subject: "user", sourceMessageId: "m1", kind: "topic", text: "用户去上班", why: "关心" }] }) }] });
      };
      await env.tick();
      assert.equal(prompt.includes('\\"keep\\"'), on === 1);
      const threads = env.store.getCharacter(CID)!.state.threads!;
      assert.ok(Array.isArray(threads));
      assert.equal(threads.length, on);
    } finally { env.store.close(); }
  }
});

test("撤销在排队：发送前看到就不发；成文期间看到就放回待发不写 outbox", async () => {
  const env = setup("live", "2026-09-16T15:00");
  try {
    await env.tick();
    const item = env.store.getDay(CID, "2026-09-16")!.items[0];
    env.deps.halted = (_c, w) => w === item.wakeId;
    env.setNow("2026-09-16T16:01"); await env.tick();
    assert.equal(env.modelCalls.filter(b => !b.includes("后台判断任务")).length, 0);
    assert.equal(env.store.getTimer(item.wakeId)!.status, "pending");

    let halt = false;
    env.deps.halted = (_c, w) => halt && w === item.wakeId;
    const original = env.deps.fetchModel;
    env.deps.fetchModel = async (u, init) => { if (!String(init.body).includes("后台判断任务")) halt = true; return original(u, init); };
    env.setNow("2026-09-16T16:02"); await env.tick();
    assert.equal(env.calls.filter(x => x.method === "POST" && x.path === "push_outbox").length, 0);
    assert.equal(env.store.getTimer(item.wakeId)!.status, "pending");
    assert.equal(env.store.claimTimer(item.wakeId), true);
    env.store.updateTimer(item.wakeId, { status: "cancelled" });
    assert.equal(env.store.claimTimer(item.wakeId), false);
  } finally { env.store.close(); }
});
