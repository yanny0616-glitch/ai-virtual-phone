import assert from "node:assert/strict";
import test from "node:test";

import { encryptPayload } from "../src/crypto.ts";
import { Store } from "../src/store.ts";
import { fillChatTemplate, syncTemplates } from "../src/templates.ts";

const merge = { intentPlaceholder: "__GUANIAN_INTENT__", elapsedMark: 424242, tzOffsetMin: 480, template: true, sessionId: "s2" };

test("聊天模板填空：意图、多久前、系统时间和角色本地时间", () => {
  const request = {
    url: "https://x", headers: {}, providerKind: "anthropic" as const,
    body: { system: [{ type: "text", text: "当前系统时间：2026年9月14日08:21，星期一\n角色本地时间：2026年9月14日02:21 Europe/London，星期一" }],
      messages: [{ role: "user", content: [{ type: "text", text: "到了你之前打算主动找 宁妍 的时间点（约 424242 分钟前你这么决定的）——你当时想着：“__GUANIAN_INTENT__”。" }] }] },
  };
  const now = Date.parse("2026-09-17T08:05:00+08:00");
  const out = JSON.stringify(fillChatTemplate(request, merge, { intent: "问问\"到家没\"", elapsedMin: 42, nowMs: now }).body);
  assert.match(out, /当前系统时间：2026年9月17日08:05，星期四/);
  assert.match(out, /角色本地时间：2026年9月17日01:05 Europe\/London，星期四/);
  assert.match(out, /约 42 分钟前/);
  assert.ok(out.includes('问问\\"到家没\\"'));
  assert.ok(!out.includes("__GUANIAN_INTENT__"));
  assert.match(JSON.stringify(request.body), /__GUANIAN_INTENT__/);
});

test("取模板：只收挂念、认识的角色、更新过的；重复轮次不再解密", async () => {
  const store = new Store(":memory:");
  store.saveCharacter({ characterId: "c1", sessionId: "s1", name: "沈烬言", enabled: true, settings: { tzOffsetMin: 480 }, state: {}, importedAt: 0, updatedAt: 0 });
  const secret = "k";
  const payload = await encryptPayload(JSON.stringify({
    request: { url: "https://model", headers: {}, body: { messages: [] }, providerKind: "anthropic" },
    notify: { title: "沈烬言" }, merge: { ...merge, snapshotAt: "2026-09-17T00:00:00.000Z" },
  }), secret);
  let payloadReads = 0;
  const rest = async (path: string) => {
    if (path.startsWith("push_server_config")) return new Response(JSON.stringify([{ payload_key: secret }]));
    if (path.includes("select=trigger_key,updated_at")) return new Response(JSON.stringify([
      { trigger_key: "capptpl:app_gua.nian_01:c1:chat", updated_at: "2026-09-17T00:00:01Z" },
      { trigger_key: "capptpl:app_gua.nian_01:c1:impulse", updated_at: "2026-09-17T00:00:01Z" },
      { trigger_key: "capptpl:app_gua.nian_01:someone:judge", updated_at: "2026-09-17T00:00:01Z" },
    ]));
    payloadReads++;
    return new Response(JSON.stringify([{ payload, updated_at: "2026-09-17T00:00:01Z" }]));
  };
  assert.deepEqual(await syncTemplates(rest, store, "u"), ["沈烬言:chat"]);
  const snap = store.getSnapshot("c1", "chat")!;
  assert.equal(snap.capturedAt, Date.parse("2026-09-17T00:00:00.000Z"));
  assert.equal(store.getCharacter("c1")!.sessionId, "s2");
  assert.deepEqual(await syncTemplates(rest, store, "u"), []);
  assert.equal(payloadReads, 1);
  store.close();
});
