import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { checkGuaNianBuild } from './build-gua-nian.mjs';
checkGuaNianBuild();
const root=fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const script=fs.readFileSync(root+'/custom-apps/gua-nian/index.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1];
const now=Date.parse('2026-09-05T16:00:00Z');
class Clock extends Date { constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} }
function fixture(extra='') {
  const h={rows:{},calls:[],logs:[],cancelled:[],generated:{decisions:[],extra:[],sched:[],keep:[],settle:[],post:null},cloud:async()=>({ok:true}),failTable:''};
  const clone=x=>structuredClone(x);
  const ctx=vm.createContext({h,Date:Clock,console,URLSearchParams,Intl,setTimeout:()=>1,clearTimeout:()=>{},AbortController,
    document:{querySelector:()=>null,querySelectorAll:()=>[{dataset:{id:"c"}}]},
    AiPhone:{db:{list:async table=>clone(h.rows[table]||[]),update:async(table,id,patch)=>{if(h.failTable===table)throw Error('storage unavailable');const row=h.rows[table].find(x=>x.id===id);Object.assign(row,clone(patch));return clone(row);},create:async(table,data)=>{if(h.failTable===table)throw Error('storage unavailable');const row={id:table+'-'+(h.rows[table]||[]).length,...clone(data)};(h.rows[table]||=[]).push(row);return clone(row);}},push:{cancelWake:async id=>{if(h.failCancel)throw Error("cancel unavailable");h.cancelled.push(id);}},calendar:{read:async()=>({plan:{items:[]}}),write:async()=>({})}}});
  const expose=`
    log=async(_cx,msg)=>h.logs.push(msg); render=()=>{}; renderCloudSync=()=>{}; toast=()=>{};
    syncChatContext=async()=>{};
    cloudFetch=async(...args)=>{h.calls.push(args);const r=await h.cloud(...args);return args[0]==="judge-task"?{claimed:true,...r}:args[0]==="recheck-capabilities"?{capabilities:["judge-task-v1"],...r}:r};
    generateJson=async()=>{h.modelCalls=(h.modelCalls||0)+1;return h.generated;};
    readRecentChat=async()=>[{role:'user',t:Date.now()-1000,c:'用啊'}];
    ${extra}
    globalThis.api={S,SET_DEF,ctxOf,todayStr,recheck,adoptCloudDay,applyThreads,saveSettings,syncUsageCloud,usageTotals,isBusyItem,refineSchedItem,parseDayResult,cloudGenOn,stopCloudGeneration,generationStopState};
  `;
  vm.runInContext(script.replace(/  init\(\);\s*\}\)\(\);\s*$/,expose+'\n})();'),ctx);
  const a=ctx.api;
  a.S.settings={...a.SET_DEF,id:'s',deviceId:'mine',characterIds:['c'],cloudUrl:'https://cloud.invalid',cloudKey:'test',cloudRecheck:true,autoGen:true,cloudGen:true,momentsOn:false};
  h.rows.settings=[clone(a.S.settings)];
  const cx=a.ctxOf({id:'c',name:'角色'});
  cx.day={id:'d',date:a.todayStr(),characterId:'c',mood:'平静',energy:60,schedule:[]};
  cx.plan={id:'p',date:a.todayStr(),characterId:'c',plannedAt:now-60000,items:[]};
  h.rows.days=[clone(cx.day)];h.rows.plans=[clone(cx.plan)];h.rows.threads=[];
  a.S.byId.c=cx;a.S.cur='c';a.S.order=['c'];a.S.characters=[cx.character];
  return {a,cx,h};
}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('✓ '+name);}
await test('自动复核读取失败不调模型、不上传，恢复网络可以重试',async()=>{
 const {a,cx,h}=fixture();h.cloud=async()=>{throw Error('Load failed');};
 await a.recheck(cx,'打开');assert.equal(h.modelCalls||0,0);assert.equal(h.calls.filter(([,init])=>init.method==='POST').length,0);
 h.cloud=async()=>({ok:true});await a.recheck(cx,'打开');assert.equal(h.modelCalls,1);
});
function withThread(){
 const f=fixture(),{cx,h}=f;
 cx.plan.items=[{time:'18:00',act:true,fireAt:now+7200000,wakeId:'wake-1',from:'t1'}, {time:'19:00',act:true,fireAt:now+10800000,wakeId:'wake-2',from:'other'}];
 h.rows.plans[0]=structuredClone(cx.plan);
 cx.threads=[{id:'t1',text:'问检查结果',kind:'topic',since:now,at:now,done:false}];
 h.rows.threads=[{id:'threads',characterId:'c',items:structuredClone(cx.threads)}];return f;
}
await test('真实复核了结惦记后撤关联预约，最终计划不把它恢复',async()=>{
 const {a,cx,h}=withThread();h.generated.settle=['t1'];await a.recheck(cx,'打开');
 assert.equal(cx.threads[0].done,true);assert.equal(cx.plan.items[0].act,false);assert.equal(cx.plan.items[0].wakeId,'');
 assert.equal(cx.plan.items[1].act,true);assert.deepEqual(h.cancelled,['wake-1']);
 const post=h.calls.filter(([act,init])=>act==='recheck-plan'&&init.method==='POST').at(-1);
 assert.equal(JSON.parse(post[1].body).items[0].act,false);
});
await test('撤销或保存失败保留编号及未了结状态，可按原编号重试',async()=>{
 const {a,cx,h}=withThread();h.failTable='plans';
 await assert.rejects(a.applyThreads(cx,{settle:['t1']},now,'app'),/storage unavailable/);
 assert.equal(cx.threads[0].done,false);assert.equal(cx.plan.items[0].wakeId,'wake-1');
 h.failTable='';await a.applyThreads(cx,{settle:['t1']},now,'app');
 assert.equal(cx.threads[0].done,true);assert.deepEqual(h.cancelled,['wake-1','wake-1']);
});
function cloudDayFixture(){
 const f=fixture(),{a,cx,h}=f;cx.day=null;cx.plan=null;h.rows.days=[];h.rows.plans=[];
 h.cloud=async()=>({ok:true,plan:{plan_date:a.todayStr(),context:{generatedBy:'cloud',dayFull:{mood:'平静',energy:60,schedule:[]}},items:[{time:'18:00',act:true,fireAt:now+7200000,wakeId:'cloud-wake'}]}});return f;
}
await test('撤销请求失败不把惦记标成了结，下次能继续撤销',async()=>{
 const {a,cx,h}=withThread();h.failCancel=true;
 await assert.rejects(a.applyThreads(cx,{settle:['t1']},now,'app'),/cancel unavailable/);
 assert.equal(cx.threads[0].done,false);assert.equal(cx.plan.items[0].wakeId,'wake-1');
 h.failCancel=false;await a.applyThreads(cx,{settle:['t1']},now,'app');
 assert.equal(cx.threads[0].done,true);assert.equal(cx.plan.items[0].act,false);
});
await test('接管 plan 保存失败后可续接，标记跨重开保留，已完成不再覆盖',async()=>{
 const {a,cx,h}=cloudDayFixture();h.failTable='plans';assert.equal(await a.adoptCloudDay(cx),false);
 assert.equal(cx.day.cloudAdopting,true);assert.equal(h.rows.days[0].cloudAdopting,true);assert.equal(cx.plan,null);
 cx.day=structuredClone(h.rows.days[0]);h.failTable='';assert.equal(await a.adoptCloudDay(cx),true);
 assert.equal(cx.plan.items[0].wakeId,'cloud-wake');assert.equal(cx.day.cloudAdopting,false);
 const reads=h.calls.length;assert.equal(await a.adoptCloudDay(cx),false);assert.equal(h.calls.length,reads);
});
await test('旧版留下 cloud day 但无 plan 也能补齐；本地日程不接管覆盖',async()=>{
 const {a,cx,h}=cloudDayFixture();cx.day={by:'cloud',id:'legacy',date:a.todayStr(),characterId:'c',schedule:[]};h.rows.days=[structuredClone(cx.day)];
 assert.equal(await a.adoptCloudDay(cx),true);
 cx.day.by='local';cx.plan=null;assert.equal(await a.adoptCloudDay(cx),false);
});
await test('关闭 autoGen 停用云端待生成任务，今天日程和预约不取消',async()=>{
 const {a,cx,h}=fixture('readSheet=()=>({autoGen:false}); closeSheet=()=>{}; renderSettingsEffects=()=>{};');
 const day=structuredClone(cx.day),items=structuredClone(cx.plan.items);
 h.cloud=async(action)=>action==='generation-stop'?{ok:true,stopped:true,capabilities:['generation-stop-v1']}:{ok:true};
 await a.saveSettings();assert.equal(h.calls.filter(([action])=>action==='generation-stop').length,1);
 assert.deepEqual(h.cancelled,[]);assert.deepEqual(structuredClone(cx.day),day);assert.deepEqual(structuredClone(cx.plan.items),items);
 assert.equal(a.generationStopState(cx).status,'synced');
});
await test('停用失败持久显示未确认，重开后重试；重新启用不显示旧失败',async()=>{
 const {a,cx,h}=fixture();a.S.settings.autoGen=false;h.rows.settings[0].autoGen=false;h.cloud=async()=>{throw Error('Load failed');};
 assert.equal((await a.stopCloudGeneration(cx)).status,'failed');
 a.S.settings=structuredClone(h.rows.settings[0]);assert.equal(a.generationStopState(cx).status,'failed');
 h.cloud=async()=>({ok:true,stopped:true,capabilities:['generation-stop-v1']});
 assert.equal((await a.stopCloudGeneration(cx)).status,'synced');
 a.S.settings.autoGen=true;assert.equal(a.generationStopState(cx),null);
});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status});
function worker(extra,expose=''){
 const ctx=vm.createContext({console,Date:Clock,Response,Request,Headers,URL,URLSearchParams,AbortController,AbortSignal,TextEncoder,TextDecoder,Uint8Array,setTimeout:()=>1,clearTimeout(){},...extra});
 vm.runInContext(stripTypeScriptTypes(fs.readFileSync(root+'/supabase/functions/push-recheck/index.ts','utf8'))+'\n'+expose,ctx);return ctx;
}
await test('云端已停用的 genKit 不进入生成，也不影响已完成日程',async()=>{
 let handler;const requests=[];
 worker({Deno:{env:{get:()=> 'test'},serve:f=>handler=f},fetch:async url=>{requests.push(String(url));return json(String(url).includes('push_server_config')?[{cron_secret:'secret',payload_key:'key'}]:[{context:{genKit:{},genEnabled:0},items:[]}]);}});
 const response=await handler(new Request('https://test.invalid',{method:'POST',body:JSON.stringify({token:'secret',userId:'u',characterId:'c',planDate:'2026-09-05'})}));
 assert.equal(await response.text(),'gen: disabled');assert.equal(requests.length,2);
});
await test('自动生成模型在途时停用，不再编排或写回结果',async()=>{
 let stopped=false,calls=0;const writes=[];
 const ctx=worker({Deno:{serve(){}},h:{generate:()=>{calls++;stopped=true;return {schedule:[]};}}},`
  decryptPayload=async()=>JSON.stringify({request:{providerKind:'anthropic',body:{}}});
  usageBudget=async()=>({tz:0}); usageAdd=async()=>{};
  generateJsonWith=async()=>h.generate(); globalThis.generate=generateCloudDay;
 `);
 await ctx.generate({rest:async(path,init)=>{
   if(init)writes.push({path,init});
   if(path.startsWith('push_jobs'))return json([{trigger_key:'daily',payload:{}},{trigger_key:'impulse',payload:{}}]);
   return json(stopped?[]:[{plan_date:'2026-09-05'}]);
 },payloadKey:'key',userId:'u',characterId:'c',planDate:'2026-09-05',planFilter:'plans?genEnabled=neq.0',plan:{updated_at:'v1'},context:{},kit:{tplDaily:'daily',tplImpulse:'impulse',instruction:'task'},nowMs:now});
 assert.equal(calls,1);assert.equal(writes.length,0);
});


await test('网关确认 worker 后调用原子停用并复查，不删已有日程或预约',async()=>{
 for(const mode of ['ok','old-worker','old-schema','verify-failed']){
  let handler;const calls=[];
  const ctx=vm.createContext({console,Response,Request,Headers,URL,URLSearchParams,AbortSignal,TextEncoder,TextDecoder,Date,Uint8Array,
   Deno:{env:{get:k=>({SUPABASE_URL:'https://cloud.invalid',SUPABASE_SERVICE_ROLE_KEY:'test'})[k]},serve:f=>handler=f},
   fetch:async(url,init)=>{
    calls.push({url,init});
    if(url.includes('push_server_config'))return json([{cron_secret:'secret'}]);
    if(url.includes('/functions/v1/push-recheck'))return json({ok:true,capabilities:mode==='old-worker'?[]:['generation-stop-v1']});
    if(url.includes('/rpc/push_recheck_stop_generation'))return mode==='old-schema'?json({},404):json(1);
    return json([{context:{generatedBy:'cloud',day:{mood:'保留'},genKit:null}},{context:{genKit:{date:'2026-09-06'},genEnabled:mode==='verify-failed'?1:0}}]);
   }});
  vm.runInContext(stripTypeScriptTypes(fs.readFileSync(root+'/supabase/functions/ai-phone-push/index.ts','utf8')),ctx);
  const response=await handler(new Request('https://cloud.invalid?action=generation-stop',{method:'POST',headers:{'x-ai-phone-service-key':'test'},body:JSON.stringify({characterId:'c',planDate:'2026-09-05',owner:'mine'})}));
  assert.equal(response.status,mode==='ok'?200:409);
  assert.ok(!calls.some(c=>c.init?.method==='DELETE'||c.url.includes('/push_jobs')));
  const rpc=calls.find(c=>c.url.includes('/rpc/'));
  assert.equal(!!rpc,mode!=='old-worker');
  if(rpc)assert.deepEqual(JSON.parse(rpc.init.body),{p_user_id:'owner',p_character_id:'c',p_from_date:'2026-09-05',p_owner:'mine'});
 }
 const sql=fs.readFileSync(root+'/docs/personal-push-supabase.sql','utf8').split('create or replace function public.push_recheck_stop_generation(')[1];
 assert.ok(sql.includes("jsonb_typeof(context->'genKit') = 'object'"));
 assert.ok(sql.includes("coalesce(context->>'generatedBy', '') <> 'cloud'"));
 assert.ok(!/delete from|update public.push_jobs/i.test(sql));
});
console.log(`Passed ${passed} gua-nian P1 checks.`);
