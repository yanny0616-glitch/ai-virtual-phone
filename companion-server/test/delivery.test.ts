import assert from "node:assert/strict";
import test from "node:test";
import { deliverShortcutCommand, sendWeixin, type CloudCtx, type ShortcutCommand } from "../src/delivery.ts";
import { DeliveryPaused } from "../src/delivery-guard.ts";

const command: ShortcutCommand = { id: "cmd_test", resultUrl: "https://cloud.test/result", actionId: "a", actionName: "查天气", args: {}, deliveryMode: "email", resultMode: "text", expiresInSeconds: 120, continued: true };

test("微信读取凭据期间取消：守卫异常向上传递，不发送也不误判为可转投失败", async () => {
  let stopped = false, sends = 0;
  const c: CloudCtx = { userId: "u", key: "test", rest: async () => Response.json([]),
    cloud: async path => { if (path.startsWith("storage/")) { stopped = true; return Response.json({ token: "test" }); } sends++; return Response.json({ ok: true }); },
    beforeEffect: async () => { if (stopped) throw new DeliveryPaused("已取消"); } };
  await assert.rejects(sendWeixin(c, "bot", "消息"), DeliveryPaused);
  assert.equal(sends, 0);
});

test("邮件/推送读取配置期间取消：两种动作通知都在实际请求前复核", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ ok: true }); });
  for (const deliveryMode of ["email", "push"] as const) {
    let stopped = false;
    const c: CloudCtx = { userId: "u", key: "test",
      rest: async p => { stopped = true; return Response.json(p.startsWith("push_server_config") ? [{ site_origin: "https://site.test" }] : [{ site_bridge_token: "test" }]); },
      cloud: async () => { requests++; return Response.json({ ok: true, delivered: true }); },
      beforeEffect: async () => { if (stopped) throw new DeliveryPaused("已取消"); } };
    await assert.rejects(deliverShortcutCommand(c, { ...command, deliveryMode }), DeliveryPaused);
  }
  assert.equal(requests, 0);
});

test("微信明确拒绝可转投，超时/坏回执/5xx 保持结果不明", async () => {
  for (const [response, expected] of [
    [() => Response.json({ ok: false, error: "bot offline" }), "failed"],
    [() => new Response("forbidden", { status: 403 }), "failed"],
    [() => new Response("oops", { status: 500 }), "unknown"],
    [() => new Response("bad json"), "unknown"],
    [() => { throw new Error("timeout"); }, "unknown"],
  ] as const) {
    const c: CloudCtx = { userId: "u", key: "test", rest: async () => Response.json([]),
      cloud: async p => p.startsWith("storage/") ? Response.json({ token: "test" }) : response() };
    assert.equal((await sendWeixin(c, "bot", "消息")).status, expected);
  }
});
