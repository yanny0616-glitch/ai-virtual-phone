import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "../src/store.ts";
import { importPendingCloudFeedback } from "../src/importer.ts";
import { tickCharacter, type EngineDeps } from "../src/engine.ts";

const at = (s: string) => Date.parse(s + "Z");
function setup() {
  const store = new Store(":memory:");
  let now = at("2026-09-17T08:00:00"), fail = false;
  store.saveCharacter({ characterId: "c", sessionId: "s", name: "TA", enabled: true, importedAt: now, updatedAt: now,
    settings: { tzOffsetMin: 0, genEnabled: 0, selfImpulseCap: 0, userSleepOn: 1, userSleepStart: "22:00", userSleepEnd: "07:00", userSleepTz: 0 },
    state: { fb: { quiet: [5, 2] }, fbSeen: [], threads: [] } });
  const item = (wakeId: string) => ({ wakeId, act: true, kind: "quiet", from: "", fireAt: at("2026-09-16T21:00:00") });
  const plans = [
    { character_id: "c", session_id: "s", plan_date: "2026-09-17", context: { fbSeen: ["settled"] }, items: [] },
    { character_id: "c", session_id: "s", plan_date: "2026-09-16", context: { fbSeen: [] }, items: ["pending", "settled", "skipped", "fake", "cancelled"].map(item) },
  ];
  const rest: EngineDeps["rest"] = async (path, init) => {
    if (path.startsWith("push_recheck_plans?")) return Response.json(plans);
    if (path.startsWith("push_jobs?")) return Response.json([
      { trigger_key: "timedwake:pending", status: "done", result_note: "generated", updated_at: "2026-09-16T22:30:00Z" },
      { trigger_key: "timedwake:skipped", status: "done", result_note: "guanian skip", updated_at: "2026-09-16T22:30:00Z" },
      { trigger_key: "timedwake:cancelled", status: "cancelled", result_note: "cancelled", updated_at: "2026-09-16T22:30:00Z" },
    ]);
    if (path.includes("select=id,trigger_key,created_at,session_id")) {
      if (fail) return new Response("down", { status: 503 });
      return Response.json([{ id: "out_old", trigger_key: "timedwake:pending", session_id: "s", created_at: "2026-09-16T22:30:00Z" }]);
    }
    if (path.includes("role=eq.user")) return Response.json([{ message_at: "2026-09-17T08:30:00Z" }]);
    if (init?.method === "POST") return Response.json(true);
    return Response.json([]);
  };
  const deps: EngineDeps = { store, rest, userId: "u", now: () => now, random: () => 0.99, log: () => {},
    fetchModel: async () => { throw new Error("不应生成"); }, push: async () => { throw new Error("不应推送"); } };
  return { store, rest, deps, plans, time: (s: string) => { now = at(s); }, fail: (v: boolean) => { fail = v; } };
}

test("补迁跨日尾账：保留累计数、实际发送时间；旧 fbSeen/作罢/取消/无凭据不补", async () => {
  const e = setup();
  try {
    assert.equal(await importPendingCloudFeedback(e.rest, e.store, "u", "c", e.deps.now()), 1);
    assert.deepEqual(e.store.getCharacter("c")!.state.fb, { quiet: [5, 2] });
    const rows = e.store.pendingFeedback("c");
    assert.deepEqual(rows.map(r => [r.wakeId, r.sentAt, r.outboxId]), [["pending", at("2026-09-16T22:30:00"), "out_old"]]);
    e.time("2026-09-17T09:59:00"); await tickCharacter(e.deps, "live", "c");
    assert.equal(e.store.pendingFeedback("c").length, 1, "睡眠不计入三小时等待");
    e.time("2026-09-17T10:01:00"); await tickCharacter(e.deps, "live", "c");
    assert.equal(e.store.pendingFeedback("c").length, 0);
    assert.deepEqual(e.store.getCharacter("c")!.state.fb, { quiet: [6, 3] });
    // 即使交接标记没来得及写下，重跑补迁也不能把 fb_done 清掉。
    e.store.setMeta("handoff-feedback:c", "pending");
    await importPendingCloudFeedback(e.rest, e.store, "u", "c", e.deps.now());
    await tickCharacter(e.deps, "live", "c");
    assert.equal(e.store.pendingFeedback("c").length, 0);
    assert.deepEqual(e.store.getCharacter("c")!.state.fb, { quiet: [6, 3] });
  } finally { e.store.close(); }
});

test("旧交接角色无需再打开挂念，下一轮自动补尾账；读失败不拖停这一轮、不确认迁完，恢复后可重试", async () => {
  const e = setup();
  try {
    e.store.setMeta("handoff:c", "done");
    e.fail(true);
    const failed = await tickCharacter(e.deps, "live", "c");
    // 补迁失败只记一步，不拖停这一轮
    assert.ok(failed.steps.some(s => /回音账补迁失败.*503/.test(s)), failed.steps.join("\n"));
    assert.equal(e.store.getMeta("handoff-feedback:c"), null);
    assert.equal(e.store.pendingFeedback("c").length, 0);
    e.fail(false);
    const success = await tickCharacter(e.deps, "live", "c");
    assert.equal(success.error, undefined);
    assert.equal(e.store.getMeta("handoff-feedback:c"), "done");
    assert.equal(e.store.pendingFeedback("c").length, 1);
  } finally { e.store.close(); }
});

test("结算总数与 fb_done 原子提交，落盘失败重试不丢账，重复结算不加两次", () => {
  const e = setup();
  try {
    e.store.addSend({ wakeId: "w", characterId: "c", date: "2026-09-16", kind: "quiet", fromId: "", sentAt: 1000, outboxId: "out" });
    const save = e.store.saveCharacter.bind(e.store);
    e.store.saveCharacter = () => { throw new Error("disk failed"); };
    assert.throws(() => e.store.settleFeedback("w", "c", "quiet", true), /disk failed/);
    assert.equal(e.store.pendingFeedback("c").length, 1);
    assert.deepEqual(e.store.getCharacter("c")!.state.fb, { quiet: [5, 2] });
    e.store.saveCharacter = save;
    e.store.settleFeedback("w", "c", "quiet", true);
    e.store.settleFeedback("w", "c", "quiet", true);
    assert.deepEqual(e.store.getCharacter("c")!.state.fb, { quiet: [6, 3] });
  } finally { e.store.close(); }
});
