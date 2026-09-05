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
    generateJson=async()=>{h.modelCalls=(h.modelCalls||0)+1;if(h.onModel)await h.onModel();return h.generated;};
    readRecentChat=async()=>[{role:'user',t:Date.now()-1000,c:'用啊'}];
    ${extra}
    globalThis.api={S,SET_DEF,ctxOf,todayStr,recheck,adoptCloudDay,applyThreads,saveSettings,syncUsageCloud,usageTotals,isBusyItem,refineSchedItem,parseDayResult,cloudGenOn,stopCloudGeneration,generationStopState,mergeScheduleItem,applyChatSchedEdits,dayForCloud,cloudContext,uploadPlanCloud,flushJudgeFinish,freezeJudgeTemplate,renderUsage,spendApi,usageCloudScope,pullCloudDecisionsBody};
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
const json=(data,status=200)=>new Response(JSON.stringify(data),{status});
function worker(file='push-recheck',extra={},expose='') {
 const ctx=vm.createContext({console,Date:Clock,Response,Request,Headers,URL,URLSearchParams,AbortController,AbortSignal,TextEncoder,TextDecoder,Uint8Array,setTimeout:()=>1,clearTimeout(){},Deno:{serve(){}},...extra});
 vm.runInContext(stripTypeScriptTypes(fs.readFileSync(root+'/supabase/functions/'+file+'/index.ts','utf8'))+'\n'+expose,ctx);return ctx;
}
const wr=worker('push-recheck',{},'globalThis.api={buildJudgeBody,parseDayResult,dayOutlook};').api;
const wg=worker('push-generate',{},'globalThis.busy=guanianBusyUntil;');
await test('云端预约接管和再上传保留惦记关联、有效期及顺延字段',async()=>{
 const {a,cx,h}=fixture();cx.day=null;cx.plan=null;h.rows.days=[];h.rows.plans=[];
 const item={time:'18:00',fireAt:now+7200000,act:true,wakeId:'cloud-wake',from:'thread-1',until:now+10800000,origFireAt:now+3600000,held:true};
 h.cloud=async()=>({ok:true,plan:{plan_date:a.todayStr(),context:{generatedBy:'cloud',dayFull:{mood:'平静',energy:60,schedule:[]}},items:[item]}});
 assert.equal(await a.adoptCloudDay(cx),true);
 for(const k of ['from','until','origFireAt','held'])assert.equal(cx.plan.items[0][k],item[k]);
 await a.uploadPlanCloud(cx,false);
 const sent=JSON.parse(h.calls.find(([action,init])=>action==='recheck-plan'&&init.method==='POST')[1].body).items[0];
 for(const k of ['from','until','origFireAt','held'])assert.equal(sent[k],item[k]);
});
await test('忙闲显式值优先，本机和云端旧数据标题兜底一致',async()=>{
 const {a,cx}=fixture();
 for(const [item,want] of [[{title:'开会',busy:false},false],[{title:'散步',busy:true},true],[{title:'开会'},true],[{title:'开会后休息'},false]]){
  assert.equal(a.isBusyItem(item),want);
  assert.equal(wg.busy({schedule:[{...item,time:'17:00',end:'18:00'}]},'17:30'),want?'18:00':'');
  const outlook=wr.dayOutlook({schedule:[{...item,time:'17:00',end:'18:00'}],energy:60},'2026-09-05',0,now,{quietStart:'23:30',quietEnd:'08:00'});
  assert.equal(outlook.find(x=>x.doing===item.title).busy,want);
 }
 cx.day.schedule=[{time:'17:00',title:'开会'},{time:'18:00',title:'开会',busy:false}];
 const round=JSON.parse(JSON.stringify(a.dayForCloud(cx)));
 assert.equal(Object.hasOwn(round.schedule[0],'busy'),false);assert.equal(round.schedule[1].busy,false);
});
await test('本机及云端日程解析区分未标注与明确闲',async()=>{
 const {a}=fixture();const input={schedule:[{time:'17:00',title:'开会',busy:false},{time:'18:00',title:'开会'},{time:'19:00',title:'散步',busy:true}]};
 for(const fn of [a.parseDayResult,wr.parseDayResult]){
  const day=fn(input,[],a.SET_DEF,now);
  assert.equal(day.schedule[0].busy,false);assert.equal(day.schedule[1].busy,undefined);assert.equal(day.schedule[2].busy,true);
 }
});
await test('重写描述保留结束时间、忙闲、来源及细排，移动时保持时长并失效旧细排',async()=>{
 const {a,cx,h}=fixture('saveSchedule=async(cx,sched)=>{cx.day.schedule=sched;};');
 const old={time:'17:00',end:'18:00',busy:false,title:'开会',from:'manual',steps:[{time:'17:15',what:'讨论'}]};
 cx.day.schedule=[old];h.generated={title:'开会',note:'换了会议室'};
 await a.refineSchedItem(cx,0,'只改备注');
 assert.equal(cx.day.schedule[0].end,'18:00');assert.equal(cx.day.schedule[0].busy,false);assert.equal(cx.day.schedule[0].from,'manual');assert.deepEqual(structuredClone(cx.day.schedule[0].steps),old.steps);
 h.generated={time:'18:30',title:'开会'};await a.refineSchedItem(cx,0,'晚点开始');
 assert.equal(cx.day.schedule[0].end,'19:30');assert.equal(cx.day.schedule[0].steps,undefined);
 assert.throws(()=>a.mergeScheduleItem(old,{time:'23:30'}),/午夜/);
 assert.throws(()=>a.mergeScheduleItem(old,{end:'16:30'}),/结束时间/);
 assert.equal(a.mergeScheduleItem(old,{time:'18:30',end:'19:00',busy:true}).end,'19:00');
});
await test('聊天改约同步平移日程结束时间，忙闲属性保留',async()=>{
 const {a,cx}=fixture('saveSchedule=async(cx,sched)=>{cx.day.schedule=sched;};');
 cx.day.schedule=[{time:'17:00',end:'18:00',title:'开会',busy:false}];
 await a.applyChatSchedEdits(cx,[{op:'move',time:'17:00',newTime:'18:30',why:'约好改时间'}],now);
 assert.equal(cx.day.schedule[0].end,'19:30');assert.equal(cx.day.schedule[0].busy,false);
});
await test('用量首次失败为未知、保留本机数，立即重试可恢复且成功后才缓存',async()=>{
 const {a,h}=fixture();a.S.settings.apiUse={date:a.todayStr(),n:3};h.cloud=async()=>{throw Error('Load failed');};
 await a.syncUsageCloud(false);assert.equal(a.usageTotals().cloudCalls,null);assert.equal(a.usageTotals().calls,3);assert.equal(a.usageTotals().complete,false);assert.equal(a.S._use.at,0);
 assert.ok(!h.logs.some(x=>x.includes('旧版云函数')));
 h.cloud=async()=>({ok:true,rows:[{day:a.todayStr(),source:'cloud-recheck',calls:4,prompt_tokens:10,completion_tokens:5}]});
 await a.syncUsageCloud(false);assert.equal(a.usageTotals().cloudCalls,4);assert.equal(a.usageTotals().calls,7);assert.equal(a.usageTotals().complete,true);
 const count=h.calls.length;await a.syncUsageCloud(false);assert.equal(h.calls.length,count);
});
await test('刷新失败不抹掉上次成功账本，不跨云地址串用统计',async()=>{
 const {a,h}=fixture();h.cloud=async()=>({ok:true,rows:[{day:a.todayStr(),source:'cloud-recheck',calls:9}]});await a.syncUsageCloud(true);
 const oldAt=a.S._use.at;h.cloud=async()=>{throw Error('network failed');};await a.syncUsageCloud(true);
 assert.equal(a.usageTotals().cloudCalls,9);assert.equal(a.S._use.at,oldAt);assert.equal(a.usageTotals().complete,false);
 a.S.settings.cloudUrl='https://other.invalid';assert.equal(a.usageTotals().cloudCalls,null);assert.equal(a.usageTotals().calls,0);
});
await test('用量页面明确未知，错误文本转义，手动刷新强制请求',async()=>{
 const {a,h}=fixture('h.view={innerHTML:""};h.button={};document.querySelector=selector=>selector==="#btn-usage-retry"?h.button:h.view;');
 a.S.tab='back';a.S.sub='usage';h.cloud=async()=>{throw Error('<script>bad</script>');};
 await a.renderUsage();assert.ok(h.view.innerHTML.includes('合计未确认'));assert.ok(h.view.innerHTML.includes('未知'));assert.ok(h.view.innerHTML.includes('&lt;script&gt;'));assert.ok(!h.view.innerHTML.includes('额度内'));
 h.cloud=async()=>({ok:true,rows:[]});await h.button.onclick();assert.ok(h.view.innerHTML.includes('云端统计已同步'));
 const before=h.calls.length;await h.button.onclick();assert.ok(h.calls.length>before);
});
await test('设有上限时未知云端用量不会当成零继续付费调用',async()=>{
 const {a,cx,h}=fixture();a.S.settings.apiDailyCap=10;h.cloud=async()=>{throw Error('offline');};
 await assert.rejects(a.spendApi(cx),/云端用量尚未确认/);assert.equal(a.S.settings.apiUse?.n||0,0);
 a.S.settings.apiDailyCap=0;a.S.settings.tokenDailyCap=0;await a.spendApi(cx);assert.equal(a.S.settings.apiUse.n,1);
});
await test('云端完成游标阻止本机重判；门禁日志不会冒充模型已处理',async()=>{
 const {a,cx,h}=fixture();h.cloud=async(action)=>action==='recheck-plan'?{ok:true,plan:{plan_date:a.todayStr(),context:{},items:[],judged_chat_at:now-1000,judged_at:now-500,decisions:[]}}:{ok:true};
 await a.recheck(cx,'打开');assert.equal(h.modelCalls||0,0);assert.equal(cx.plan.judgedChatAt,now-1000);
 const g=fixture();g.h.cloud=async(action)=>action==='recheck-plan'?{ok:true,plan:{plan_date:g.a.todayStr(),context:{},items:[],last_recheck_at:new Date(now-500).toISOString(),decisions:[{kind:'gate',at:now-500,note:'没判'}]}}:{ok:true};
 await g.a.recheck(g.cx,'打开');assert.equal(g.h.modelCalls,1);
});
await test('云端已认领或已处理时本机不调模型，旧云函数缺能力也不重复兜底',async()=>{
 for(const mode of ['busy','handled','old']){
 const {a,cx,h}=fixture();h.cloud=async(action)=>action==='judge-task'?{ok:true,claimed:false,reason:mode}:action==='recheck-capabilities'&&mode==='old'?{ok:true,capabilities:[]}:{ok:true};
 await a.recheck(cx,'打开');assert.equal(h.modelCalls||0,0);assert.equal(cx._planLock,false);
 }
});
await test('本机先认领后调用，结果返回前复核租约，成功后提交聊天游标',async()=>{
 const {a,cx,h}=fixture();const ops=[];h.cloud=async(action,init)=>{if(action==='judge-task')ops.push(JSON.parse(init.body));return {ok:true};};
 h.onModel=()=>{assert.equal(ops[0].op,'claim');};await a.recheck(cx,'打开');
 assert.equal(h.modelCalls,1);assert.deepEqual(ops.map(x=>x.op),['claim','renew','finish']);assert.equal(ops.at(-1).success,true);assert.equal(ops.at(-1).chatAt,now-1000);assert.equal(cx.plan.judgeFinish,null);
});
await test('完成回执网络失败落盘，重开后只补回执不再调模型',async()=>{
 const {a,cx,h}=fixture();let down=true;
 h.cloud=async(action,init)=>{if(action==='judge-task'&&JSON.parse(init.body).op==='finish'&&down)throw Error('offline');return {ok:true};};
 await a.recheck(cx,'打开');assert.equal(h.modelCalls,1);assert.equal(h.rows.plans[0].judgeFinish.success,true);
 cx.plan=structuredClone(h.rows.plans[0]);down=false;await a.recheck(cx,'打开');assert.equal(h.modelCalls,1);assert.equal(cx.plan.judgeFinish,null);
});
await test('租约被收回不应用模型结果，也不提交成功游标',async()=>{
 const {a,cx,h}=fixture();let finish;
 h.cloud=async(action,init)=>{if(action!=='judge-task')return {ok:true};const body=JSON.parse(init.body);if(body.op==='finish')finish=body;return {ok:true,claimed:body.op!=='renew'};};
 h.generated.feel={mood:'新情绪'};await a.recheck(cx,'打开');assert.equal(h.modelCalls,1);assert.equal(cx.plan.recheckAt,undefined);assert.equal(finish.success,false);assert.equal(cx._planLock,false);
});
await test('云端三类模型请求继承系统、人设、世界书、预设，任务只填一次且不修改快照',()=>{
 for(const providerKind of ['openai','anthropic','gemini']){
 const body=providerKind==='gemini'?{systemInstruction:{parts:[{text:'人设 世界书 预设'}]},contents:[{role:'user',parts:[{text:'历史'},{text:'[挂念] __CUSTOM_APP_INSTRUCTION__'}]}],generationConfig:{temperature:0.4,maxOutputTokens:8000}}:
 {model:'model',stream_options:{include_usage:true},system:providerKind==='anthropic'?[{type:'text',text:'人设 世界书 预设'}]:undefined,messages:[{role:'system',content:'人设 世界书 预设'},{role:'user',content:'[挂念] __CUSTOM_APP_INSTRUCTION__'}],temperature:0.4,max_tokens:8000};
 const original=JSON.stringify(body),out=wr.buildJudgeBody({providerKind,body},'本轮任务');
 assert.equal(JSON.stringify(body),original);const text=JSON.stringify(out);assert.ok(text.includes('人设 世界书 预设'));assert.ok(!text.includes('__CUSTOM_APP_INSTRUCTION__'));assert.equal(text.split('本轮任务').length-1,1);
 if(providerKind==='gemini'){assert.equal(out.generationConfig.maxOutputTokens,8000);assert.equal(out.generationConfig.temperature,0.4);}else{assert.equal(out.max_tokens,8000);assert.equal(out.temperature,0.4);assert.equal(out.stream,false);assert.equal(out.stream_options,undefined);}
 const legacy=wr.buildJudgeBody({providerKind,body:providerKind==='gemini'?{systemInstruction:body.systemInstruction,contents:[]}:{system:'人设 世界书 预设',messages:[]}},'旧模板补任务');assert.ok(JSON.stringify(legacy).includes('人设 世界书 预设'));assert.ok(JSON.stringify(legacy).includes('旧模板补任务'));
 }
});
await test('冻结独立起意判断模板并寄存，缓存按云地址隔离',async()=>{
 const {a,cx,h}=fixture('AiPhone.push.freeze=async(req)=>{h.frozen=req;return {armed:true,id:"judge-template"};};');
 await a.freezeJudgeTemplate(cx);assert.equal(h.frozen.key,'judge');assert.deepEqual(Array.from(h.frozen.appTags),['companion','impulse']);assert.equal(a.cloudContext(cx).judgeTemplate,'judge-template');
 a.S.settings.cloudUrl='https://other.invalid';assert.equal(a.cloudContext(cx).judgeTemplate,'');
});
await test('真实云端入口遵守本机认领，成功保存游标与结果，模板走独立判断请求',async()=>{
 for(const mode of ['app-busy','success','save-race','model-failed']){
  let handler,modelCalls=0;const writes=[],tasks=[];
  const chatAt=now-60000,plan={session_id:'session',updated_at:'v1',context:{day:{tz:0,energy:60,schedule:[]},quota:4,gateMinMsgs:1,gateFreshMin:0,gateHorizonMin:0,judgeTemplate:'judge',sentinelWakeId:'sentinel',wakePrefix:'wake_',momentsOn:0},items:[{time:'18:00',fireAt:now+7200000,act:false,wakeId:'old'}],decisions:[],judged_chat_at:0};
  worker('push-recheck',{Deno:{env:{get:()=> 'test'},serve:f=>handler=f},fetch:async(url,init)=>{
    if(url==='https://judge.invalid'){
      modelCalls++;assert.ok(JSON.parse(init.body).messages[0].content.includes('专用人设'));
      return mode==='model-failed'?json({},500):json({choices:[{message:{content:'{"decisions":[],"extra":[],"post":null}'}}]});
    }
    if(url.includes('push_server_config'))return json([{cron_secret:'secret',payload_key:'key'}]);
    if(url.includes('rpc/push_recheck_judge')){const b=JSON.parse(init.body);tasks.push(b);return json({claimed:mode!=='app-busy'});}
    if(url.includes('push_chat_mirror'))return json([{role:'user',content:'约好的安排',message_at:new Date(chatAt).toISOString()}]);
    if(url.includes('push_jobs'))return json([{trigger_key:'timedwake:sentinel',payload:'chat',status:'pending'},{trigger_key:'judge',payload:'judge',status:'pending'}]);
    if(url.includes('push_recheck_plans')){
      if(init?.method==='PATCH'){const body=JSON.parse(init.body);writes.push({url,body});return json(mode==='save-race'&&body.judged_at?[]:[plan]);}
      return json([plan]);
    }
    throw Error('Unexpected URL '+url);
  }},`
    lifeRoll=()=>null;feedbackWithPreviousDay=async()=>null;usageBudget=async()=>({tz:0});usageExceeded=()=>"";usageAdd=async()=>{};
    decryptPayload=async(value)=>JSON.stringify({notify:{title:"角色"},request:{providerKind:"openai",url:value==="judge"?"https://judge.invalid":"https://chat.invalid",headers:{},body:{messages:[{role:"system",content:value==="judge"?"专用人设 世界书 起意预设":"聊天人设"},{role:"user",content:"__CUSTOM_APP_INSTRUCTION__"}]}}});
  `);
  await handler(new Request('https://test.invalid',{method:'POST',body:JSON.stringify({token:'secret',userId:'u',characterId:'c',planDate:'2026-09-05'})}));
  assert.equal(modelCalls,mode==='app-busy'?0:1,mode);
  if(mode==='app-busy'){assert.equal(tasks.length,1);assert.equal(writes.some(x=>x.body.last_recheck_at),false);}
  else{
    assert.equal(tasks.at(-1).p_action,'finish');assert.equal(tasks.at(-1).p_success,mode==='success');
    if(mode!=='model-failed'){const save=writes.find(x=>x.body.judged_at);assert.equal(save.body.judged_chat_at,chatAt);assert.ok(save.url.includes('judge_token=eq.'));assert.ok(save.url.includes('updated_at=eq.v1'));}
  }
 }
});
await test('网关原样传递判断认领结果，保留预约及模板字段',async()=>{
 let handler;const calls=[];
 worker('ai-phone-push',{Deno:{env:{get:k=>({SUPABASE_URL:'https://cloud.invalid',SUPABASE_SERVICE_ROLE_KEY:'test'})[k]},serve:f=>handler=f},fetch:async(url,init)=>{
  calls.push({url,init});if(url.includes('rpc/push_recheck_judge'))return json({claimed:false,reason:'busy'});
  return json([]);
 }});
 let r=await handler(new Request('https://cloud.invalid?action=judge-task',{method:'POST',headers:{'x-ai-phone-service-key':'test'},body:JSON.stringify({characterId:'c',planDate:'2026-09-05',token:'app-token',op:'claim',chatAt:now-1000})}));
 assert.equal(r.status,200);assert.equal((await r.json()).claimed,false);
 const rpc=JSON.parse(calls[0].init.body);assert.equal(rpc.p_user_id,'owner');assert.equal(rpc.p_action,'claim');assert.equal(rpc.p_chat_at,now-1000);
 r=await handler(new Request('https://cloud.invalid?action=recheck-plan',{method:'POST',headers:{'x-ai-phone-service-key':'test'},body:JSON.stringify({characterId:'c',planDate:'2026-09-05',context:{judgeTemplate:'judge:template'},items:[{time:'18:00',fireAt:now+7200000,from:'thread-1',until:now+10800000,origFireAt:now+3600000,held:true}]})}));
 assert.equal(r.status,200);
 const post=calls.find(x=>x.url.includes('push_recheck_plans')&&x.init?.method==='POST');const row=JSON.parse(post.init.body)[0];
 assert.equal(row.context.judgeTemplate,'judge:template');assert.equal(row.items[0].held,true);assert.equal(row.items[0].from,'thread-1');assert.equal(row.items[0].until,now+10800000);assert.equal(row.items[0].origFireAt,now+3600000);
});
console.log(`Passed ${passed} gua-nian P2 checks.`);
