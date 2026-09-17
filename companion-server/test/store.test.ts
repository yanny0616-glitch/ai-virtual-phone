import assert from "node:assert/strict";
import test from "node:test";

import { Store, validateSnapshot, type Snapshot } from "../src/store.ts";

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  characterId: "c1",
  purpose: "chat",
  sessionId: "s1",
  capturedAt: Date.parse("2026-09-16T10:00:00.000Z"),
  request: { url: "https://api.example.com/v1/chat/completions", headers: { Authorization: "Bearer secret" }, body: { messages: [] }, providerKind: "openai-compatible" },
  notify: { title: "TA", url: "/" },
  merge: { characterName: "TA", userName: "你", appId: "chat", appTags: ["chat", "text"] },
  ...over,
});

test("validateSnapshot 接受完整快照", () => {
  assert.equal(validateSnapshot(snapshot()), null);
});

test("validateSnapshot 拒绝缺字段和非法值", () => {
  assert.match(validateSnapshot(null)!, /不是对象/);
  assert.match(validateSnapshot({ ...snapshot(), purpose: "x" })!, /purpose/);
  assert.match(validateSnapshot({ ...snapshot(), capturedAt: Number.NaN })!, /capturedAt/);
  assert.match(validateSnapshot(snapshot({ request: { ...snapshot().request, url: "ftp://x" } }))!, /url/);
  assert.match(validateSnapshot(snapshot({ request: { ...snapshot().request, providerKind: "x" as never } }))!, /providerKind/);
});

test("每个角色每种用途只留最新快照，列表不含请求内容", () => {
  const store = new Store(":memory:");
  store.saveSnapshot(snapshot(), new Date("2026-09-16T10:00:00Z"));
  store.saveSnapshot(snapshot({ capturedAt: 2 }), new Date("2026-09-16T11:00:01Z"));
  store.saveSnapshot(snapshot({ purpose: "judge" }), new Date("2026-09-16T09:30:00Z"));
  store.saveSnapshot(snapshot({ characterId: "c2" }), new Date("2026-09-16T09:00:00Z"));

  assert.equal(store.getSnapshot("c1", "chat")?.capturedAt, 2);
  assert.equal(store.getSnapshot("c1", "daily"), null);
  const list = store.listSnapshots();
  assert.equal(list.length, 3);
  assert.ok(!JSON.stringify(list).includes("secret"));
  store.close();
});

test("定时器到点查询与影子定时器清理", () => {
  const store = new Store(":memory:");
  store.addTimer({ id: "srv_a", characterId: "c1", date: "2026-09-16", fireAt: 100, kind: "extra", status: "pending", note: "" });
  store.addTimer({ id: "srv_b", characterId: "c1", date: "2026-09-16", fireAt: 500, kind: "extra", status: "pending", note: "" });
  store.addTimer({ id: "srv_c", characterId: "c1", date: "2026-09-16", fireAt: 50, kind: "promise", status: "shadow", note: "" });
  store.addTimer({ id: "keep", characterId: "c1", date: "2026-09-16", fireAt: 50, kind: "extra", status: "done", note: "" });
  assert.deepEqual(store.dueTimers(200, "c1").map(t => t.id), ["srv_a"]);
  store.updateTimer("srv_a", { fireAt: 300 });
  assert.deepEqual(store.dueTimers(200, "c1"), []);
  assert.equal(store.clearShadowTimers("c1"), 3);
  assert.ok(store.getTimer("keep"));
  store.close();
});
