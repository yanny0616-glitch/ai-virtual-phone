import assert from "node:assert/strict";
import test from "node:test";
import { encryptPayload } from "../src/crypto.ts";
import { stopLegacyScheduler } from "../src/handoff.ts";

async function setup(count = 1) {
  const key = "test-key";
  const plans = [{ session_id: "s1", context: { owner: "device", recheckEnabled: 1, genKit: {}, genEnabled: 1 }, items: [] }];
  const payload = await encryptPayload(JSON.stringify({ notify: { characterId: "c1" }, merge: { sessionId: "s1" } }), key);
  const otherPayload = await encryptPayload(JSON.stringify({ notify: { characterId: "other" }, merge: { sessionId: "s2" } }), key);
  const jobs = Array.from({length: count}, (_, i) => ({ id: String(i).padStart(4, "0"), trigger_key: `timedwake:timed_wake_capp_app_gua.nian_${i}`, status: "pending", updated_at: "old", payload }));
  jobs.push({ id: "other", trigger_key: "timedwake:timed_wake_capp_app_gua.nian_other", status: "pending", updated_at: "old", payload: otherPayload });
  const calls: {path: string; init: RequestInit}[] = [];
  let conflict = false, failVerify = false;
  const rest = async (path: string, init: RequestInit = {}) => {
    calls.push({ path, init });
    const q = new URLSearchParams(path.split("?")[1]);
    if (path.startsWith("rpc/")) {
      const args = JSON.parse(String(init.body));
      assert.equal(args.p_user_id, "u1"); assert.equal(args.p_character_id, "c1");
      if (args.p_owner !== "device") return Response.json(-1);
      if (path.endsWith("set_enabled")) plans[0].context.recheckEnabled = 0;
      else plans[0].context.genEnabled = 0;
      return Response.json(1);
    }
    if (path.startsWith("push_recheck_plans?")) return failVerify && q.get("select")?.startsWith("context,") ? new Response("error", {status:503}) : Response.json(plans);
    if (path.startsWith("push_server_config?")) return Response.json([{payload_key:key}]);
    if (path.startsWith("push_outbox?")) return Response.json([]);
    if (init.method === "PATCH") {
      assert.equal(q.get("status"), "eq.pending"); assert.equal(q.get("updated_at"), "eq.old");
      const job = jobs.find(j => "eq." + j.id === q.get("id"))!;
      if (conflict) { job.status = "running"; return Response.json([]); }
      Object.assign(job, JSON.parse(String(init.body)));return Response.json([job]);
    }
    assert.ok(path.startsWith("push_jobs?"));
    const offset = Number(q.get("offset"));
    return Response.json(jobs.filter(j=>["pending","running"].includes(j.status)).slice(offset,offset+200));
  };
  return { rest, plans, jobs, calls, key, conflict: () => { conflict=true; }, failVerify: () => {failVerify=true;} };
}

test("交接停复核/生成，分页撤销全部挂念预约，保留其他角色及正文凭据", async () => {
  const e = await setup(205);
  await stopLegacyScheduler(e.rest,"u1","c1","device");
  assert.equal(e.jobs.filter(j=>j.status === "cancelled").length,205);
  assert.equal(e.jobs.at(-1)!.status,"pending");
  assert.equal(e.plans[0].context.recheckEnabled,0);assert.equal(e.plans[0].context.genEnabled,0);
  assert.equal(e.calls.filter(c=>c.init.method === "DELETE").length,0);
  assert.ok(e.calls.find(c=>c.path.includes("offset=200")));
});

test("执行中、暂存成文、其他设备、并发领取、最终读取失败均不确认交接", async () => {
  for (const mode of ["running","generated","owner","claim","verify"]) {
    const e = await setup();
    if (mode === "running") e.jobs[0].status="running";
    if (mode === "generated") e.jobs[0].payload=await encryptPayload(JSON.stringify({notify:{characterId:"c1"},generatedResponse:{rawText:"已成文"}}),e.key);
    if (mode === "claim") e.conflict();
    if (mode === "verify") e.failVerify();
    await assert.rejects(stopLegacyScheduler(e.rest,"u1","c1",mode === "owner" ? "another" : "device"));
    if (["running","generated","owner"].includes(mode)) assert.equal(e.calls.filter(c=>c.init.method === "PATCH").length,0);
  }
});

test("已建档角色走真实 handoff 路由：旧任务撤销后补入缺失定时器，再确认成功", async () => {
  const { Store } = await import("../src/store.ts");
  const { Runner } = await import("../src/runner.ts");
  const { handleApp } = await import("../src/api.ts");
  const e=await setup();const store=new Store(":memory:");
  try {
    store.saveCharacter({characterId:"c1",sessionId:"s1",name:"已建档",enabled:true,settings:{tzOffsetMin:480,quota:7},state:{threads:[]},importedAt:1,updatedAt:1});
    store.setMeta("handoff:c1", "done"); // 旧版确认过交接，但没做增量补迁
    const wakeId=e.jobs[0].trigger_key.slice("timedwake:".length);
    Object.assign(e.plans[0],{character_id:"c1",plan_date:"2026-09-17",items:[{wakeId,act:true,kind:"extra",fireAt:Date.now()+3600000,time:"18:00",intent:"旧云端新加的消息",source:"云端",why:"",sem:"",topic:""}]});
    const rest: typeof e.rest=async(path,init)=>path.includes("select=trigger_key,status,result_note")
      ? Response.json(e.jobs.filter(j=>j.trigger_key==='timedwake:'+wakeId)) : e.rest(path,init);
    const engine={store,rest,userId:"u1",now:Date.now,random:()=>.5,log:()=>{},fetchModel:async()=>{throw Error("不应调模型");},push:async()=>({total:0,sent:0,removed:0,skippedShell:0,errors:[]})};
    const runner=new Runner(engine,"shadow");
    const before=await handleApp({store,runner,engine},"GET","/app/state",new URLSearchParams("ids=c1"),async()=>({}));
    assert.equal((before!.body as {characters:{legacyStopped:boolean}[]}).characters[0].legacyStopped,false);
    const r=await handleApp({store,runner,engine},"POST","/app/characters/c1/handoff",new URLSearchParams(),async()=>({owner:"device"}));
    assert.equal(r!.status,200);assert.equal((r!.body as {stopped:boolean}).stopped,true);
    assert.equal(e.jobs[0].status,"cancelled");assert.equal(store.getTimer(wakeId)!.status,"pending");
    assert.equal(store.getCharacter("c1")!.enabled,false);assert.equal(store.getCharacter("c1")!.settings.quota,7);
    assert.equal(store.getMeta("handoff:c1"),"done");
    assert.equal(store.getMeta("handoff-tasks:c1"),"done");
  } finally {store.close();}
});
