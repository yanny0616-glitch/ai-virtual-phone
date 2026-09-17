import assert from "node:assert/strict";
import test from "node:test";
import { acquireGenerationLease, GenerationBusy } from "../src/generation-lease.ts";
import type { Rest } from "../src/supabase.ts";

test("会话租约与旧执行器互斥，释放只使用自己的 token", async () => {
  const calls: Record<string, string>[] = [];
  let held = "old-cloud-job";
  const rest: Rest = async (_path, init) => {
    const p = JSON.parse(String(init?.body)); calls.push(p);
    if (p.p_action === "claim") {
      if (held) return Response.json(false);
      held = p.p_token;
    } else if (p.p_action === "renew") return Response.json(held === p.p_token);
    else if (held === p.p_token) held = "";
    return Response.json(true);
  };
  await assert.rejects(acquireGenerationLease(rest, "u", "s", "timer"), GenerationBusy);
  assert.equal(held, "old-cloud-job");
  held = "";
  const lease = await acquireGenerationLease(rest, "u", "s", "timer");
  const token = held;
  await assert.rejects(acquireGenerationLease(rest, "u", "s", "wake"), GenerationBusy);
  await lease.check();
  await lease.release();
  await lease.release();
  assert.equal(held, "");
  assert.deepEqual(calls.filter(c => c.p_action === "release").map(c => c.p_token), [token]);
});

test("长调用期间自动续租；续租失败后不能继续投递，释放后停止续租", async () => {
  let renews = 0, lost = false;
  const rest: Rest = async (_p, init) => {
    const { p_action } = JSON.parse(String(init?.body));
    if (p_action === "renew") { renews++; return Response.json(!lost); }
    return Response.json(true);
  };
  const lease = await acquireGenerationLease(rest, "u", "s", "long-tool", 5);
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(renews > 0);
    lost = true;
    await assert.rejects(lease.check(), /租约已失效/);
    await assert.rejects(lease.check(), /租约已失效/);
  } finally { await lease.release(); }
  const stoppedAt = renews;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(renews, stoppedAt);
});

test("租约接口报错或不返回布尔值时不能绕过互斥", async () => {
  await assert.rejects(acquireGenerationLease(async () => new Response("down", { status: 503 }), "u", "s", "timer"), /HTTP 503/);
  await assert.rejects(acquireGenerationLease(async () => Response.json([]), "u", "s", "timer"), /回执无效/);
});
