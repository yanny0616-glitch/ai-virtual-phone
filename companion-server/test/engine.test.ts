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
