import assert from "node:assert/strict";
import { test } from "node:test";

import { handleApp, type AppDeps } from "../src/api.ts";
import type { EngineDeps } from "../src/engine.ts";
import { Runner } from "../src/runner.ts";
import { Store } from "../src/store.ts";
import { runWake, textCalls, WakeService, type WakeDeps, type WakeEvent, type WakeTemplate } from "../src/wake.ts";

const PH = "__FLOAT_WAKE_EVENT__";

function template(kind: "openai-compatible" | "anthropic", protocol: "native" | "text" | "none"): WakeTemplate {
  const tools = [{ type: "function", function: { name: "garden_look_ab12", description: "看花园", parameters: { type: "object", properties: {} } } }];
  const body: Record<string, unknown> = kind === "anthropic"
    ? { model: "m", system: "你是沈烬言", messages: [{ role: "user", content: [{ type: "text", text: "早" }] }, { role: "assistant", content: [{ type: "text", text: "早啊" }] }, { role: "user", content: [{ type: "text", text: PH }] }], ...(protocol === "native" ? { tools: [{ name: "garden_look_ab12", description: "看花园", input_schema: { type: "object" } }] } : {}), stream: true }
    : { model: "m", messages: [{ role: "system", content: "你是沈烬言。当前系统时间：2026年9月1日08:00，星期二" }, { role: "user", content: PH }, { role: "system", content: "【输出格式】" }], ...(protocol === "native" ? { tools } : {}), stream: true };
  return {
    sourceId: "mcp_garden", characterId: "char1", sessionId: "sess1", capturedAt: 1000,
    request: { url: "https://model.example/v1", headers: { Authorization: "Bearer model-secret" }, body, providerKind: kind },
    placeholder: PH, protocol,
    toolNames: protocol === "native" ? { garden_look_ab12: "garden_look" } : {},
    schemaText: protocol === "text" ? { "花园": "以下是你获取指令的返回结果：\n动作：garden_look" } : {},
    mcp: { url: "https://garden.example/mcp", headers: { Authorization: "Bearer mcp-secret" } },
    maxRounds: 5,
    merge: { characterName: "沈烬言", userName: "我", appId: "chat", appTags: ["chat", "text"], regexes: [], tzOffsetMin: 480 },
    notify: { title: "沈烬言", url: "/" },
  };
}

const EVENT: WakeEvent = { id: "ev1", messageId: "tool_event_ev1", sourceId: "mcp_garden", serverId: "mcp_garden", characterId: "char1", mode: "server", message: "花园里有新通知，用 MCP 看看", reason: "forum_notification_available", createdAt: "2026-09-17T01:00:00.000Z" };

function harness(modelReplies: unknown[]) {
  const store = new Store(":memory:");
  const requests: any[] = [];
  const mcpCalls: any[] = [];
  const outbox: any[] = [];
  const pushes: any[] = [];
  const deps: WakeDeps = {
    store, userId: "u1", now: () => Date.parse("2026-09-17T01:00:05Z"), log: () => undefined,
    rest: async (path, init) => {
      if (path === "rpc/push_generation_lease") return Response.json(true);
      if (path.startsWith("push_outbox") && init?.method === "POST") { outbox.push(...JSON.parse(String(init?.body))); return new Response("", { status: 201 }); }
      return new Response("[]", { status: 200 });
    },
    fetchModel: async (_url, init) => {
      requests.push(JSON.parse(String(init.body)));
      const reply = modelReplies.shift();
      return new Response(JSON.stringify(reply), { status: 200 });
    },
    fetchMcp: async (_url, init) => {
      const msg = JSON.parse(String(init.body));
      mcpCalls.push({ msg, headers: init.headers });
      if (msg.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }), { status: 200, headers: { "mcp-session-id": "s1" } });
      if (msg.method === "notifications/initialized") return new Response("", { status: 202 });
      // 工具结果走 SSE
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "论坛：有人回复了你的帖子" }] } })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    push: async messages => { pushes.push(...messages); return { sent: messages.length, total: 1, removed: 0, skippedShell: 0, errors: [] }; },
  };
  return { store, deps, requests, mcpCalls, outbox, pushes };
}

test("OpenAI 原生工具：占位换成事件原文，经 MCP 调工具再回复，写 outbox 并推送", async () => {
  const h = harness([
    { choices: [{ message: { content: "我去看看", tool_calls: [{ id: "call_1", type: "function", function: { name: "garden_look_ab12", arguments: "{\"page\":1}" } }], reasoning_content: "想想" } }] },
    { choices: [{ message: { content: "有人回我帖子了\n\n等下跟你说" } }] },
  ]);
  const out = await runWake(h.deps, template("openai-compatible", "native"), EVENT);
  assert.equal(out.status, "sent");
  assert.equal(h.requests.length, 2);
  const first = h.requests[0];
  assert.equal(first.stream, false);
  assert.equal(first.messages[1].content, EVENT.message);
  assert.ok(first.tools, "原生协议保留工具定义");
  assert.match(first.messages[0].content, /2026年9月17日09:00/, "时间刷新到事件发生时");
  const second = h.requests[1];
  const tail = second.messages.slice(-2);
  assert.equal(tail[0].role, "assistant");
  assert.equal(tail[0].tool_calls[0].id, "call_1");
  assert.equal(tail[0].reasoning_content, "想想");
  assert.equal(tail[1].role, "tool");
  assert.match(tail[1].content, /<action_result name="garden_look" success="true">\n论坛：有人回复了你的帖子/);
  const call = h.mcpCalls.find(c => c.msg.method === "tools/call");
  assert.deepEqual(call.msg.params, { name: "garden_look", arguments: { page: 1 } });
  assert.equal(call.headers.Authorization, "Bearer mcp-secret");
  assert.equal(call.headers["mcp-session-id"], "s1");
  assert.equal(h.outbox.length, 1);
  const row = h.outbox[0];
  assert.equal(row.trigger_key, "wake:ev1");
  assert.equal(row.session_id, "sess1");
  assert.equal(row.raw_text, "我去看看\n\n有人回我帖子了\n\n等下跟你说");
  assert.equal(row.meta.toolEvent.message, EVENT.message);
  assert.equal(row.meta.toolEvent.messageId, "tool_event_ev1");
  assert.deepEqual(row.meta.toolEvent.actions.map((a: any) => [a.name, a.ok]), [["garden_look", true]]);
  assert.equal(row.meta.tzOffsetMin, undefined);
  assert.equal(h.pushes.length, 3);
  assert.equal(h.pushes[0].title, "沈烬言");
});

test("Anthropic 原生工具：tool_use 原样接回，结果以 tool_result 给回", async () => {
  const h = harness([
    { content: [{ type: "thinking", thinking: "嗯", signature: "sig" }, { type: "tool_use", id: "tu_1", name: "garden_look_ab12", input: {} }] },
    { content: [{ type: "text", text: "看完了" }] },
  ]);
  const out = await runWake(h.deps, template("anthropic", "native"), EVENT);
  assert.equal(out.text, "看完了");
  const msgs = h.requests[1].messages;
  assert.equal(msgs.at(-2).role, "assistant");
  assert.equal(msgs.at(-2).content[0].signature, "sig");
  assert.equal(msgs.at(-1).content[0].type, "tool_result");
  assert.equal(msgs.at(-1).content[0].tool_use_id, "tu_1");
});

test("文字协议：获取指令 → 执行动作 → 回复，往返插在事件消息后、格式说明前", async () => {
  const h = harness([
    { choices: [{ message: { content: "[获取指令:花园]" } }] },
    { choices: [{ message: { content: "[执行动作:garden_look({\"page\":2})]" } }] },
    { choices: [{ message: { content: "帖子有人回了" } }] },
  ]);
  const out = await runWake(h.deps, template("openai-compatible", "text"), EVENT);
  assert.equal(out.text, "帖子有人回了");
  assert.equal(h.requests[0].tools, undefined);
  const msgs = h.requests[2].messages;
  assert.equal(msgs[1].content, EVENT.message);
  assert.equal(msgs[2].content, "[获取指令:花园]");
  assert.match(msgs[3].content, /动作：garden_look/);
  assert.equal(msgs[4].content, "[执行动作:garden_look({\"page\":2})]");
  assert.match(msgs[5].content, /^以下是系统处理结果：\n<action_result name="garden_look">论坛/);
  assert.equal(msgs.at(-1).content, "【输出格式】");
  assert.deepEqual(h.outbox[0].meta.toolEvent.actions[0].args, { page: 2 });
});

test("文字协议解析与小手机同规则", () => {
  const r = textCalls("好\n[执行动作:看帖（{\"id\":\"a(b)\"}）]\n[获取指令:花园]");
  assert.deepEqual(r.calls.map(c => [c.name, c.args]), [["看帖", { id: "a(b)" }]]);
  assert.equal(r.clean, "好");
});

test("WakeService：没底稿的事件留在网关不领；有底稿先 ack 再处理；来源断开推提醒", async () => {
  const h = harness([{ choices: [{ message: { content: "嗯" } }] }]);
  const calls: any[] = [];
  let status = "connected";
  const gateway = async (body: Record<string, unknown>) => {
    calls.push(body);
    if (body.action === "events") return { sources: [{ serverId: "mcp_garden", characterId: "char1", mode: "server", adapter: "garden", status, lastError: status === "stopped" ? "花园连接中断" : "" }], events: [EVENT] };
    if (body.action === "ack") return { acceptedIds: body.ids };
    return {};
  };
  const svc = new WakeService(h.deps, gateway);
  assert.equal(await svc.poll(), 0);
  assert.equal(calls.filter(c => c.action === "ack").length, 0);
  assert.equal(h.store.listWakeRuns()[0].status, "waiting");
  assert.equal(calls[0].mode, "server");

  h.store.saveWakeTemplate(template("openai-compatible", "native"));
  assert.equal(await svc.poll(), 1);
  assert.deepEqual(calls.filter(c => c.action === "ack").map(c => c.ids), [["ev1"]]);
  assert.equal(h.store.listWakeRuns()[0].status, "sent");
  assert.equal(h.outbox.length, 1);

  status = "stopped";
  const pushesBefore = h.pushes.length;
  (h.deps as any).fetchModel = async () => { throw new Error("模型挂了"); };
  await svc.poll();
  assert.equal(h.pushes.length, pushesBefore + 1);
  assert.equal(h.pushes.at(-1).title, "唤醒来源断开了");
  assert.ok(h.store.listWakeRuns(10).some(r => r.status === "disconnected"));
  // 模型失败：记错误，事件原文和原因仍寄回聊天
  assert.equal(h.store.listWakeRuns()[0].status, "error");
  assert.equal(h.outbox.at(-1).meta.toolEvent.error, "模型挂了");
});

test("接口：寄底稿要带占位，状态不含密钥，旧底稿不覆盖新底稿", async () => {
  const store = new Store(":memory:");
  const engine = { store, log: () => undefined } as unknown as EngineDeps;
  const deps: AppDeps = { store, runner: new Runner(engine, "shadow"), engine };
  const call = async (method: string, path: string, body?: unknown) => (await handleApp(deps, method, path, new URLSearchParams(path.split("?")[1] || ""), async () => body ?? {}))!;
  const tpl = template("openai-compatible", "native");
  assert.equal((await call("PUT", "/app/wake/templates/mcp_garden", { ...tpl, placeholder: "__NOPE_NOPE__" })).status, 400);
  assert.equal((await call("PUT", "/app/wake/templates/other", tpl)).status, 400);
  assert.equal((await call("PUT", "/app/wake/templates/mcp_garden", { ...tpl, mcp: { url: "http://x", headers: {} } })).status, 400);
  assert.equal((await call("PUT", "/app/wake/templates/mcp_garden", tpl)).status, 200);
  const kept = await call("PUT", "/app/wake/templates/mcp_garden", { ...tpl, capturedAt: 10, sessionId: "old" });
  assert.equal((kept.body as any).kept, true);
  const st = await call("GET", "/app/wake/status");
  const text = JSON.stringify(st.body);
  assert.ok(!text.includes("secret"), "状态里不能带模型或 MCP 密钥");
  assert.equal((st.body as any).templates[0].tools, 1);
  assert.equal((st.body as any).templates[0].mcpUrl, "https://garden.example/mcp");
  assert.equal(((await call("POST", "/app/wake/templates/mcp_garden/delete")).body as any).deleted, true);
  assert.equal(store.getWakeTemplate("mcp_garden"), null);
});

test("会话被挂念/旧云端占用时不 ack，拿到锁后补最新聊天再处理", async () => {
  const h = harness([{ choices: [{ message: { content: "收到" } }] }]);
  try {
    h.store.saveWakeTemplate(template("openai-compatible", "none"));
    const rest = h.deps.rest;
    let busy = true, claimed = false, acks = 0;
    h.deps.rest = async (p, init) => {
      if (p === "rpc/push_generation_lease") {
        const action = JSON.parse(String(init?.body)).p_action;
        if (action === "claim") { claimed = !busy; return Response.json(!busy); }
        return Response.json(true);
      }
      if (p.startsWith("push_chat_mirror?")) {
        assert.equal(claimed, true, "拿到租约后才读聊天");
        return Response.json([{ id: "new", role: "assistant", content: "我刚刚已经告诉你展览时间了", message_at: "2026-09-17T01:00:01Z" }]);
      }
      return rest(p, init);
    };
    const svc = new WakeService(h.deps, async body => {
      if (body.action === "events") return { events: [EVENT], sources: [] };
      acks++; assert.equal(claimed, true); return { acceptedIds: [EVENT.id] };
    });
    assert.equal(await svc.poll(), 0);
    assert.equal(acks, 0); assert.equal(h.requests.length, 0);
    busy = false;
    assert.equal(await svc.poll(), 1);
    assert.equal(acks, 1);
    assert.match(JSON.stringify(h.requests[0]), /我刚刚已经告诉你展览时间了/);
  } finally { h.store.close(); }
});

test("多轮工具过程中租约失效，不继续执行 MCP 或投递正文", async () => {
  const h = harness([{ choices: [{ message: { content: "我看看", tool_calls: [{ id: "c1", type: "function", function: { name: "garden_look_ab12", arguments: "{}" } }] } }] }]);
  try {
    const rest = h.deps.rest; let renews = 0, releases = 0;
    h.deps.rest = async (p, init) => {
      if (p === "rpc/push_generation_lease") {
        const action = JSON.parse(String(init?.body)).p_action;
        if (action === "release") releases++;
        return Response.json(!(action === "renew" && ++renews >= 3));
      }
      return rest(p, init);
    };
    await assert.rejects(runWake(h.deps, template("openai-compatible", "native"), EVENT), /租约已失效/);
    assert.equal(h.mcpCalls.length, 0); assert.equal(h.outbox.length, 0); assert.equal(releases, 1);
  } finally { h.store.close(); }
});
