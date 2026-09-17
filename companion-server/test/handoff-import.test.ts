import assert from "node:assert/strict";
import test from "node:test";
import { Store, type DayRow } from "../src/store.ts";
import { importMissingCloudTasks } from "../src/importer.ts";
import { LEGACY_HANDOFF_NOTE } from "../src/handoff.ts";

const now = Date.parse("2026-09-17T08:00:00Z");
const item = (wakeId: string) => ({ wakeId, time:"18:00", fireAt:now+7200000, act:true, source:"云端",intent:"新念头",why:"",sem:"",topic:"",kind:"extra" });
function setup() {
  const store=new Store(":memory:");
  store.saveCharacter({characterId:"c1",sessionId:"s1",name:"本地名字",enabled:false,settings:{tzOffsetMin:480,quota:7},state:{threads:[{id:"kept",kind:"topic",text:"本地改过",done:true}]},importedAt:1,updatedAt:1});
  const day: DayRow={characterId:"c1",date:"2026-09-17",day:{mood:"本地情绪",schedule:[{time:"19:00",title:"本地日程"}]},items:[],selfUsed:2,recheckCount:5,judgedAt:123,judgedChatAt:124,genTries:1,genError:"",genLog:[],source:"server",updatedAt:1};
  store.saveDay(day);
  const plans=[{character_id:"c1",plan_date:day.date,session_id:"s1",context:{day:{mood:"过期情绪"},threads:[] as object[]},items:[item("new")]},
    // 不限最近四份：这条旧计划上的未来预约也要补上。
    ...Array.from({length:5},(_,i)=>({character_id:"c1",plan_date:`2026-09-${String(16-i).padStart(2,"0")}`,session_id:"s1",context:{day:{mood:"旧日子"},threads:[] as object[]},items:i===4?[item("older-plan")]:[]}))];
  const cancelledByUser=new Set<string>(), sent=new Set<string>();let fail=false;
  const rest=async(path:string)=>{
    const q=new URLSearchParams(path.split("?")[1]);
    if(path.startsWith("push_recheck_plans?")) return Response.json(plans.slice(Number(q.get("offset")),Number(q.get("offset"))+200));
    if(path.startsWith("push_jobs?")) return Response.json(plans.flatMap(p=>p.items).map(w=>({trigger_key:"timedwake:"+w.wakeId,status:"cancelled",result_note:cancelledByUser.has(w.wakeId)?"user cancelled":LEGACY_HANDOFF_NOTE})));
    if(fail) return new Response("unavailable",{status:503});
    return Response.json([...sent].map(id=>({trigger_key:"timedwake:"+id})));
  };
  return {store,day,plans,rest,sent,cancelledByUser,fail:()=>{fail=true;}};
}

test("补迁缺失任务和关联约定，保留后端日程/计数/设置/账本；重试不重复",async()=>{
  const e=setup();
  try {
    e.plans[0].items.push({...item("promise"),kind:"promise",from:"p1",promiseRevision:1} as ReturnType<typeof item>);
    e.plans[0].context.threads.push({id:"p1",kind:"promise",text:"已约好",revision:1,status:"pending",due:now+7200000});
    const before=e.store.getDay("c1",e.day.date)!;
    const r=await importMissingCloudTasks(e.rest,e.store,"u1","c1",now);
    assert.deepEqual(r,{items:3,timers:3,skipped:[]});
    const after=e.store.getDay("c1",e.day.date)!;
    assert.deepEqual(after.day,before.day);assert.equal(after.selfUsed,2);assert.equal(after.recheckCount,5);
    assert.equal(e.store.getCharacter("c1")!.settings.quota,7);assert.equal(e.store.getCharacter("c1")!.state.threads![0].text,"本地改过");
    assert.equal(e.store.getCharacter("c1")!.state.threads![1].id,"p1");
    assert.equal(e.store.getTimer("older-plan")!.status,"pending");
    assert.deepEqual(await importMissingCloudTasks(e.rest,e.store,"u1","c1",now),{items:0,timers:0,skipped:[]});
  } finally {e.store.close();}
});

test("已有撤销/发送终态、云端发送凭据、手动取消均不复活；缺失定时器沿用本地改期",async()=>{
  const e=setup();
  try {
    const d=e.store.getDay("c1",e.day.date)!;
    d.items=[{...item("cancelled"),act:false},{...item("sent"),generatedAt:now-1000},{...item("moved"),fireAt:now+10800000,intent:"本地新意图"}];e.store.saveDay(d);
    e.plans[0].items.push(...["cancelled","sent","moved","terminal","user-cancel","delivered"].map(item));
    e.store.addTimer({id:"terminal",characterId:"c1",date:d.date,fireAt:now,kind:"extra",status:"done",note:"作罢"});
    e.cancelledByUser.add("user-cancel");e.sent.add("delivered");
    await importMissingCloudTasks(e.rest,e.store,"u1","c1",now);
    for(const key of ["cancelled","sent","user-cancel","delivered"]) assert.equal(e.store.getTimer(key),null);
    assert.equal(e.store.getTimer("terminal")!.status,"done");assert.equal(e.store.getTimer("moved")!.fireAt,now+10800000);
    assert.equal(e.store.getDay("c1",d.date)!.items.find(w=>w.wakeId==="moved")!.intent,"本地新意图");
  } finally {e.store.close();}
});

test("发送凭据读取失败不写入补迁状态",async()=>{
  const e=setup();
  try {
    const before=e.store.getDay("c1",e.day.date);e.fail();
    await assert.rejects(importMissingCloudTasks(e.rest,e.store,"u1","c1",now));
    assert.deepEqual(e.store.getDay("c1",e.day.date),before);assert.equal(e.store.getTimer("new"),null);
  }finally{e.store.close();}
});
