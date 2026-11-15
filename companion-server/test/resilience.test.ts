// 审计第二批：个人云抖动、坏数据、内网地址这些「不该把后端带倒」的情况
import assert from "node:assert/strict";
import test from "node:test";

import { appState, type AppDeps } from "../src/api.ts";
import { Auth, supabaseKeyCheck } from "../src/auth.ts";
import type { EngineDeps } from "../src/engine.ts";
import { acquireGenerationLease } from "../src/generation-lease.ts";
import { healthReport, PushWatch } from "../src/health.ts";
import { readHistory } from "../src/history.ts";
import { usageBudget, usageTz, UsageUnknown } from "../src/llm.ts";
import { assertPublicUrl, guardedFetch, isPrivateAddress, parseAllowHosts } from "../src/net-guard.ts";
import { Runner } from "../src/runner.ts";
import { Store } from "../src/store.ts";

test("密钥校验：个人云抖动回 unavailable 且不缓存成「密钥无效」；核对过的密钥抖动期间照认", async () => {
  let t = 0, mode: "ok" | "down" | "bad" = "down", checks = 0;
  const auth = new Auth("admin", async () => { checks++; if (mode === "down") throw new Error("timeout"); return mode === "ok"; }, () => t);
  assert.equal(await auth.verify("Bearer key1"), "unavailable");
  mode = "ok";
  // 没被缓存成无效：个人云一恢复，马上就认
  assert.equal(await auth.verify("Bearer key1"), "ok");
  assert.equal(checks, 2);
  t += 31 * 60_000; mode = "down";
  assert.equal(await auth.verify("Bearer key1"), "ok");
  assert.equal(await auth.verify("Bearer never-seen"), "unavailable");
  t += 25 * 3600_000;
  assert.equal(await auth.verify("Bearer key1"), "unavailable");
  mode = "bad";
  assert.equal(await auth.verify("Bearer key2"), "denied");
  assert.equal(await auth.allow("Bearer key2"), false);

  const check = (status: number, body = "[]") => supabaseKeyCheck("https://p.example", (async () => new Response(body, { status })) as typeof fetch)("k");
  await assert.rejects(check(503), /HTTP 503/);
  await assert.rejects(check(429), /HTTP 429/);
  assert.equal(await check(401), false);
  assert.equal(await check(200, '[{"id":"main"}]'), true);
});

test("会话租约：续租请求一次没问到不算丢；拖到快到期还续不上才停，恢复后接着用；个人云明说不是你的才永久判丢", async () => {
  let now = 0;
  const script: (boolean | number)[] = [];
  const rest = async (_p: string, init: RequestInit = {}) => {
    const action = JSON.parse(String(init.body)).p_action;
    if (action !== "renew") return Response.json(true);
    const next = script.shift();
    return typeof next === "number" ? new Response("down", { status: next }) : Response.json(next ?? true);
  };
  const lease = await acquireGenerationLease(rest, "u", "s", "t", 1e9, () => now);
  script.push(503);
  await lease.check();
  now += 9 * 60_000; script.push(503);
  await assert.rejects(lease.check(), /续不上.*9 分钟/);
  script.push(true);
  await lease.check();
  script.push(false);
  await assert.rejects(lease.check(), /租约已失效/);
  await assert.rejects(lease.check(), /租约已失效/);
  await lease.release();
});

test("聊天镜像里有坏行：跳过并计数，不让整轮「聊天历史读取失败」；坏的整轮快照退回发件箱原文", async () => {
  const iso = "2026-09-16T04:00:00.000Z";
  const rest = async (path: string) => {
    if (path.startsWith("push_outbox?")) return Response.json([{ id: "o1", trigger_key: "timedwake:w1", raw_text: "下午忙不忙呀", created_at: "2026-09-16T05:00:00.000Z", meta: { pushGenerated: true } }, { raw_text: "没有 id" }]);
    if (path.includes("media_type=eq.response_batch")) return Response.json([{ id: "b1", media_type: "response_batch", response_batch_id: "push-outbox:o1", content: "{坏掉的 JSON" }]);
    if (path.startsWith("push_chat_mirror?")) return Response.json([
      { id: "m1", role: "user", content: "我去上班了", message_at: iso },
      { id: "m2", role: "assistant", content: null, message_at: iso },
      { id: "m3", role: "user", content: { broken: true }, message_at: iso },
      { id: "m4", role: "user", content: "时间坏了", message_at: "不是时间" },
      null,
    ]);
    return Response.json([]);
  };
  const history = await readHistory(rest, "u", "s1");
  assert.deepEqual(history.messages.map(m => m.content), ["我去上班了", "下午忙不忙呀"]);
  assert.equal(history.skipped, 5);
});

test("用量：上限或当天用量读不到就抛 UsageUnknown，不当成没上限；没有上限这一行才是没上限；记账时区沿用上次读到的", async () => {
  const table = (limits: Response, usage: Response) => async (path: string) => path.startsWith("push_api_limits?") ? limits : usage;
  await assert.rejects(usageBudget(table(new Response("x", { status: 503 }), Response.json([])), "uA"), UsageUnknown);
  await assert.rejects(usageBudget(table(Response.json([{ daily_calls: 5, tz: 480 }]), new Response("x", { status: 500 })), "uA"), UsageUnknown);
  await assert.rejects(usageBudget(async () => { throw new Error("网络断了"); }, "uA"), UsageUnknown);
  // 上一次读到过时区 480：这次读不到，记账仍按 480 落天
  assert.equal(usageTz("uA"), 480);
  const none = await usageBudget(table(Response.json([]), Response.json([])), "uB");
  assert.equal(none.dailyCalls, 0);
  const some = await usageBudget(table(Response.json([{ daily_calls: 5, tz: 480 }]), Response.json([{ calls: 2, prompt_tokens: 10, completion_tokens: 5 }])), "uB");
  assert.deepEqual([some.calls, some.tokens, some.dailyCalls, some.tz], [2, 15, 5, 480]);
});

test("出站地址设防：本机 / 内网 / 链路本地不请求，不跟随跳转；放行名单里的主机名例外", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.17.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "159.195.37.106", "172.32.0.1", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);

  const dns: Record<string, string[]> = { "model.example": ["93.184.216.34"], "evil.example": ["93.184.216.34", "127.0.0.1"], "gw.internal": ["172.17.0.1"] };
  const resolve = async (host: string) => { if (!dns[host]) throw new Error("ENOTFOUND"); return dns[host]; };
  const none = new Set<string>();
  await assertPublicUrl("https://model.example/v1/messages", none, resolve);
  await assert.rejects(assertPublicUrl("https://evil.example/v1", none, resolve), /本机或内网/);
  await assert.rejects(assertPublicUrl("http://127.0.0.1:18070/status", none, resolve), /本机或内网/);
  await assert.rejects(assertPublicUrl("http://[::1]:8080/", none, resolve), /本机或内网/);
  await assert.rejects(assertPublicUrl("http://localhost/x", none, resolve), /解析不出/);
  await assert.rejects(assertPublicUrl("file:///etc/passwd", none, resolve), /只能是 http/);
  await assertPublicUrl("http://gw.internal:8080/v1", parseAllowHosts(" GW.internal , other "), resolve);

  const seen: RequestInit[] = [];
  let status = 200;
  const guarded = guardedFetch(none, async (_u, init) => { seen.push(init); return new Response(null, { status, headers: status === 302 ? { Location: "http://127.0.0.1/" } : {} }); }, resolve);
  assert.equal((await guarded("https://model.example/v1", { method: "POST" })).status, 200);
  assert.equal(seen[0].redirect, "manual");
  await assert.rejects(guarded("http://gw.internal/v1", {}), /本机或内网/);
  assert.equal(seen.length, 1);
  status = 302;
  await assert.rejects(guarded("https://model.example/v1", {}), /不跟随跳转/);
});

test("后端体检并进 /app/state：挂念诊断页读得到问题代号和原因", () => {
  const store = new Store(":memory:");
  const engine: EngineDeps = {
    store, rest: async () => Response.json([]), userId: "u", fetchModel: async () => Response.json({}),
    push: async () => ({ total: 0, sent: 0, removed: 0, skippedShell: 0, errors: [] }), now: () => 1_800_000_000_000, random: () => 0.5, log: () => undefined,
  };
  const runner = new Runner(engine, "live");
  const now = engine.now();
  store.saveCharacter({ characterId: "c1", sessionId: "s1", name: "赵兖", enabled: true, settings: { tzOffsetMin: 480, recheckEnabled: 1 }, state: {}, importedAt: 0, updatedAt: 0 });
  store.addDecision("c1", "judge", "想你——模型没调通，这轮没判成：模型 HTTP 503", "live", { failed: "call" }, now - 60_000);
  const push = new PushWatch();
  push.record(now - 60_000, { total: 0, sent: 0, removed: 0, skippedShell: 0, errors: [] });
  const deps: AppDeps = { store, runner, engine, health: nowMs => healthReport(store, runner, push, now - 60_000, nowMs) };
  const state = appState(deps, ["c1"]) as { health?: { ok: boolean; problems: { code: string; note: string }[] } };
  assert.equal(state.health!.ok, false);
  assert.deepEqual(state.health!.problems.map(p => p.code), ["model_unreachable", "no_push_subscription"]);
  assert.match(state.health!.problems[0].note, /赵兖：.*HTTP 503/);
  // 没接体检的调用方（旧测试、命令行）不带这个字段
  assert.equal("health" in appState({ store, runner, engine }, ["c1"]), false);
  store.close();
});
