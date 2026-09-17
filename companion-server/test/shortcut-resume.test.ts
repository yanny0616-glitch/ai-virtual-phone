import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type ShortcutResume } from "../src/store.ts";
import { runShortcutResumes } from "../src/shortcut-resume.ts";
import type { EngineDeps } from "../src/engine.ts";

function setup(path = ":memory:") {
  const store = new Store(path);
  let now = Date.parse("2026-09-16T08:01:00Z");
  const calls: { path: string; init?: RequestInit }[] = [];
  const requests: string[] = [], outputs: any[] = [], pushes: any[] = [];
  const state = { failWrites: false, loseResponse: false, halt: false, capped: false, loseLease: false };
  store.saveCharacter({ characterId: "c", sessionId: "s", name: "TA", enabled: true, settings: { tzOffsetMin: 480 }, state: {}, importedAt: 0, updatedAt: 0 });
  const row: ShortcutResume = { commandId: "cmd", characterId: "c", sessionId: "s", dueAt: now, tries: 0, outboxId: "out_resume",
    request: { url: "https://model.test", headers: {}, providerKind: "anthropic", body: { model: "m", messages: [{ role: "user", content: "当前系统时间：2026年9月1日08:00，星期二" }, { role: "user", content: "__RESULT__" }] } },
    resultMarker: "__RESULT__", actionName: "查天气", notify: { title: "TA", url: "/" }, merge: { tzOffsetMin: 480 } };
  store.saveResume(row);
  const deps: EngineDeps = {
    store, userId: "u", now: () => now, random: () => 0.99, log: () => {}, halted: () => state.halt,
    rest: async (path, init) => {
      calls.push({ path, init });
      if (path === "rpc/push_generation_lease") return Response.json(!(state.loseLease && JSON.parse(String(init?.body)).p_action === "renew"));
      if (path.startsWith("push_outbox?")) {
        const id = new URLSearchParams(path.split("?")[1]).get("id")?.slice(3);
        return Response.json(id ? outputs.filter(o => o.id === id) : outputs);
      }
      if (path === "push_outbox") {
        if (state.failWrites) return new Response("down", { status: 503 });
        outputs.push(...JSON.parse(String(init?.body)));
        if (state.loseResponse) { state.loseResponse = false; throw new Error("committed but response lost"); }
        return new Response(null, { status: 201 });
      }
      if (path.startsWith("push_chat_mirror?")) return Response.json([{ id: "new", role: "user", content: "刚取消出门了，不用提醒带伞", message_at: "2026-09-16T08:00:30Z" }]);
      if (path.startsWith("push_shortcut_commands?")) return Response.json([{ id: "cmd", status: "succeeded", action_name: "查天气", result_mode: "text", result: { text: "晴天26度" }, error: null, expires_at: "2026-09-16T08:05:00Z" }]);
      if (state.capped && path.startsWith("push_api_limits?")) return Response.json([{ daily_calls: 1 }]);
      if (state.capped && path.startsWith("push_api_usage?")) return Response.json([{ calls: 1 }]);
      return Response.json([]);
    },
    fetchModel: async (_u, init) => { requests.push(String(init.body)); return Response.json({ content: [{ type: "text", text: `续跑正文${requests.length}` }], usage: { input_tokens: 1, output_tokens: 1 } }); },
    push: async list => { pushes.push(...list); return { sent: list.length, total: 1, removed: 0, skippedShell: 0, errors: [] }; },
  };
  return { deps, row, state, calls, requests, outputs, pushes, advance: (minutes = 6) => { now += minutes * 60_000; } };
}

test("取得租约后读取新聊天与 outbox，刷新旧模板时间，再代入动作结果", async () => {
  const e = setup();
  try {
    e.outputs.push({ id: "other", trigger_key: "wake:other", raw_text: "刚说完不用带伞", created_at: "2026-09-16T08:00:45Z", meta: { pushGenerated: true } });
    assert.equal(await runShortcutResumes(e.deps), 1);
    assert.match(e.requests[0], /刚取消出门了，不用提醒带伞/);
    assert.match(e.requests[0], /刚说完不用带伞/);
    assert.match(e.requests[0], /晴天26度/);
    assert.match(e.requests[0], /2026年9月16日16:01/);
    const claim = e.calls.findIndex(c => c.path === "rpc/push_generation_lease");
    assert.ok(e.calls.findIndex(c => c.path.startsWith("push_chat_mirror?")) > claim);
  } finally { e.deps.store.close(); }
});

test("续跑正文持久化：503 后重启、预算用尽，仍复用同一正文、ID、生成时间完成投递", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shortcut-resume-")), path = join(dir, "db");
  const e = setup(path);
  try {
    e.state.failWrites = true;
    assert.equal(await runShortcutResumes(e.deps), 0);
    const saved = e.deps.store.dueResumes(Infinity)[0].generated!;
    assert.equal(saved.rawText, "续跑正文1");
    e.deps.store.close(); e.deps.store = new Store(path);
    e.state.failWrites = false; e.state.capped = true; e.advance();
    assert.equal(await runShortcutResumes(e.deps), 1);
    assert.equal(e.requests.length, 1);
    assert.deepEqual([e.outputs[0].id, e.outputs[0].raw_text, e.outputs[0].created_at], ["out_resume", saved.rawText, saved.createdAt]);
    assert.equal(e.calls.filter(c => c.path === "rpc/ai_phone_usage_add").length, 1);
    assert.equal(e.deps.store.dueResumes(Infinity).length, 0);
  } finally { e.deps.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("续跑 POST 已提交但响应丢失：凭据恢复，不重复生成或入库", async () => {
  const e = setup();
  try {
    e.state.loseResponse = true;
    await runShortcutResumes(e.deps); e.advance();
    assert.equal(await runShortcutResumes(e.deps), 1);
    assert.equal(e.requests.length, 1); assert.equal(e.outputs.length, 1);
    assert.equal(e.deps.store.dueResumes(Infinity).length, 0);
  } finally { e.deps.store.close(); }
});

test("角色停用、会话变更、取消排队或预算满时不开始生成，也不消耗失败次数", async () => {
  for (const reason of ["disabled", "session", "halt", "budget"] as const) {
    const e = setup();
    try {
      const c = e.deps.store.getCharacter("c")!;
      if (reason === "disabled") c.enabled = false;
      if (reason === "session") c.sessionId = "new-session";
      if (reason === "halt") e.state.halt = true;
      if (reason === "budget") e.state.capped = true;
      e.deps.store.saveCharacter(c);
      assert.equal(await runShortcutResumes(e.deps), 0, reason);
      assert.equal(e.requests.length, 0, reason); assert.equal(e.outputs.length, 0, reason);
      assert.equal(e.deps.store.dueResumes(Infinity)[0].tries, 0, reason);
    } finally { e.deps.store.close(); }
  }
});

test("续跑生成中取消/失去租约：正文保留但不发送，恢复后不再次调模型", async () => {
  for (const reason of ["halt", "lease"] as const) {
    const e = setup();
    try {
      const model = e.deps.fetchModel;
      e.deps.fetchModel = async (u, init) => { const result = await model(u, init); if (reason === "halt") e.state.halt = true; else e.state.loseLease = true; return result; };
      await runShortcutResumes(e.deps);
      assert.equal(e.outputs.length, 0); assert.equal(e.pushes.length, 0);
      assert.ok(e.deps.store.dueResumes(Infinity)[0].generated);
      e.state.halt = false; e.state.loseLease = false; e.advance();
      await runShortcutResumes(e.deps);
      assert.equal(e.requests.length, 1); assert.equal(e.outputs.length, 1);
    } finally { e.deps.store.close(); }
  }
});

test("兼容旧续跑：父任务未投递快捷通知时先等待；投递确认后才执行", async () => {
  const e = setup();
  try {
    const draft = { wakeId: "w", userId: "u", sessionId: "s", outboxId: "first", createdAt: new Date(e.deps.now()).toISOString(), rawText: "等等", meta: {}, notify: { title: "TA", url: "/" },
      shortcutCommand: { id: "cmd", resultUrl: "https://example.test", actionId: "a", actionName: "查天气", args: {}, deliveryMode: "push" as const, resultMode: "text", expiresInSeconds: 900, continued: true } };
    e.deps.store.saveDraft(draft);
    await runShortcutResumes(e.deps);
    assert.equal(e.requests.length, 0);
    e.deps.store.updateDraft({ ...draft, shortcutDelivered: true }); e.advance();
    assert.equal(await runShortcutResumes(e.deps), 1);
  } finally { e.deps.store.close(); }
});
