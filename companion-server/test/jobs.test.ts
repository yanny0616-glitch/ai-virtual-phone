import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "../src/store.ts";
import { runOfflineJobs, skipQuiet } from "../src/jobs.ts";
import type { EngineDeps } from "../src/engine.ts";
import { handleApp, type AppDeps } from "../src/api.ts";

const T0 = Date.parse("2026-09-16T08:00:00Z");

function setup(opts: { reply?: string; cloudJobs?: any[]; mirror?: any[] } = {}) {
  const store = new Store(":memory:");
  let now = T0;
  const calls: { path: string; init?: RequestInit }[] = [];
  const outputs: any[] = [], pushes: any[] = [], requests: string[] = [], cloudCalls: { path: string; body: any }[] = [];
  const state = { failOutbox: false, reply: opts.reply ?? "在干嘛呢", cloudJobs: opts.cloudJobs ?? [], onModel: () => {} };
  const deps: EngineDeps = {
    store, userId: "u", now: () => now, random: () => 0.5, log: () => {},
    rest: async (path, init) => {
      calls.push({ path, init });
      if (path === "rpc/push_generation_lease") return Response.json(true);
      if (path.startsWith("push_jobs?") && (init?.method || "GET") === "GET") return Response.json(state.cloudJobs);
      if (path.startsWith("push_jobs?") && init?.method === "DELETE") {
        const gone = state.cloudJobs.filter(j => j.status === "pending");
        state.cloudJobs = state.cloudJobs.filter(j => j.status !== "pending");
        return Response.json(gone);
      }
      if (path.startsWith("push_subscriptions?")) return Response.json([{ endpoint: "https://push.test/1" }]);
      if (path.startsWith("push_chat_mirror?")) return Response.json(opts.mirror ?? [{ id: "m1", role: "user", content: "我去洗澡了", message_at: "2026-09-16T07:50:00Z" }]);
      if (path.startsWith("push_outbox?") && !path.startsWith("push_outbox?on_conflict")) {
        const id = new URLSearchParams(path.split("?")[1]).get("id")?.slice(3);
        return Response.json(id ? outputs.filter(o => o.id === id) : path.includes("created_at=gte") ? [] : outputs);
      }
      if (path === "push_outbox" || path.startsWith("push_outbox?on_conflict")) {
        if (state.failOutbox) return new Response("down", { status: 503 });
        outputs.push(...JSON.parse(String(init?.body)));
        return new Response(null, { status: 201 });
      }
      return Response.json([]);
    },
    cloud: async (path, init) => {
      cloudCalls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path.includes("cron-secret.json")) return Response.json({ token: "wx" });
      if (path === "functions/v1/weixin-assistant") return Response.json({ ok: true });
      return Response.json({ ok: true });
    },
    cloudKey: "k",
    fetchModel: async (_u, init) => { requests.push(String(init.body)); state.onModel(); return Response.json({ content: [{ type: "text", text: state.reply }], usage: { input_tokens: 1, output_tokens: 1 } }); },
    push: async list => { pushes.push(...list); return { sent: list.length, total: 1, removed: 0, skippedShell: 0, errors: [] }; },
  };
  const put = (triggerKey: string, kind: string, payload: Record<string, any> = {}, executeAt = now) => store.putJob({
    id: "job_" + triggerKey, triggerKey, kind, executeAt, createdAt: now,
    payload: { request: { url: "https://model.test", headers: {}, providerKind: "anthropic", body: { model: "m", messages: [{ role: "user", content: "hi" }] } },
      notify: { title: "TA", url: "/", characterId: "c" }, merge: { sessionId: "s", tzOffsetMin: 480, characterName: "TA" }, ...payload },
  }, now);
  return { deps, store, state, calls, outputs, pushes, requests, cloudCalls, put, advance: (ms: number) => { now += ms; } };
}

test("定时消息到点：补最新聊天、写 outbox（原 triggerKey、meta）、分段推送，做完删掉请求本体", async () => {
  const e = setup({ reply: "洗完了吗\n\n我刚到家" });
  e.put("timedwake:w1", "timed_task");
  assert.equal(await runOfflineJobs(e.deps), 1);
  assert.match(e.requests[0], /最新云端聊天事实[\s\S]*我去洗澡了/);
  assert.match(e.requests[0], /UTC\+8，当前当地时间 2026-09-16T16:00/);
  assert.equal(e.outputs.length, 1);
  assert.equal(e.outputs[0].trigger_key, "timedwake:w1");
  assert.equal(e.outputs[0].id, "out_job_job_timedwake:w1");
  assert.equal(e.outputs[0].meta.pushGenerated, true);
  assert.equal(e.outputs[0].meta.characterName, "TA");
  assert.ok(e.pushes.length >= 1);
  assert.equal(e.pushes[0].type, "chat_outbox");
  const job = e.store.getJob("timedwake:w1")!;
  assert.equal(job.status, "done");
  assert.equal(job.payload.request, undefined);
});

test("回复兜底不读聊天镜像；来电标记改发来电推送", async () => {
  const e = setup({ reply: "[我向你发起了语音通话]\n喂，在吗" });
  e.put("reply:s", "reply_bailout");
  await runOfflineJobs(e.deps);
  assert.equal(e.calls.some(c => c.path.startsWith("push_chat_mirror?")), false);
  assert.equal(e.outputs[0].raw_text, "喂，在吗");
  assert.equal(e.pushes.length, 1);
  assert.equal(e.pushes[0].type, "incoming_call");
  assert.match(e.pushes[0].url, /^\/\?ring=s&rt=/);
});

test("未回应降速：连续没回够轮数就不生成", async () => {
  const e = setup({ mirror: [
    { id: "u", role: "user", content: "嗯", message_at: "2026-09-16T04:00:00Z" },
    { id: "a1", role: "assistant", content: "在吗", message_at: "2026-09-16T05:00:00Z" },
    { id: "a2", role: "assistant", content: "人呢", message_at: "2026-09-16T06:00:00Z" },
  ] });
  e.put("timedwake:w2", "timed_task", { merge: { sessionId: "s", tzOffsetMin: 480, cooldownRounds: 2 } });
  await runOfflineJobs(e.deps);
  assert.equal(e.requests.length, 0);
  assert.match(e.store.getJob("timedwake:w2")!.note, /presend skip/);
});

test("个人云同名任务：正在跑就等；有更早的待发就撤掉它再发；这条挂上后云端已处理就不发", async () => {
  const running = setup({ cloudJobs: [{ id: "cj", status: "running", created_at: "2026-09-16T07:00:00Z", updated_at: "2026-09-16T07:59:00Z" }] });
  running.put("idle:r:0", "timed_task");
  await runOfflineJobs(running.deps);
  assert.equal(running.requests.length, 0);
  assert.equal(running.store.getJob("idle:r:0")!.status, "pending");
  assert.ok(running.store.getJob("idle:r:0")!.executeAt > T0);

  const older = setup({ cloudJobs: [{ id: "cj", status: "pending", created_at: "2026-09-16T07:00:00Z", updated_at: "2026-09-16T07:00:00Z" }] });
  older.put("idle:r:0", "timed_task");
  await runOfflineJobs(older.deps);
  assert.ok(older.calls.some(c => c.path.startsWith("push_jobs?") && c.init?.method === "DELETE" && c.path.includes("status=eq.pending")));
  assert.equal(older.outputs.length, 1);

  const handled = setup({ cloudJobs: [{ id: "cj", status: "done", created_at: "2026-09-16T08:00:10Z", updated_at: "2026-09-16T08:01:00Z" }] });
  handled.put("idle:r:0", "timed_task");
  await runOfflineJobs(handled.deps);
  assert.equal(handled.requests.length, 0);
  assert.match(handled.store.getJob("idle:r:0")!.note, /cloud skip/);
});

test("生成期间手机撤销：不写 outbox、不推送", async () => {
  const e = setup();
  e.put("followup:s:1", "followup");
  e.state.onModel = () => { e.store.cancelJobs({ triggerPrefix: "followup:s:" }, T0); };
  await runOfflineJobs(e.deps);
  assert.equal(e.requests.length, 1);
  assert.equal(e.outputs.length, 0);
  assert.equal(e.pushes.length, 0);
  assert.match(e.store.getJob("followup:s:1")!.note, /cancelled/);
});

test("outbox 写失败：保留正文重试，不重新调模型", async () => {
  const e = setup();
  e.put("periodcare:c:2026-09", "timed_task");
  e.state.failOutbox = true;
  await runOfflineJobs(e.deps);
  const job = e.store.getJob("periodcare:c:2026-09")!;
  assert.equal(job.status, "pending");
  assert.equal(job.tries, 1);
  assert.equal(job.payload.draft.rawText, "在干嘛呢");
  e.state.failOutbox = false;
  e.advance(2 * 60_000);
  await runOfflineJobs(e.deps);
  assert.equal(e.requests.length, 1);
  assert.equal(e.outputs.length, 1);
  assert.equal(e.store.getJob("periodcare:c:2026-09")!.status, "done");
});

test("安静太久连发：做完续排 key+，剩余次数减一，落在安静时段顺延", async () => {
  const quietWin = { startMin: 23 * 60, endMin: 8 * 60, tzOffsetMin: 480 };
  // 16:00 本地 + 7 小时 = 23:00 进安静时段 → 顺延到 08:00
  assert.equal(skipQuiet(T0 + 7 * 3600_000, quietWin), T0 + 16 * 3600_000);
  const e = setup();
  e.put("idle:r:0", "timed_task", { merge: { sessionId: "s", tzOffsetMin: 480, idleReconnect: { ruleId: "r" }, idleRepeat: { intervalMs: 3600_000, remaining: 2, quietWin } } });
  await runOfflineJobs(e.deps);
  const next = e.store.getJob("idle:r:0+")!;
  assert.equal(next.status, "pending");
  assert.equal(next.executeAt, T0 + 3600_000 + 15_000);
  assert.equal(next.payload.merge.idleRepeat.remaining, 1);
  assert.equal(next.payload.draft, undefined);
  assert.equal(next.payload.merge.idleRearmed, undefined);
});

test("沉默：允许不回时只写静默更新，不推送", async () => {
  const e = setup({ reply: "[本轮不回复]\n<update>x</update>" });
  e.put("reply:s", "reply_bailout", { allowSilence: true });
  await runOfflineJobs(e.deps);
  assert.equal(e.pushes.length, 0);
  assert.equal(e.outputs[0].id, "out_silence_job_reply:s");
  assert.equal(e.outputs[0].meta.silentUpdate, true);
  assert.equal(e.store.getJob("reply:s")!.note, "reply silenced");
});

test("发到微信：成功就不进聊天 outbox", async () => {
  const e = setup({ reply: "【发到微信】到家了没" });
  e.put("timedwake:w3", "timed_task", { weixin: { botId: "bot1" } });
  await runOfflineJobs(e.deps);
  const sent = e.cloudCalls.find(c => c.path === "functions/v1/weixin-assistant")!;
  assert.equal(sent.body.text, "到家了没");
  assert.equal(e.outputs.length, 0);
  assert.match(e.store.getJob("timedwake:w3")!.note, /weixin/);
});

test("接口：同键覆盖、正在生成回 409、按前缀撤销保留 excludeKey、心跳往后推", async () => {
  const e = setup();
  const app = { store: e.store, engine: e.deps, runner: {} } as unknown as AppDeps;
  const call = (path: string, body: unknown, method = "POST") => handleApp(app, method, path, new URLSearchParams(), async () => body);
  const job = { triggerKey: "idle:r:0", kind: "timed_task", executeAt: new Date(T0 + 60_000).toISOString(),
    payload: { request: { url: "https://model.test", headers: {}, providerKind: "anthropic", body: {} }, merge: { sessionId: "s" } } };
  assert.equal((await call("/app/jobs", job))!.status, 200);
  assert.equal((await call("/app/jobs", { ...job, kind: "template" }))!.status, 400);
  assert.equal((await call("/app/jobs", { ...job, triggerKey: "idle:r:1" }))!.status, 200);
  assert.deepEqual((await call("/app/jobs/delay", { triggerKey: "idle:r:0" }))!.body, { ok: true, delayed: true });
  assert.equal(e.store.getJob("idle:r:0")!.executeAt, T0 + 90_000);
  e.store.claimJob(e.store.getJob("idle:r:0")!, T0);
  assert.equal((await call("/app/jobs", job))!.status, 409);
  assert.deepEqual((await call("/app/jobs/cancel", { triggerPrefix: "idle:r:", excludeKey: "idle:r:2" }))!.body, { ok: true, deleted: 1, running: 1 });
  assert.equal(e.store.jobCancelRequested(e.store.getJob("idle:r:0")!), true);
  const listed = (await call("/app/jobs", null, "GET"))!.body as { jobs: { triggerKey: string }[] };
  assert.deepEqual(listed.jobs.map(j => j.triggerKey), ["idle:r:0"]);
});
