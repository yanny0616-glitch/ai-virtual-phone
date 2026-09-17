import assert from "node:assert/strict";
import test from "node:test";

import { sendPushToUser } from "../src/push.ts";
import type { Rest } from "../src/supabase.ts";

function fakeRest(subs: { endpoint: string }[]) {
  const calls: { path: string; method: string }[] = [];
  const rest: Rest = async (path, init = {}) => {
    calls.push({ path, method: init.method || "GET" });
    if (path.startsWith("push_server_config")) {
      return Response.json([{ vapid_public_key: "pub", vapid_private_key: "priv", site_origin: "https://float.example" }]);
    }
    if (path.startsWith("push_subscriptions?user_id")) {
      return Response.json(subs.map(s => ({ ...s, user_id: "u1", p256dh: "p", auth: "a" })));
    }
    return new Response(null, { status: 204 });
  };
  return { rest, calls };
}

test("成功、失效、安卓壳、其他错误分别计数，失效订阅被删除", async () => {
  const { rest, calls } = fakeRest([
    { endpoint: "https://push.example/ok" },
    { endpoint: "https://push.example/gone" },
    { endpoint: "shell:u1" },
    { endpoint: "https://push.example/boom" },
  ]);
  const sent: string[] = [];
  const result = await sendPushToUser(rest, "u1", { title: "t", body: "b" }, async (sub, payload, options) => {
    sent.push(sub.endpoint);
    assert.equal(JSON.parse(payload).title, "t");
    assert.equal(options.vapidDetails?.subject, "https://float.example");
    if (sub.endpoint.endsWith("/gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
    if (sub.endpoint.endsWith("/boom")) throw Object.assign(new Error("boom"), { statusCode: 500 });
    return { statusCode: 201 };
  });

  assert.deepEqual(result, { sent: 1, total: 4, removed: 1, skippedShell: 1, errors: ["http 500"] });
  assert.ok(!sent.includes("shell:u1"));
  assert.ok(calls.some(c => c.method === "DELETE" && c.path.includes(encodeURIComponent("https://push.example/gone"))));
  assert.ok(!calls.some(c => c.method === "DELETE" && c.path.includes("boom")));
});

test("安卓壳订阅：接了个人云时发 Realtime 广播，来电带 kind=call", async () => {
  const { rest } = fakeRest([{ endpoint: "shell:u1" }]);
  const { sendPushMessages } = await import("../src/push.ts");
  const broadcasts: any[] = [];
  const cloud = async (path: string, init: RequestInit = {}) => { broadcasts.push({ path, body: JSON.parse(String(init.body)) }); return new Response("", { status: 202 }); };
  const result = await sendPushMessages(rest, "u1", [{ type: "incoming_call", title: "📞 赵兖", body: "来电话了…", url: "/?ring=s1", sessionId: "s1", callTs: 5 }], async () => { throw new Error("不该走 Web Push"); }, 0, cloud);
  assert.equal(result.sent, 1);
  assert.equal(result.skippedShell, 0);
  assert.equal(broadcasts[0].path, "realtime/v1/api/broadcast");
  assert.deepEqual(broadcasts[0].body.messages[0], { topic: "shellpush:u1", event: "notify", payload: { title: "📞 赵兖", body: "来电话了…", url: "/?ring=s1", kind: "call", characterName: "赵兖", sessionId: "s1", callTs: 5 } });
});
