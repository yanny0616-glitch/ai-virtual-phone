// 唤醒后端端到端：真事件网关（tools/tool-events，临时目录）+ 真后端 HTTP（内存库）+ 本机 HTTP 假 MCP（SSE 回包）+ 假模型。
// 链路：Webhook 投递事件 → 网关排队（mode=server，手机领不到）→ 手机经 HTTPS 接口寄底稿 → 后端领取、ack、
//       调模型 → 模型要工具 → 经 MCP 调 → 再调模型 → 写 push_outbox + 推送 → 小手机补收时把事件原文和动作落进聊天。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import vm from "node:vm";

import { Auth } from "../companion-server/src/auth.ts";
import { Runner } from "../companion-server/src/runner.ts";
import { createApp } from "../companion-server/src/server.ts";
import { Store } from "../companion-server/src/store.ts";
import { localGateway, WakeService } from "../companion-server/src/wake.ts";
import { startService } from "../tools/tool-events/service.mjs";

const dir = await mkdtemp(`${tmpdir()}/wake-server-check-`);
const closers = [];
try {
  // ─── 事件网关
  await writeFile(`${dir}/backend-token`, "gateway-secret");
  const gateway = await startService({ dir: `${dir}/state`, port: 0, secretPath: `${dir}/backend-token`, gardenFactory: async () => { throw new Error("不该连花园"); } });
  closers.push(() => gateway.shutdown());
  const GW = `http://127.0.0.1:${gateway.server.address().port}`;
  const gw = localGateway(GW, `${dir}/backend-token`);
  await gw({ action: "save", adapter: "webhook", serverId: "mcp_forum", serverUrl: "https://forum.example/mcp", characterId: "char1", mode: "server" });
  const ingress = (await gw({ action: "credentials", serverId: "mcp_forum" })).ingressToken;
  await gw({ action: "start", serverId: "mcp_forum" });
  const deliver = async eventId => {
    const r = await fetch(GW, { method: "POST", headers: { Authorization: `Bearer ${ingress}` }, body: JSON.stringify({ action: "ingest", version: 1, sourceId: "mcp_forum", eventId, reason: "notification", message: "论坛有新回复，用 MCP 看看" }) });
    assert.equal(r.status, 200);
  };
  await deliver("evt-1");
  assert.equal((await gw({ action: "events" })).events.length, 0, "交给后端的事件手机领不到");
  assert.equal((await gw({ action: "events", mode: "server" })).events.length, 1);

  // ─── 假 MCP：真 HTTP，工具结果用 SSE 回
  const mcpSeen = [];
  const mcp = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const msg = JSON.parse(raw);
    mcpSeen.push({ method: msg.method, auth: req.headers.authorization, session: req.headers["mcp-session-id"], params: msg.params });
    if (msg.method === "initialize") { res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "sess-mcp" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } })); }
    if (!("id" in msg)) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "小林回复：周末一起去看展吗" }] } })}\n\n`);
  });
  await new Promise(r => mcp.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise(r => mcp.close(r)));
  const MCP = `http://127.0.0.1:${mcp.address().port}/mcp`;

  // ─── 后端
  const KEY = "sb_secret_test";
  const store = new Store(":memory:");
  const outbox = [], pushes = [], modelBodies = [];
  const rest = async (p, init) => {
    if (p === "rpc/push_generation_lease") return Response.json(true);
    if (p.startsWith("push_outbox") && init?.method === "POST") { outbox.push(...JSON.parse(init.body)); return new Response("", { status: 201 }); }
    return new Response("[]", { status: 200 });
  };
  const replies = [
    { choices: [{ message: { content: "我看看", tool_calls: [{ id: "c1", type: "function", function: { name: "forum_read_x1", arguments: "{\"thread\":\"t9\"}" } }] } }] },
    { choices: [{ message: { content: "小林约我周末看展\n\n你要不要一起" } }] },
  ];
  const wakeDeps = {
    store, rest, userId: "u1", now: () => Date.now(), log: () => undefined,
    fetchModel: async (_u, init) => { modelBodies.push(JSON.parse(init.body)); return new Response(JSON.stringify(replies.shift()), { status: 200 }); },
    // 底稿里的 MCP 地址必须是 https；测试把它转到本机 HTTP
    fetchMcp: (_u, init) => fetch(MCP, init),
    push: async messages => { pushes.push(...messages); return { sent: messages.length, total: 1, removed: 0, skippedShell: 0, errors: [] }; },
  };
  const wake = new WakeService(wakeDeps, gw);
  const engine = { store, rest, userId: "u1", fetchModel: wakeDeps.fetchModel, push: wakeDeps.push, now: () => Date.now(), random: () => 0.5, log: () => undefined };
  const server = createApp({ rest, store, userId: "u1", auth: new Auth("admin", async k => k === KEY), startedAt: new Date(), runner: new Runner(engine, "shadow"), engine, wake });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise(r => server.close(r)));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const api = async (p, init = {}) => {
    const r = await fetch(BASE + p, { ...init, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" } });
    return { status: r.status, body: await r.json() };
  };

  // 没底稿：事件留在网关
  assert.equal(await wake.poll(), 0);
  assert.equal((await gw({ action: "events", mode: "server" })).events.length, 1, "没底稿不领");
  assert.equal((await api("/app/wake/status?source=mcp_forum")).body.runs[0].status, "waiting");

  // 手机寄底稿（形状与 lib/wake-server-sync buildWakeTemplate 一致）
  const PH = "__FLOAT_WAKE_EVENT__";
  const template = {
    sourceId: "mcp_forum", characterId: "char1", sessionId: "session-char1", capturedAt: Date.now(),
    request: { url: "https://model.example/v1/chat/completions", headers: { Authorization: "Bearer model-key" }, providerKind: "openai-compatible",
      body: { model: "m", stream: true, messages: [{ role: "system", content: "你是沈烬言" }, { role: "user", content: "晚安" }, { role: "assistant", content: "晚安" }, { role: "user", content: PH }],
        tools: [{ type: "function", function: { name: "forum_read_x1", description: "读帖子", parameters: { type: "object", properties: { thread: { type: "string" } } } } }] } },
    placeholder: PH, protocol: "native", toolNames: { forum_read_x1: "read_thread" }, schemaText: {},
    mcp: { url: "https://forum.example/mcp", headers: { Authorization: "Bearer mcp-token" } }, maxRounds: 5,
    merge: { sessionId: "session-char1", characterName: "沈烬言", userName: "我", appId: "chat", appTags: ["chat", "text"], regexes: [], onlineThinking: { enabled: false, tag: "thinking" }, tzOffsetMin: 480 },
    notify: { title: "沈烬言", url: "/" },
  };
  assert.equal((await fetch(BASE + "/app/wake/templates/mcp_forum", { method: "PUT", body: JSON.stringify(template) })).status, 401, "没钥匙寄不进去");
  assert.equal((await api("/app/wake/templates/mcp_forum", { method: "PUT", body: JSON.stringify(template) })).status, 200);

  // 后端领取 → 调模型 → MCP → 回复
  assert.equal(await wake.poll(), 1);
  assert.equal((await gw({ action: "events", mode: "server" })).events.length, 0, "领走后网关清掉");
  assert.equal(modelBodies.length, 2);
  assert.equal(modelBodies[0].messages.at(-1).content, "论坛有新回复，用 MCP 看看");
  assert.equal(modelBodies[1].messages.at(-1).role, "tool");
  assert.match(modelBodies[1].messages.at(-1).content, /<action_result name="read_thread" success="true">\n小林回复/);
  assert.deepEqual(mcpSeen.map(m => m.method), ["initialize", "notifications/initialized", "tools/call"]);
  assert.equal(mcpSeen[2].auth, "Bearer mcp-token");
  assert.equal(mcpSeen[2].session, "sess-mcp");
  assert.deepEqual(mcpSeen[2].params, { name: "read_thread", arguments: { thread: "t9" } });
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].raw_text, "我看看\n\n小林约我周末看展\n\n你要不要一起");
  assert.equal(pushes.length, 3);
  const status = await api("/app/wake/status?source=mcp_forum");
  assert.equal(status.body.runs[0].status, "sent");
  assert.equal(status.body.templates[0].protocol, "native");
  assert.equal(status.body.gateway.sources[0].mode, "server");
  assert.ok(!JSON.stringify(status.body).includes("mcp-token") && !JSON.stringify(status.body).includes("model-key"), "状态接口不带密钥");
  console.log("PASS 网关分流 → 寄底稿 → 后端领取 ack → 模型 → MCP(SSE) → 模型 → outbox + 推送");

  // 重复投递同一 eventId 不会再处理
  await deliver("evt-1");
  assert.equal(await wake.poll(), 0);

  // ─── 小手机补收：事件原文 + 动作记录落进聊天（抽出 push-outbox-client 里的 importWakeToolEvent 在 vm 跑）
  const saved = [];
  let src = fs.readFileSync("lib/push-outbox-client.ts", "utf8");
  src = src.slice(src.indexOf("/** 唤醒后端处理过的事件"), src.indexOf("let consuming = false;"));
  const ctx = vm.createContext({ Date, Number, String, JSON, upsertImportedChatMessageAsync: async (msg, opts) => { assert.equal(opts.insertByCreatedAt, true); const i = saved.findIndex(m => m.id === msg.id); if (i >= 0) saved[i] = msg; else saved.push(msg); } });
  vm.runInContext(stripTypeScriptTypes(src) + ";globalThis.importWakeToolEvent = importWakeToolEvent;", ctx);
  await ctx.importWakeToolEvent("session-char1", outbox[0].meta.toolEvent);
  await ctx.importWakeToolEvent("session-char1", outbox[0].meta.toolEvent);
  assert.equal(saved.length, 4, "重收不重复");
  assert.deepEqual(saved.map(m => [m.role, m.mediaType || ""]), [["user", ""], ["assistant", "tool_call"], ["tool", "tool_result"], ["system", "tool_notice"]]);
  assert.equal(saved[0].id, outbox[0].meta.toolEvent.messageId);
  assert.equal(saved[0].content, "论坛有新回复，用 MCP 看看");
  assert.equal(saved[1].content, "[执行动作:read_thread({\"thread\":\"t9\"})]");
  assert.match(saved[2].content, /^以下是系统处理结果：\n<action_result name="read_thread">小林回复/);
  assert.ok(Date.parse(saved[3].createdAt) > Date.parse(saved[0].createdAt));
  console.log("PASS 小手机补收：事件原文、tool_call / tool_result / 灰条按顺序落库，重收幂等");

  // ─── 模型失败：事件原文和原因照样寄回
  await deliver("evt-2");
  wakeDeps.fetchModel = async () => new Response("boom", { status: 500 });
  assert.equal(await wake.poll(), 1);
  assert.equal(outbox.length, 2);
  assert.match(outbox[1].meta.toolEvent.error, /模型 HTTP 500/);
  saved.length = 0;
  await ctx.importWakeToolEvent("session-char1", outbox[1].meta.toolEvent);
  assert.equal(saved.at(-1).mediaType, "tool_notice");
  assert.match(saved.at(-1).content, /唤醒后端处理失败/);
  console.log("PASS 后端处理失败：不丢事件，原文和失败原因寄回聊天");

  // ─── 改回手机处理：后端领不到了
  await gw({ action: "save", adapter: "webhook", serverId: "mcp_forum", serverUrl: "https://forum.example/mcp", characterId: "char1", mode: "auto" });
  await gw({ action: "start", serverId: "mcp_forum" });
  await deliver("evt-3");
  assert.equal(await wake.poll(), 0);
  assert.equal((await gw({ action: "events" })).events.length, 1);
  console.log("PASS 来源改回手机处理后，后端不再领取");
} finally {
  for (const close of closers.reverse()) await close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
}
