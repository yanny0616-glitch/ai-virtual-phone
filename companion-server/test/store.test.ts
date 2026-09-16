import assert from "node:assert/strict";
import test from "node:test";

import { Store, validateSnapshot, type Snapshot } from "../src/store.ts";

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  characterId: "c1",
  sessionId: "s1",
  lastMessageId: "m9",
  lastMessageAt: "2026-09-16T10:00:00.000Z",
  request: { url: "https://api.example.com/v1/chat/completions", headers: { Authorization: "Bearer secret" }, body: { messages: [] }, providerKind: "openai-compatible" },
  reply: { characterName: "TA", userName: "你", appId: "chat", appTags: ["chat", "text"] },
  ...over,
});

test("validateSnapshot 接受完整快照", () => {
  assert.equal(validateSnapshot(snapshot()), null);
});

test("validateSnapshot 拒绝缺字段和非法值", () => {
  assert.match(validateSnapshot(null)!, /不是对象/);
  assert.match(validateSnapshot({ ...snapshot(), lastMessageId: "" })!, /lastMessageId/);
  assert.match(validateSnapshot({ ...snapshot(), lastMessageAt: "昨天" })!, /有效时间/);
  assert.match(validateSnapshot(snapshot({ request: { ...snapshot().request, url: "ftp://x" } }))!, /url/);
  assert.match(validateSnapshot(snapshot({ request: { ...snapshot().request, providerKind: "x" as never } }))!, /providerKind/);
});

test("每个角色只保留最新快照，列表不含请求内容", () => {
  const store = new Store(":memory:");
  store.saveSnapshot(snapshot(), new Date("2026-09-16T10:00:00Z"));
  store.saveSnapshot(snapshot({ lastMessageId: "m10", lastMessageAt: "2026-09-16T11:00:00.000Z" }), new Date("2026-09-16T11:00:01Z"));
  store.saveSnapshot(snapshot({ characterId: "c2" }), new Date("2026-09-16T09:00:00Z"));

  assert.equal(store.getSnapshot("c1")?.lastMessageId, "m10");
  const list = store.listSnapshots();
  assert.deepEqual(list.map(s => s.characterId), ["c1", "c2"]);
  assert.ok(!JSON.stringify(list).includes("secret"));
  store.close();
});
