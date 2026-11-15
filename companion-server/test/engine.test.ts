import assert from "node:assert/strict";
import test from "node:test";

import { tickCharacter, type EngineDeps, type Mode } from "../src/engine.ts";
import type { PushMessage } from "../src/push.ts";
import { Runner } from "../src/runner.ts";
import { Store } from "../src/store.ts";

const CID = "char_test";
const at = (local: string) => Date.parse(local + ":00+08:00");

type Call = { path: string; method: string; body?: unknown };

function setup(mode: Mode, startLocal: string, template = false, storePath = ":memory:") {
  const store = new Store(storePath);
  let now = at(startLocal);
  const calls: Call[] = [];
  const modelCalls: string[] = [];
  const pushes: PushMessage[][] = [];
  const delivered: any[] = [];
  const messages = [
    { id: "m1", role: "user", content: "我去上班了", message_at: new Date(at("2026-09-16T12:00")).toISOString() },
    { id: "m2", role: "assistant", content: "路上小心", message_at: new Date(at("2026-09-16T12:01")).toISOString() },
  ];
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  const rest = async (path: string, init: RequestInit = {}) => {
    const method = init.method || "GET";
    calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "rpc/push_generation_lease") return json(true);
    if (method === "POST") {
      if (path === "push_outbox") delivered.push(...JSON.parse(String(init.body)));
      return new Response(null, { status: 201 });
    }
    if (path.startsWith("push_outbox?")) {
      const trigger = new URLSearchParams(path.split("?")[1]).get("trigger_key");
      return json(trigger ? delivered.filter(o => "eq." + o.trigger_key === trigger) : delivered);
    }
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
    assert.equal(env.modelCalls.filter(x => !x.includes("后台判断任务")).length, 1, "投递重试不重新生成");
    assert.equal(env.store.getDraft(item.wakeId), null);
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
    assert.equal(env.pushes.length, 1, "正文其实已经落库、通知还没推过：恢复时补推一次");
    assert.equal(env.pushes[0][0].type, "chat_outbox");
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

test("生成日程使用独立回看窗口，包含线下取消摘要并限制线上轮数", async () => {
  const { generateDayNow } = await import("../src/engine.ts");
  const e=setup("live","2026-09-16T15:00");
  try {
    const c=e.store.getCharacter(CID)!;c.settings.onlineRounds=1;c.settings.offlineRounds=1;e.store.saveCharacter(c);
    const original=e.deps.rest;let summaryReads=0;
    e.deps.rest=async(path,init)=>{
      if(path.includes("media_type=eq.offline_summary")) {summaryReads++;return Response.json([{id:"offline-cancel",role:"user",content:"线下明确取消今晚健身",media_type:"offline_summary",message_at:new Date(at("2026-09-16T14:00")).toISOString()}]);}
      if(path.includes("media_type.is.null,and(")) return Response.json([
        {id:"old",role:"user",content:"旧线上轮不应出现",message_at:new Date(at("2026-09-16T12:00")).toISOString()},
        {id:"new",role:"user",content:"最新线上轮",message_at:new Date(at("2026-09-16T13:00")).toISOString()}]);
      return original(path,init);
    };
    let prompt="";e.deps.fetchModel=async(_url,init)=>{prompt=String(init.body);return Response.json({content:[{type:"text",text:JSON.stringify({schedule:[{time:"16:00",title:"工作"}]})}]});};
    await generateDayNow(e.deps,CID,"2026-09-16");
    assert.equal(summaryReads,1);assert.match(prompt,/线下明确取消今晚健身/);assert.match(prompt,/线下摘要/);assert.match(prompt,/最新线上轮/);assert.doesNotMatch(prompt,/旧线上轮不应出现/);
  }finally{e.store.close();}
});

test("正文已落盘：进程重启后沿用正文、生成时间、消息 ID，只重试投递", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "companion-draft-"));
  const path = join(dir, "state.db");
  const e = setup("live", "2026-09-16T15:00", false, path);
  try {
    await e.tick();
    const wakeId = e.store.getDay(CID, "2026-09-16")!.items[0].wakeId;
    const rest = e.deps.rest;
    let down = true;
    e.deps.rest = async (p, init) => p === "push_outbox" && down ? new Response("down", { status: 503 }) : rest(p, init);
    e.setNow("2026-09-16T16:01"); await e.tick();
    const draft = e.store.getDraft(wakeId)!;
    assert.ok(draft);
    // 模拟生成进程未能执行外层恢复逻辑便退出。
    e.store.updateTimer(wakeId, { status: "running" });
    e.store.close();
    e.deps.store = new Store(path);
    assert.equal(e.deps.store.recoverRunningTimers(), 1);
    const c = e.deps.store.getCharacter(CID)!;
    c.settings.busyMaxHoldMin = 1; // 正文已成形，不再按等待淡去重新生成/作罢。
    e.deps.store.saveCharacter(c);
    down = false;
    e.setNow("2026-09-16T16:20"); await e.tick();
    const written = e.calls.find(c => c.path === "push_outbox" && c.method === "POST")!.body as any[];
    assert.deepEqual([written[0].id, written[0].raw_text, written[0].created_at], [draft.outboxId, draft.rawText, draft.createdAt]);
    assert.equal(e.modelCalls.filter(x => !x.includes("后台判断任务")).length, 1);
    assert.equal(e.deps.store.pendingFeedback(CID).length, 1);
    assert.equal(e.deps.store.pendingFeedback(CID)[0].sentAt, at("2026-09-16T16:20"));
    const { lastProactiveAt } = await import("../src/history.ts");
    assert.equal(lastProactiveAt({ messages: [], outputs: written, lastGeneratedAt: 0 }), at("2026-09-16T16:20"));
    assert.equal(e.deps.store.getTimer(wakeId)!.status, "done");
    assert.equal(e.deps.store.getDraft(wakeId), null);
  } finally { e.deps.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("已经暂存的正文仍尊重取消/停用，不会重试发出去", async () => {
  for (const cancel of [true, false]) {
    const e = setup("live", "2026-09-16T15:00");
    try {
      await e.tick();
      const rest = e.deps.rest;
      e.deps.rest = async (p, init) => p === "push_outbox" ? new Response("down", { status: 503 }) : rest(p, init);
      e.setNow("2026-09-16T16:01"); await e.tick();
      const row = e.store.getDay(CID, "2026-09-16")!;
      assert.ok(e.store.getDraft(row.items[0].wakeId));
      if (cancel) { row.items[0].act = false; e.store.saveDay(row); }
      else { const c = e.store.getCharacter(CID)!; c.enabled = false; e.store.saveCharacter(c); }
      e.deps.rest = rest;
      e.setNow("2026-09-16T16:07"); await e.tick();
      assert.equal(e.pushes.length, 0);
      assert.equal(e.modelCalls.filter(x => !x.includes("后台判断任务")).length, 1);
      assert.equal(e.calls.filter(x => x.path === "push_outbox").length, 0);
    } finally { e.store.close(); }
  }
});

test("旧云端占用会话时延期不计失败；取得租约后模型使用刚更新的聊天", async () => {
  const e = setup("live", "2026-09-16T15:00");
  try {
    await e.tick();
    const id = e.store.getDay(CID, "2026-09-16")!.items[0].wakeId;
    const rest = e.deps.rest;
    let busy = true, claimed = false;
    e.deps.rest = async (p, init) => {
      if (p === "rpc/push_generation_lease") {
        const action = JSON.parse(String(init?.body)).p_action;
        if (action === "claim") { claimed = !busy; return Response.json(!busy); }
        return Response.json(true);
      }
      if (claimed && p.startsWith("push_chat_mirror?")) return Response.json([{ id: "fresh", role: "user", content: "刚刚改成明天去公园", message_at: new Date(at("2026-09-16T16:01")).toISOString() }]);
      return rest(p, init);
    };
    e.setNow("2026-09-16T16:01"); await e.tick();
    assert.equal(e.store.getTimer(id)!.fireAt, at("2026-09-16T16:02"));
    assert.doesNotMatch(e.store.getTimer(id)!.note, /tries:/);
    assert.equal(e.modelCalls.filter(x => !x.includes("后台判断任务")).length, 0);
    busy = false;
    // 取得租约后读到你 16:01 刚说的话：你正说着，先不插话，押到 16:16
    e.setNow("2026-09-16T16:03"); await e.tick();
    assert.equal(e.modelCalls.filter(x => !x.includes("后台判断任务")).length, 0);
    assert.equal(e.store.getTimer(id)!.fireAt, at("2026-09-16T16:16"));
    assert.equal(e.store.getTimer(id)!.status, "pending");
    e.setNow("2026-09-16T16:17"); await e.tick();
    assert.match(e.modelCalls.find(x => !x.includes("后台判断任务"))!, /刚刚改成明天去公园/);
  } finally { e.store.close(); }
});

test("成文后失去租约：保存正文但不投递，重新取得租约后不重复生成", async () => {
  const e = setup("live", "2026-09-16T15:00");
  try {
    await e.tick();
    const id = e.store.getDay(CID, "2026-09-16")!.items[0].wakeId;
    const rest = e.deps.rest;
    let renews = 0, fail = true;
    e.deps.rest = async (p, init) => {
      if (p === "rpc/push_generation_lease") {
        const action = JSON.parse(String(init?.body)).p_action;
        return Response.json(!(action === "renew" && ++renews >= 2 && fail));
      }
      return rest(p, init);
    };
    e.setNow("2026-09-16T16:01"); await e.tick();
    assert.ok(e.store.getDraft(id));
    assert.equal(e.pushes.length, 0);
    assert.equal(e.store.getTimer(id)!.status, "pending");
    fail = false;
    e.setNow("2026-09-16T16:07"); await e.tick();
    assert.equal(e.modelCalls.filter(x => !x.includes("后台判断任务")).length, 1);
    assert.equal(e.pushes.length, 1);
  } finally { e.store.close(); }
});

test("挂念与事件唤醒真实入口共用租约：前者生成时后者保留事件，完成后读到前者回复", async () => {
  const { WakeService } = await import("../src/wake.ts");
  const e = setup("live", "2026-09-16T15:00");
  let unblock!: () => void;
  const blocked = new Promise<void>(r => { unblock = r; });
  let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  try {
    await e.tick();
    const rest = e.deps.rest, model = e.deps.fetchModel;
    let held = "", shouldBlock = true, ack = 0;
    e.deps.rest = async (p, init) => {
      if (p === "rpc/push_generation_lease") {
        const { p_token: token, p_action: action } = JSON.parse(String(init?.body));
        if (action === "claim") { if (held) return Response.json(false); held = token; return Response.json(true); }
        if (action === "renew") return Response.json(held === token);
        if (held === token) held = "";
        return Response.json(true);
      }
      return rest(p, init);
    };
    e.deps.fetchModel = async (url, init) => {
      if (shouldBlock && !String(init.body).includes("后台判断任务")) { shouldBlock = false; entered(); await blocked; }
      return model(url, init);
    };
    const snap = e.store.getSnapshot(CID, "chat")!;
    e.store.saveWakeTemplate({ sourceId: "source", characterId: CID, sessionId: "sess1", capturedAt: snap.capturedAt,
      request: { ...snap.request, body: { model: "m", messages: [{ role: "user", content: "__EVENT__" }] } }, placeholder: "__EVENT__", protocol: "none",
      toolNames: {}, schemaText: {}, mcp: null, maxRounds: 1, notify: snap.notify, merge: snap.merge });
    const event = { id: "e1", messageId: "msg1", sourceId: "source", serverId: "source", characterId: CID, mode: "server", message: "看看新通知", reason: "new", createdAt: new Date(e.deps.now()).toISOString() };
    const service = new WakeService(e.deps, async body => body.action === "events" ? { events: [event], sources: [] } : (ack++, { acceptedIds: [event.id] }));
    e.setNow("2026-09-16T16:01");
    const sending = e.tick();
    await started;
    assert.equal(await service.poll(), 0);
    assert.equal(ack, 0);
    unblock(); await sending;
    assert.equal(held, "");
    assert.equal(await service.poll(), 1);
    assert.equal(ack, 1);
    assert.match(e.modelCalls.at(-1)!, /下午忙不忙呀/);
    assert.equal(held, "");
  } finally { unblock(); e.store.close(); }
});

test("影子模式遇到已成文草稿不投递、不调用租约、不消耗失败重试", async () => {
  const e = setup("live", "2026-09-16T15:00");
  try {
    await e.tick();
    const rest = e.deps.rest;
    e.deps.rest = async (p, init) => p === "push_outbox" ? new Response("down", { status: 503 }) : rest(p, init);
    e.setNow("2026-09-16T16:01"); await e.tick();
    const id = e.store.getDay(CID, "2026-09-16")!.items[0].wakeId;
    assert.ok(e.store.getDraft(id));
    const posts = e.calls.filter(c => c.method === "POST").length;
    e.setNow("2026-09-16T16:07");
    const trace = await tickCharacter(e.deps, "shadow", CID);
    assert.equal(trace.error, undefined);
    assert.equal(e.calls.filter(c => c.method === "POST").length, posts);
    assert.equal(e.pushes.length, 0);
    assert.equal(e.store.getTimer(id)!.status, "shadow");
    assert.ok(e.store.getDraft(id));
  } finally { e.store.close(); }
});

test("作罢的成文仍记录模型用量，但不暂存/投递正文", async () => {
  const e = setup("live", "2026-09-16T15:00");
  try {
    await e.tick();
    e.deps.fetchModel = async () => Response.json({ content: [{ type: "text", text: "[挂念作罢：聊天已提过]" }] });
    e.setNow("2026-09-16T16:01"); await e.tick();
    assert.equal(e.calls.filter(c => c.path === "rpc/ai_phone_usage_add" && (c.body as any).p_source === "cloud-wake").length, 1);
    assert.equal(e.pushes.length, 0);
    assert.equal(e.store.getDraft(e.store.getDay(CID, "2026-09-16")!.items[0].wakeId), null);
  } finally { e.store.close(); }
});

// ─── 发送分流：来电 / 发到微信 / 快捷动作（delivery.ts、shortcut-resume.ts）

function withChatReply(env: ReturnType<typeof setup>, reply: string) {
  const original = env.deps.fetchModel;
  const bodies: string[] = [];
  env.deps.fetchModel = async (u, init) => {
    const body = String(init.body);
    if (body.includes("后台判断任务")) return original(u, init);
    bodies.push(body);
    return Response.json({ content: [{ type: "text", text: reply }], usage: { input_tokens: 1, output_tokens: 1 } });
  };
  return bodies;
}

function patchSnapshot(env: ReturnType<typeof setup>, patch: (s: any) => void) {
  const snap = env.store.getSnapshot(CID, "chat")!;
  patch(snap);
  env.store.saveSnapshot(snap);
}

test("来电：模板占位按 20 小时频控放说明，标记剥掉，推单条来电通知", async () => {
  const env = setup("live", "2026-09-16T15:00", true);
  try {
    patchSnapshot(env, s => { s.request.body.messages.push({ role: "user", content: "__GUANIAN_CALL_INVITE__" }); });
    await env.tick();
    const bodies = withChatReply(env, "[我向你发起了语音通话]\n想听听你的声音");
    env.setNow("2026-09-16T16:01"); await env.tick();
    assert.match(bodies[0], /可选能力：如果你此刻更想直接给对方打语音电话/);
    assert.doesNotMatch(bodies[0], /__GUANIAN_CALL_INVITE__/);
    const out = env.calls.find(c => c.method === "POST" && c.path === "push_outbox")!.body as any[];
    assert.equal(out[0].raw_text, "想听听你的声音");
    assert.equal(env.pushes[0].length, 1);
    assert.equal(env.pushes[0][0].type, "incoming_call");
    assert.equal(env.pushes[0][0].sessionId, "sess1");
    assert.match(env.pushes[0][0].url!, /^\/\?ring=sess1&rt=\d+$/);
    assert.ok(Number(env.store.getCharacter(CID)!.state.callInviteAt) > 0);
  } finally { env.store.close(); }
});

function fakeCloud(opts: { weixinOk?: boolean; created?: boolean } = {}) {
  const calls: { path: string; body: any }[] = [];
  const cloud = async (path: string, init: RequestInit = {}) => {
    calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path.startsWith("storage/v1/object/ai-phone-backup/weixin-cloud/cron-secret.json")) return Response.json({ token: "wx-secret" });
    if (path === "functions/v1/weixin-assistant") return Response.json({ ok: opts.weixinOk !== false, ...(opts.weixinOk === false ? { error: "bot offline" } : {}) });
    if (path.includes("action=shortcut-create")) return Response.json(opts.created === false ? { ok: false, error: "too many" } : { ok: true, command: { id: "cmd_1" }, resultUrl: "https://r" });
    if (path.includes("action=shortcut-deliver")) return Response.json({ ok: true, delivered: true });
    return new Response("{}", { status: 404 });
  };
  return { cloud, calls };
}

test("发到微信：送成了不进聊天 outbox、记发送；送失败改发到聊天", async () => {
  for (const ok of [true, false]) {
    const env = setup("live", "2026-09-16T15:00", true);
    try {
      patchSnapshot(env, s => { s.weixin = { botId: "bot1" }; });
      await env.tick();
      const fc = fakeCloud({ weixinOk: ok });
      env.deps.cloud = fc.cloud; env.deps.cloudKey = "k";
      withChatReply(env, "【发到微信】\n在忙吗");
      env.setNow("2026-09-16T16:01"); await env.tick();
      const wx = fc.calls.find(c => c.path === "functions/v1/weixin-assistant")!;
      assert.deepEqual(wx.body, { action: "send-text", token: "wx-secret", bot: "bot1", text: "在忙吗" });
      const outbox = env.calls.filter(c => c.method === "POST" && c.path === "push_outbox");
      const item = env.store.getDay(CID, "2026-09-16")!.items[0];
      assert.equal(env.store.getTimer(item.wakeId)!.status, "done");
      assert.equal(env.store.getDraft(item.wakeId), null);
      if (ok) {
        assert.equal(outbox.length, 0);
        assert.equal(env.store.pendingFeedback(CID).length, 1);
        assert.match(env.store.lastDecision(CID, "send")!.note, /发到微信了：在忙吗/);
      } else {
        assert.equal(outbox.length, 1);
        assert.equal((outbox[0].body as any[])[0].raw_text, "在忙吗");
      }
    } finally { env.store.close(); }
  }
});

test("快捷动作：建命令、outbox 带标记位置、先推消息再投递命令、挂续跑；结果回来后端生成第二轮", async () => {
  const env = setup("live", "2026-09-16T15:00", true);
  try {
    patchSnapshot(env, s => {
      s.shortcutContinuation = {
        request: { ...structuredClone(s.request), body: { model: "m", messages: [{ role: "user", content: "你当时想着：“__GUANIAN_INTENT__”" }, { role: "assistant", content: "__REPLY__" }, { role: "user", content: "__RESULT__" }, { role: "user", content: "__IMAGE__" }] } },
        replyMarker: "__REPLY__", resultMarker: "__RESULT__", imageMarker: "__IMAGE__", visionEnabled: true,
      };
    });
    await env.tick();
    const fc = fakeCloud();
    env.deps.cloud = fc.cloud; env.deps.cloudKey = "k";
    const baseRest = env.deps.rest;
    let commandStatus = "pending";
    env.deps.rest = async (path, init) => {
      if (path.startsWith("push_bridge_config?")) return Response.json([{ shortcut_actions: [{ actionId: "a1", name: "查天气", shortcutName: "Weather", resultMode: "text", deliveryMode: "push", expiresInSeconds: 120 }] }]);
      if (path.startsWith("push_server_config?")) return Response.json([{ site_origin: "https://float.example" }]);
      if (path.startsWith("push_outbox?") && path.includes("&id=eq.")) {
        const id = new URLSearchParams(path.split("?")[1]).get("id")!.slice(3);
        return Response.json(env.calls.filter(c => c.method === "POST" && c.path === "push_outbox").flatMap(c => c.body as any[]).filter(o => o.id === id));
      }
      if (path.startsWith("push_shortcut_commands?")) return Response.json([{ id: "cmd_1", status: commandStatus, action_name: "查天气", result_mode: "text", result: { text: "晴，26 度" }, error: null, expires_at: new Date(env.deps.now() + 60_000).toISOString() }]);
      return baseRest(path, init);
    };
    withChatReply(env, "我帮你看看天气\n【快捷动作：查天气({\"city\":\"上海\"})】\n等我一下");
    env.setNow("2026-09-16T16:01"); await env.tick();

    const create = fc.calls.find(c => c.path.includes("shortcut-create"))!;
    assert.deepEqual(create.body.arguments, { city: "上海" });
    assert.equal(create.body.deferDelivery, true);
    const out = (env.calls.find(c => c.method === "POST" && c.path === "push_outbox")!.body as any[])[0];
    assert.equal(out.raw_text, "我帮你看看天气\n\n等我一下");
    assert.equal(out.meta.shortcutMarker.name, "查天气");
    assert.equal(out.meta.shortcutMarker.insertAt, "我帮你看看天气\n".length);
    assert.ok(fc.calls.some(c => c.path.includes("shortcut-deliver") && c.body.commandId === "cmd_1"));

    const { runShortcutResumes } = await import("../src/shortcut-resume.ts");
    // 还没跑完：往后排，不调模型
    env.setNow("2026-09-16T16:02");
    const second = withChatReply(env, "上海今天晴，26 度，出门不用带伞【快捷动作：查天气】");
    assert.equal(await runShortcutResumes(env.deps), 0);
    assert.equal(second.length, 0);
    commandStatus = "succeeded";
    env.setNow("2026-09-16T16:03");
    assert.equal(await runShortcutResumes(env.deps), 1);
    assert.match(second[0], /我帮你看看天气/);
    assert.match(second[0], /<action_result name=\\"查天气\\">晴，26 度<\/action_result>/);
    assert.match(second[0], /该动作没有图片回传/);
    const resumed = env.calls.filter(c => c.method === "POST" && c.path === "push_outbox").map(c => (c.body as any[])[0]).find(o => o.trigger_key === "shortcut:cmd_1");
    assert.equal(resumed.raw_text, "上海今天晴，26 度，出门不用带伞");
    assert.equal(resumed.meta.shortcutCommandId, "cmd_1");
    assert.equal(env.store.dueResumes(Infinity).length, 0);
  } finally { env.store.close(); }
});

test("快捷动作建过但结果未确认（重启）：不重复建命令，照常发消息并落诊断", async () => {
  const env = setup("live", "2026-09-16T15:00", true);
  try {
    await env.tick();
    const item = env.store.getDay(CID, "2026-09-16")!.items[0];
    env.store.saveDraft({ wakeId: item.wakeId, userId: "u1", sessionId: "sess1", outboxId: "out_x", createdAt: new Date(at("2026-09-16T16:00")).toISOString(), rawText: "好",
      meta: {}, notify: { title: "赵兖", url: "/" }, shortcut: { text: "【快捷动作：查天气】", insertAt: 1, name: "查天气", args: {} }, shortcutTried: true });
    const fc = fakeCloud();
    env.deps.cloud = fc.cloud; env.deps.cloudKey = "k";
    env.setNow("2026-09-16T16:01"); await env.tick();
    assert.equal(fc.calls.filter(c => c.path.includes("shortcut-create")).length, 0);
    const posts = env.calls.filter(c => c.method === "POST" && c.path === "push_outbox").map(c => (c.body as any[])[0]);
    assert.equal(posts[0].raw_text, "好");
    assert.equal(posts[0].meta.shortcutMarker, undefined);
    assert.equal(posts[1].meta.kind, "shortcut_delivery_error");
  } finally { env.store.close(); }
});

async function setupShortcutDelivery(resultMode = "text") {
  const env = setup("live", "2026-09-16T15:00", true);
  patchSnapshot(env, s => {
    s.shortcutContinuation = {
      request: { ...structuredClone(s.request), body: { model: "m", messages: [{ role: "assistant", content: "__REPLY__" }, { role: "user", content: "__RESULT__" }] } },
      replyMarker: "__REPLY__", resultMarker: "__RESULT__",
    };
  });
  await env.tick();
  const fc = fakeCloud();
  env.deps.cloud = fc.cloud; env.deps.cloudKey = "fake";
  const rest = env.deps.rest;
  env.deps.rest = async (path, init) => {
    if (path.startsWith("push_bridge_config?")) return Response.json([{ shortcut_actions: [{ actionId: "a1", name: "查天气", shortcutName: "Weather", resultMode, deliveryMode: "push", expiresInSeconds: 900 }] }]);
    if (path.startsWith("push_server_config?")) return Response.json([{ site_origin: "https://float.example" }]);
    return rest(path, init);
  };
  const models = withChatReply(env, "我看看【快捷动作：查天气】");
  const wakeId = env.store.getDay(CID, "2026-09-16")!.items[0].wakeId;
  return { env, fc, models, wakeId };
}

test("首条 outbox 已提交但回执丢失：恢复后补投快捷通知，再挂结果续跑", async () => {
  const { env, fc, models, wakeId } = await setupShortcutDelivery();
  try {
    const rest = env.deps.rest;
    let loseResponse = true;
    env.deps.rest = async (p, init) => {
      const response = await rest(p, init);
      if (p === "push_outbox" && loseResponse) { loseResponse = false; throw new Error("committed but response lost"); }
      return response;
    };
    env.setNow("2026-09-16T16:01"); await env.tick();
    assert.equal(fc.calls.filter(c => c.path.includes("shortcut-deliver")).length, 0);
    assert.equal(env.store.dueResumes(Infinity).length, 0);
    assert.ok(env.store.getDraft(wakeId));
    env.setNow("2026-09-16T16:07"); await env.tick();
    assert.equal(fc.calls.filter(c => c.path.includes("shortcut-create")).length, 1);
    assert.equal(fc.calls.filter(c => c.path.includes("shortcut-deliver")).length, 1);
    assert.equal(env.calls.filter(c => c.path === "push_outbox" && c.method === "POST").length, 1);
    assert.equal(models.length, 1);
    assert.equal(env.store.getTimer(wakeId)!.status, "done");
    assert.equal(env.store.getDraft(wakeId), null);
    assert.equal(env.store.dueResumes(Infinity)[0].sourceWakeId, wakeId);
  } finally { env.store.close(); }
});

test("命令投递失败保留阶段：原消息不重发，恢复后只补同一命令", async () => {
  const { env, fc, wakeId } = await setupShortcutDelivery();
  try {
    const cloud = env.deps.cloud!;
    let down = true, deliveries = 0;
    env.deps.cloud = async (p, init) => {
      if (p.includes("shortcut-deliver")) { deliveries++; if (down) return Response.json({ ok: false, error: "push down" }, { status: 503 }); }
      return cloud(p, init);
    };
    env.setNow("2026-09-16T16:01"); await env.tick();
    assert.equal(env.store.getTimer(wakeId)!.status, "pending");
    assert.equal(env.store.dueResumes(Infinity).length, 0);
    assert.ok(env.store.getDraft(wakeId));
    down = false;
    env.setNow("2026-09-16T16:07"); await env.tick();
    assert.equal(deliveries, 2);
    assert.equal(fc.calls.filter(c => c.path.includes("shortcut-create")).length, 1);
    assert.equal(env.calls.filter(c => c.path === "push_outbox").length, 1);
    assert.equal(env.pushes.length, 1);
    assert.equal(env.store.getTimer(wakeId)!.status, "done");
    assert.equal(env.store.dueResumes(Infinity).length, 1);
  } finally { env.store.close(); }
});

test("目录读取/建命令等待中取消或失去租约，阻止后续动作与消息", async () => {
  for (const stage of ["catalog", "create", "lease"] as const) {
    const { env, fc } = await setupShortcutDelivery("none");
    try {
      const rest = env.deps.rest, cloud = env.deps.cloud!;
      let stopped = false;
      env.deps.halted = () => stage !== "lease" && stopped;
      env.deps.rest = async (p, init) => {
        const response = await rest(p, init);
        if (stage === "catalog" && p.startsWith("push_bridge_config?")) stopped = true;
        if (stage === "lease" && stopped && p === "rpc/push_generation_lease" && JSON.parse(String(init?.body)).p_action === "renew") return Response.json(false);
        return response;
      };
      env.deps.cloud = async (p, init) => { const response = await cloud(p, init); if (p.includes("shortcut-create")) stopped = true; return response; };
      env.setNow("2026-09-16T16:01"); await env.tick();
      assert.equal(env.calls.filter(c => c.path === "push_outbox").length, 0, stage);
      assert.equal(fc.calls.filter(c => c.path.includes("shortcut-deliver")).length, 0, stage);
      assert.equal(env.pushes.length, 0, stage);
      assert.equal(env.store.dueResumes(Infinity).length, 0, stage);
      if (stage === "catalog") assert.equal(fc.calls.filter(c => c.path.includes("shortcut-create")).length, 0);
      else assert.equal(fc.calls.find(c => c.path.includes("shortcut-create"))!.body.deferDelivery, true, "无回传动作也不能在创建时自动执行");
    } finally { env.store.close(); }
  }
});

test("微信明确失败后固定转聊天，聊天写入重试不再尝试微信", async () => {
  const env = setup("live", "2026-09-16T15:00", true);
  try {
    patchSnapshot(env, s => { s.weixin = { botId: "bot1" }; }); await env.tick();
    const fc = fakeCloud({ weixinOk: false }); env.deps.cloud = fc.cloud;
    const rest = env.deps.rest; let writes = 0;
    env.deps.rest = async (p, init) => p === "push_outbox" && ++writes === 1 ? new Response("down", { status: 503 }) : rest(p, init);
    const models = withChatReply(env, "【发到微信】在忙吗");
    env.setNow("2026-09-16T16:01"); await env.tick();
    env.setNow("2026-09-16T16:07"); await env.tick();
    assert.equal(writes, 2); assert.equal(models.length, 1);
    assert.equal(fc.calls.filter(c => c.path === "functions/v1/weixin-assistant").length, 1);
    assert.equal(env.pushes.length, 1);
  } finally { env.store.close(); }
});

test("微信已送但回执丢失、5xx 或重启时 sending：保留未知状态，不改投不重发", async () => {
  for (const failure of ["lost", "500", "restart"] as const) {
    const env = setup("live", "2026-09-16T15:00", true);
    try {
      patchSnapshot(env, s => { s.weixin = { botId: "bot1" }; }); await env.tick();
      const fc = fakeCloud(); let attempts = 0;
      env.deps.cloud = async (p, init) => {
        if (p === "functions/v1/weixin-assistant") { attempts++; if (failure === "lost") throw new Error("accepted but response lost"); return new Response("failure", { status: 500 }); }
        return fc.cloud(p, init);
      };
      withChatReply(env, "【发到微信】在忙吗");
      const id = env.store.getDay(CID, "2026-09-16")!.items[0].wakeId;
      if (failure === "restart") env.store.saveDraft({ wakeId: id, userId: "u1", sessionId: "sess1", outboxId: "out_saved", createdAt: new Date(env.deps.now()).toISOString(), rawText: "在忙吗", meta: {}, notify: { title: "TA", url: "/" }, weixinBotId: "bot1", weixinState: "sending" });
      env.setNow("2026-09-16T16:01"); await env.tick();
      env.setNow("2026-09-16T16:07"); await env.tick();
      assert.equal(attempts, failure === "restart" ? 0 : 1);
      assert.equal(env.calls.filter(c => c.path === "push_outbox").length, 0);
      assert.equal(env.store.getDraft(id)!.weixinState, "unknown");
      assert.equal(env.store.getTimer(id)!.status, "failed");
    } finally { env.store.close(); }
  }
});

// ─── 止血（2026-11）：备用通道、分段重试、原话落库、由头降权、想念分阶段

const dayRow = (date: string) => ({
  characterId: CID, date, items: [], selfUsed: 0, recheckCount: 0, judgedAt: 0, judgedChatAt: at("2026-09-16T12:01"),
  genTries: 0, genError: "", genLog: [], source: "server", updatedAt: 0,
  day: { tz: 480, mood: "平静", energy: 70, wake: "08:00", bed: "23:30", schedule: [], conds: [] },
});
const deadSnapshot = (env: ReturnType<typeof setup>, purpose: "daily" | "judge") => {
  const chat = env.store.getSnapshot(CID, "chat")!;
  env.store.saveSnapshot({ ...chat, purpose, request: { ...chat.request, url: "https://dead.example/v1/messages", body: { ...chat.request.body, model: "dead" } } });
};
const reply = (text: string) => Response.json({ content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } });

test("生成用的通道调不通：换聊天快照的地址和模型再生成一次", async () => {
  const env = setup("live", "2026-09-17T08:00");
  try {
    deadSnapshot(env, "daily");
    const seen: { url: string; model: string }[] = [];
    env.deps.fetchModel = async (url, init) => {
      const body = String(init.body);
      if (body.includes("后台判断任务")) return reply('{"decisions":[],"extra":[]}');
      seen.push({ url: String(url), model: JSON.parse(body).model });
      if (String(url).includes("dead.example")) return new Response('{"error":"no_cookie_available"}', { status: 503 });
      return reply(JSON.stringify({ schedule: [{ time: "16:00", title: "工作" }] }));
    };
    await env.tick();
    const row = env.store.getDay(CID, "2026-09-17")!;
    assert.equal(row.genError, "");
    assert.equal(row.day!.schedule!.length, 1);
    assert.deepEqual(seen, [{ url: "https://dead.example/v1/messages", model: "dead" }, { url: "https://model.example/v1/messages", model: "m" }]);
    assert.match(row.genLog.join("\n"), /换用聊天的模型/);
    assert.equal(env.pushes.length, 0);
  } finally { env.store.close(); }
});

test("一直生成不出来：一天分三段重试、只推一次通知，起念按昨天的作息照常", async () => {
  const env = setup("live", "2026-09-17T08:00");
  try {
    let judged = 0;
    env.deps.fetchModel = async (_u, init) => {
      if (String(init.body).includes("后台判断任务")) { judged += 1; return reply('{"decisions":[],"extra":[],"skip":"还早"}'); }
      return new Response("挂了", { status: 503 });
    };
    for (const hm of ["08:00", "08:11", "08:22", "08:33", "09:40"]) { env.setNow("2026-09-17T" + hm); await env.tick(); }
    assert.equal(env.store.getDay(CID, "2026-09-17")!.genTries, 3);
    const notices = env.pushes.flat().filter(m => m.type === "guanian_gen_failed");
    assert.equal(notices.length, 1);
    assert.match(notices[0].title, /赵兖今天的日程没生成出来/);
    assert.ok(judged >= 1, "没有今天的生活面也该能自发起念");
    env.setNow("2026-09-17T12:00"); await env.tick();
    assert.equal(env.store.getDay(CID, "2026-09-17")!.genTries, 4);
    assert.equal(env.pushes.flat().filter(m => m.type === "guanian_gen_failed").length, 1);
  } finally { env.store.close(); }
});

test("自发起念被否：不占自发额度，原话和原因落库，同一种由头歇一阵", async () => {
  const env = setup("live", "2026-09-16T15:00");
  try {
    env.deps.fetchModel = async (_u, init) => { env.modelCalls.push(String(init.body)); return reply('{"decisions":[],"extra":[],"skip":"TA在上班，不打扰"}'); };
    await env.tick();
    assert.match(env.modelCalls[0], /并在 skip 里用一句话写清/);
    assert.equal(env.store.getDay(CID, "2026-09-16")!.selfUsed, 0);
    const judge = env.store.listDecisions(CID, 10).find(d => d.kind === "judge")!;
    assert.match(judge.note, /想了想，没找你（TA在上班，不打扰）/);
    assert.equal(judge.data!.selfKind, "quiet");
    assert.match(String(judge.data!.raw), /TA在上班/);
    assert.equal((env.store.getCharacter(CID)!.state as any).selfTry.skips.quiet.n, 1);
    env.setNow("2026-09-16T16:10"); await env.tick();
    assert.equal(env.modelCalls.length, 1);
    assert.match(env.store.lastDecision(CID, "gate")!.note, /刚被TA自己否过/);
    // 歇够 3 小时再问
    env.setNow("2026-09-16T18:05"); await env.tick();
    assert.equal(env.modelCalls.length, 2);
  } finally { env.store.close(); }
});

test("判断模型没调通或回的不是 JSON：记一笔带原话的决定，不让这一轮报错", async () => {
  for (const bad of ["http", "text"]) {
    const env = setup("live", "2026-09-16T15:00");
    try {
      env.deps.fetchModel = async () => bad === "http" ? new Response("挂了", { status: 503 }) : reply("我想想啊，还是不发了吧");
      const trace = await env.tick();
      assert.equal(trace.error, undefined);
      const judge = env.store.listDecisions(CID, 10).find(d => d.kind === "judge")!;
      assert.match(judge.note, bad === "http" ? /模型没调通/ : /不是 JSON/);
      if (bad === "text") assert.match(String(judge.data!.raw), /还是不发了吧/);
      // 断联 4 天的想念阶段不因为没判成而用掉
      env.store.saveDay(dayRow("2026-09-20")); env.setNow("2026-09-20T15:00"); await env.tick();
      assert.equal(env.store.getCharacter(CID)!.state.missKey, undefined);
    } finally { env.store.close(); }
  }
});

test("自发起念写的时刻已经过了：挪到 3 分钟后，不整条丢掉", async () => {
  const env = setup("live", "2026-09-16T15:00");
  try {
    env.deps.fetchModel = async () => reply('{"decisions":[],"extra":[{"time":"14:50","matterId":"new:1","about":"想你","intent":"问问下午忙不忙","why":"好久没说话"}]}');
    await env.tick();
    const row = env.store.getDay(CID, "2026-09-16")!;
    assert.equal(row.items.length, 1);
    assert.equal(row.items[0].time, "15:03");
    assert.equal(row.selfUsed, 1);
  } finally { env.store.close(); }
});

test("想念分阶段：每个阶段问一次模型，阶段没变不重复问，最后一句是自己发的也能想念", async () => {
  const env = setup("live", "2026-09-20T15:00");
  try {
    for (const d of ["2026-09-20", "2026-09-21", "2026-09-23"]) env.store.saveDay(dayRow(d));
    const prompts: string[] = [];
    env.deps.fetchModel = async (_u, init) => { prompts.push(String(init.body)); return reply('{"decisions":[],"extra":[],"skip":"再等等"}'); };
    await env.tick();
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /已经 4 天没联系了，最后一句是你发的/);
    assert.equal(env.store.getCharacter(CID)!.state.missKey, `${at("2026-09-16T12:00")}:1`);
    env.setNow("2026-09-21T15:00"); await env.tick();
    assert.equal(prompts.length, 1);
    assert.match(env.store.lastDecision(CID, "gate")!.note, /这一阶段的想念已经问过了/);
    env.setNow("2026-09-23T15:00"); await env.tick();
    assert.equal(prompts.length, 2);
    assert.equal(env.store.getCharacter(CID)!.state.missKey, `${at("2026-09-16T12:00")}:2`);
  } finally { env.store.close(); }
});

// ─── 审计第一批（2026-11）：发错、发不出、白耗额度

function withMessages(env: ReturnType<typeof setup>, list: { id: string; role: string; content: string; message_at: string }[]) {
  const rest = env.deps.rest;
  env.deps.rest = async (p, init) => p.startsWith("push_chat_mirror?") && p.includes("media_type.is.null,and(") ? Response.json(list) : rest(p, init);
  return list;
}
const msg = (id: string, role: string, local: string, content: string) => ({ id, role, content, message_at: new Date(at(local)).toISOString() });
const EMPTY_JUDGE = '{"decisions":[],"extra":[],"keep":[],"settle":[],"skip":"再等等"}';

test("作罢标记后面多带了字：照样作罢不发；念头同时标成作罢，让出当天额度", async () => {
  const e = setup("live", "2026-09-16T15:00");
  try {
    await e.tick();
    withChatReply(e, "[挂念作罢：聊天已提过]。\n\n[内心]其实还是有点想问");
    e.setNow("2026-09-16T16:01"); await e.tick();
    assert.equal(e.pushes.length, 0);
    assert.equal(e.calls.filter(c => c.path === "push_outbox" && c.method === "POST").length, 0);
    const item = e.store.getDay(CID, "2026-09-16")!.items[0];
    assert.equal(item.act, false);
    assert.match(item.why, /核对后作罢：聊天已提过/);
    assert.equal(e.store.getTimer(item.wakeId)!.status, "done");
  } finally { e.store.close(); }
});

test("到点发送一直失败：默认只在 10 分钟内再试两次，过了就作罢并让出额度；打开延长重试才按设的窗口拉长", async () => {
  // [设置的窗口, 每次失败的时刻 → 下次再试的时刻（空 = 作罢）]
  const cases: [number | undefined, [string, string][]][] = [
    [undefined, [["16:01", "16:06"], ["16:07", "16:12"], ["16:13", ""]]],
    [0, [["16:01", "16:06"], ["16:07", "16:12"], ["16:13", ""]]],
    [30, [["16:01", "16:06"], ["16:07", "16:17"], ["16:18", ""]]],
    [120, [["16:01", "16:06"], ["16:07", "16:17"], ["16:18", "16:38"], ["16:39", "17:19"], ["17:20", ""]]],
  ];
  for (const [windowMin, steps] of cases) {
    const e = setup("live", "2026-09-16T15:00");
    try {
      const c = e.store.getCharacter(CID)!;
      c.settings.busyMaxHoldMin = 1_000_000;
      if (windowMin !== undefined) c.settings.sendRetryMin = windowMin;
      e.store.saveCharacter(c);
      await e.tick();
      const id = e.store.getDay(CID, "2026-09-16")!.items[0].wakeId;
      const original = e.deps.fetchModel;
      e.deps.fetchModel = async (u, init) => String(init.body).includes("后台判断任务") ? original(u, init) : new Response("挂了", { status: 503 });
      for (const [now, next] of steps) {
        e.setNow("2026-09-16T" + now); await e.tick();
        const timer = e.store.getTimer(id)!, item = e.store.getDay(CID, "2026-09-16")!.items[0];
        assert.equal(timer.status, next ? "pending" : "failed", `窗口 ${windowMin}，${now}`);
        if (next) assert.equal(timer.fireAt, at("2026-09-16T" + next));
        assert.equal(item.act, !!next);
        if (!next) assert.match(item.why, /没发出去，作罢/);
      }
      assert.equal(e.pushes.length, 0);
    } finally { e.store.close(); }
  }
});

test("晚发的念头：事实核对里写明晚了多久，和时刻绑着的话让模型作罢", async () => {
  const e = setup("live", "2026-09-16T15:00");
  try {
    const c = e.store.getCharacter(CID)!; c.settings.busyMaxHoldMin = 1_000_000; e.store.saveCharacter(c);
    await e.tick();
    const bodies = withChatReply(e, "在忙吗");
    e.setNow("2026-09-16T16:45"); await e.tick();
    assert.match(bodies[0], /原定 16:00 发，现在已经晚了 45 分钟/);
  } finally { e.store.close(); }
});

test("空回复不当场作废：五分钟后重试能发出去", async () => {
  const e = setup("live", "2026-09-16T15:00");
  try {
    await e.tick();
    const id = e.store.getDay(CID, "2026-09-16")!.items[0].wakeId;
    const original = e.deps.fetchModel;
    let empty = true;
    e.deps.fetchModel = async (u, init) => !empty || String(init.body).includes("后台判断任务") ? original(u, init) : reply("");
    e.setNow("2026-09-16T16:01"); await e.tick();
    assert.equal(e.store.getTimer(id)!.status, "pending");
    assert.match(e.store.getTimer(id)!.note, /tries:1 .*回复是空的/);
    empty = false;
    e.setNow("2026-09-16T16:07"); await e.tick();
    assert.equal(e.store.getTimer(id)!.status, "done");
    assert.equal(e.pushes.length, 1);
  } finally { e.store.close(); }
});

test("约定快车道：一天头两次 1 分钟就再判，之后至少隔 10 分钟", async () => {
  const env = setup("live", "2026-09-16T15:00");
  try {
    const list = withMessages(env, [msg("u1", "user", "2026-09-16T14:40", "明天八点记得叫我")]);
    let n = 0;
    env.deps.fetchModel = async () => { n += 1; return reply(EMPTY_JUDGE); };
    await env.tick();
    assert.equal(n, 1);
    for (const [said, now, want] of [["15:00", "15:01", 2], ["15:01", "15:02", 3], ["15:02", "15:03", 3], ["15:03", "15:13", 4]] as const) {
      list.push(msg("u" + now, "user", "2026-09-16T" + said, "那周五一起去看电影吧"));
      env.setNow("2026-09-16T" + now); await env.tick();
      assert.equal(n, want, `${now} 这一轮`);
    }
    assert.deepEqual(env.store.getCharacter(CID)!.state.ledgerFast, { date: "2026-09-16", n: 3 });
  } finally { env.store.close(); }
});

test("判断没判成：同一批约定线索不每分钟重判；模型根本没调通不占当天判断次数", async () => {
  for (const bad of ["text", "http"]) {
    const env = setup("live", "2026-09-16T15:00");
    try {
      withMessages(env, [msg("u1", "user", "2026-09-16T14:40", "明天八点记得叫我")]);
      let n = 0;
      env.deps.fetchModel = async () => { n += 1; return bad === "http" ? new Response("挂了", { status: 503 }) : reply("让我想想"); };
      await env.tick();
      env.setNow("2026-09-16T15:01"); await env.tick();
      env.setNow("2026-09-16T15:10"); await env.tick();
      assert.equal(n, 1, "正常间隔没到，不再判");
      assert.equal(env.store.getDay(CID, "2026-09-16")!.recheckCount, bad === "http" ? 0 : 1);
      env.setNow("2026-09-16T15:26"); await env.tick();
      assert.equal(n, 2);
    } finally { env.store.close(); }
  }
});

test("跨零点：从昨天判到的地方接着看，不把零点前的聊天再判一遍", async () => {
  const env = setup("live", "2026-09-17T00:05");
  try {
    withMessages(env, [msg("u1", "user", "2026-09-16T21:00", "今天好累"), msg("a1", "assistant", "2026-09-16T21:01", "早点睡")]);
    const d = env.store.getDay(CID, "2026-09-16")!; d.judgedChatAt = at("2026-09-16T21:00"); env.store.saveDay(d);
    await env.tick();
    assert.equal(env.modelCalls.length, 0);
    assert.equal(env.store.getDay(CID, "2026-09-17")!.judgedChatAt, at("2026-09-16T21:00"));
  } finally { env.store.close(); }
});

test("手动撤掉的约定念头，下一轮不会被重新挂回去", async () => {
  const env = setup("live", "2026-09-16T15:00");
  try {
    const c = env.store.getCharacter(CID)!;
    c.settings.threadsOn = 1;
    c.state.threads = [{ id: "p1", kind: "promise", subject: "character", text: "叫你起床", due: at("2026-09-16T18:00"), revision: 1, status: "pending", since: at("2026-09-16T12:00"), at: at("2026-09-16T12:00") }];
    env.store.saveCharacter(c);
    await env.tick();
    const row = env.store.getDay(CID, "2026-09-16")!;
    const item = row.items.find(i => i.kind === "promise")!;
    assert.equal(env.store.getTimer(item.wakeId)!.status, "pending");
    // 和 App 的「撤掉」做同样的事
    item.act = false; item.why = "你手动撤掉了"; env.store.saveDay(row);
    env.store.updateTimer(item.wakeId, { status: "cancelled", note: "你手动撤掉了" });
    env.setNow("2026-09-16T15:01"); await env.tick();
    assert.equal(env.store.getTimer(item.wakeId)!.status, "cancelled");
    assert.equal(env.store.getDay(CID, "2026-09-16")!.items.filter(i => i.kind === "promise").length, 1);
  } finally { env.store.close(); }
});

test("没真正问到模型不算问过：分量不够被拦不占想念阶段；「到日子了」被婉拒歇一阵再问", async () => {
  const miss = setup("live", "2026-09-20T15:00");
  try {
    const c = miss.store.getCharacter(CID)!; c.settings.quota = 1; miss.store.saveCharacter(c);
    miss.store.saveDay(dayRow("2026-09-20"));
    await miss.tick();
    assert.equal(miss.modelCalls.length, 0);
    assert.match(miss.store.lastDecision(CID, "gate")!.note, /「想念」这种由头分量不够/);
    assert.equal(miss.store.getCharacter(CID)!.state.missKey, undefined);
  } finally { miss.store.close(); }

  const env = setup("live", "2026-09-16T10:00");
  try {
    const c = env.store.getCharacter(CID)!;
    c.settings.threadsOn = 1;
    c.state.threads = [{ id: "d1", kind: "date", text: "你的生日", due: at("2026-09-16T12:00"), since: at("2026-09-10T12:00"), at: at("2026-09-10T12:00") }];
    env.store.saveCharacter(c);
    withMessages(env, [msg("u1", "user", "2026-09-15T20:00", "晚安"), msg("a1", "assistant", "2026-09-15T20:01", "晚安")]);
    const d = env.store.getDay(CID, "2026-09-16")!; d.judgedChatAt = at("2026-09-15T20:01"); env.store.saveDay(d);
    env.deps.fetchModel = async () => reply('{"decisions":[],"extra":[],"skip":"太早了，晚点再说"}');
    await env.tick();
    const kinds = () => env.store.listDecisions(CID, 20).filter(x => x.kind === "judge").map(x => x.data?.selfKind);
    assert.deepEqual(kinds(), ["thread"]);
    assert.doesNotMatch(String(env.store.getCharacter(CID)!.state.threads![0].nudge || ""), /day:/);
    env.setNow("2026-09-16T13:05"); await env.tick();
    assert.equal(kinds().filter(k => k === "thread").length, 2, "歇够 3 小时，今年这个生日还会再问");
  } finally { env.store.close(); }
});

test("用量上限读不到：不当成没上限。判断这轮不调模型；到点的消息押 5 分钟，不算一次发送失败", async () => {
  const e = setup("live", "2026-09-16T15:00");
  try {
    const rest = e.deps.rest;
    let down = true;
    e.deps.rest = async (p, init) => down && p.startsWith("push_api_limits?") ? new Response("down", { status: 503 }) : rest(p, init);
    const trace = await e.tick();
    assert.equal(trace.error, undefined);
    assert.equal(e.modelCalls.length, 0);
    down = false;
    e.setNow("2026-09-16T15:01"); await e.tick();
    assert.equal(e.modelCalls.length, 1);
    const id = e.store.getDay(CID, "2026-09-16")!.items[0].wakeId;
    down = true;
    e.setNow("2026-09-16T16:01"); await e.tick();
    assert.equal(e.modelCalls.length, 1);
    const held = e.store.getTimer(id)!;
    assert.equal(held.status, "pending");
    assert.equal(held.fireAt, at("2026-09-16T16:06"));
    assert.doesNotMatch(held.note, /tries:/);
    assert.match(e.store.listDecisions(CID, 5).find(d => d.kind === "hold")!.note, /读不到用量上限/);
    down = false;
    e.setNow("2026-09-16T16:07"); await e.tick();
    assert.equal(e.store.getTimer(id)!.status, "done");
    assert.equal(e.pushes.length, 1);
  } finally { e.store.close(); }
});

test("重启打断的模型调用不记成失败：判断不留「模型没调通」，到点的消息原样放回待发，重启后照常发", async () => {
  const e = setup("live", "2026-09-16T15:00");
  try {
    const original = e.deps.fetchModel;
    let stopping = false, cut = true;
    e.deps.stopping = () => stopping;
    e.deps.fetchModel = async (u, init) => { if (!cut) return original(u, init); stopping = true; throw new Error("后端正在重启"); };
    await e.tick();
    assert.equal(e.store.listDecisions(CID, 10).some(d => d.kind === "judge"), false);
    assert.equal(e.store.getDay(CID, "2026-09-16")!.recheckCount, 0);
    stopping = false; cut = false;
    e.setNow("2026-09-16T15:40"); await e.tick();
    const id = e.store.getDay(CID, "2026-09-16")!.items[0].wakeId;
    cut = true;
    e.setNow("2026-09-16T16:01"); await e.tick();
    const timer = e.store.getTimer(id)!;
    assert.equal(timer.status, "pending");
    assert.doesNotMatch(timer.note, /tries:/);
    assert.equal(e.store.listDecisions(CID, 10).some(d => d.kind === "error"), false);
    // 退出途中不再开新的一轮判断和发送
    const before = e.calls.length;
    await e.tick();
    assert.equal(e.store.getTimer(id)!.status, "pending");
    assert.ok(e.calls.length - before < 6);
    stopping = false; cut = false;
    e.setNow("2026-09-16T16:02"); await e.tick();
    assert.equal(e.store.getTimer(id)!.status, "done");
    assert.equal(e.pushes.length, 1);
  } finally { e.store.close(); }
});

test("角色切了会话、聊天模板还是旧会话的：不拿旧会话的记录成文；新会话的模板到了才发", async () => {
  const e = setup("live", "2026-09-16T15:00");
  try {
    await e.tick();
    const id = e.store.getDay(CID, "2026-09-16")!.items[0].wakeId;
    const c = e.store.getCharacter(CID)!;
    c.sessionId = "sess2"; e.store.saveCharacter(c);
    e.setNow("2026-09-16T16:01"); await e.tick();
    assert.equal(e.modelCalls.filter(b => !b.includes("后台判断任务")).length, 0);
    assert.match(e.store.getTimer(id)!.note, /tries:1 .*另一个会话/);
    const snap = e.store.getSnapshot(CID, "chat")!;
    e.store.saveSnapshot({ ...snap, sessionId: "sess2", capturedAt: at("2026-09-16T16:02") });
    e.setNow("2026-09-16T16:07"); await e.tick();
    assert.equal(e.store.getTimer(id)!.status, "done");
    assert.equal((e.calls.find(x => x.path === "push_outbox" && x.method === "POST")!.body as { session_id: string }[])[0].session_id, "sess2");
  } finally { e.store.close(); }
});

test("生成一天放到锁外：一轮不等它；期间不重复生成、别的照常跑；生成期间手动有了这一天就以手动的为准", async () => {
  for (const manual of [false, true]) {
    const e = setup("live", "2026-09-17T08:00");
    try {
      let release!: (r: Response) => void;
      const pending = new Promise<Response>(resolve => { release = resolve; });
      let genCalls = 0;
      e.deps.fetchModel = async (_u, init) => {
        if (String(init.body).includes("后台判断任务")) return reply(EMPTY_JUDGE);
        genCalls++;
        return pending;
      };
      const runner = new Runner(e.deps, "live", { detachGeneration: true });
      const [first] = await runner.tick();
      assert.match(first.steps.join("\n"), /开始生成（后台）/);
      assert.equal(runner.running, false);
      assert.equal(runner.busy, true);
      assert.equal(e.store.getDay(CID, "2026-09-17")!.day, null);
      assert.equal(e.store.getDay(CID, "2026-09-17")!.genTries, 1);
      e.setNow("2026-09-17T08:01");
      const [second] = await runner.tick();
      assert.match(second.steps.join("\n"), /正在生成/);
      // 手机这时候的改动不用等生成：锁是空的，马上做完
      assert.equal(await runner.exclusive(() => "ok"), "ok");
      if (manual) e.store.saveDay({ ...dayRow("2026-09-17"), source: "app" });
      release(reply(JSON.stringify({ schedule: [{ time: "16:00", title: "工作" }] })));
      await runner.settled();
      assert.equal(genCalls, 1);
      assert.equal(runner.busy, false);
      const row = e.store.getDay(CID, "2026-09-17")!;
      assert.equal(row.source, manual ? "app" : "server");
      assert.equal(row.day!.schedule!.length, manual ? 0 : 1);
      if (!manual) assert.match(e.store.listDecisions(CID, 5).find(d => d.kind === "gen")!.note, /生成今日生活面/);
    } finally { e.store.close(); }
  }
});
