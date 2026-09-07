import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
const now=Date.parse('2026-09-07T04:00:00Z');
class Clock extends Date{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}}
const code=stripTypeScriptTypes(fs.readFileSync(new URL('../supabase/functions/push-recheck/index.ts',import.meta.url),'utf8'));
for(const mode of ['new','reschedule','cancel','already-recorded','legacy-session','legacy-no-template','history-failed']){
 let handler,modelCalls=0,armCalls=[];const models=[];
 const t={id:'p1',kind:'promise',text:'回家一趟',subject:'character',due:Date.parse('2026-09-07T07:30Z'),since:now-60000,at:now-60000,revision:1,done:false};
 const plan={state_version:1,plan_date:'2026-09-07',session_id:mode.startsWith('legacy-')?'':'s',updated_at:'v1',judged_chat_at:['already-recorded','legacy-session','legacy-no-template'].includes(mode)?now:0,
  context:{threads:mode==='new'?[]:[t],day:{tz:480,energy:70,schedule:[]},quota:0,gateDailyCap:8,gateGapMin:0,gateFreshMin:0,gateHorizonMin:0,gateMinMsgs:1,judgeTemplate:'judge',sentinelWakeId:'sentinel',wakePrefix:'app_',momentsOn:0},items:[],decisions:[]};
 const outbox=[{id:'first',trigger_key:'timedwake:earlier',created_at:new Date(now-120000).toISOString(),raw_text:'三点半回家一趟'}];
 const response=mode==='reschedule'?{id:'p1',kind:'promise',text:'回家一趟',subject:'character',when:'2026-09-07 18:30'}:mode==='cancel'?{id:'p1',kind:'promise',status:'cancelled'}:{kind:'promise',text:'回家一趟',subject:'character',when:'2026-09-07 15:30',sourceMessageId:'push-outbox:first'};
 const rest=async(url,init={})=>{
  if(url==='https://model.test'){modelCalls++;models.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:JSON.stringify({decisions:[],extra:[],keep:[response],settle:[]})}}]});}
  const u=new URL(url),tab=u.pathname.split('/').slice(-1)[0];const body=init.body?JSON.parse(init.body):null;
  if(tab==='push_server_config')return Response.json([{cron_secret:'secret',payload_key:'key'}]);
  if(tab==='push_chat_mirror')return Response.json([]);
  if(tab==='push_outbox')return mode==='history-failed'?new Response('',{status:503}):Response.json(outbox);
  if(tab==='push_recheck_plans'){if(init.method==='PATCH')Object.assign(plan,body);return Response.json([plan]);}
  if(tab==='push_jobs' && mode==='legacy-no-template')return Response.json([]);
  if(tab==='push_jobs')return Response.json([{trigger_key:'timedwake:sentinel',payload:'template',status:'pending'},{trigger_key:'judge',payload:'template',status:'pending'}]);
  if(tab==='push_recheck_judge')return Response.json({claimed:true});
  if(tab==='push_cancel_stale_promises')return Response.json(0);
  if(tab==='push_arm_promise'){
   armCalls.push(body);
   const old=plan.items.filter(w=>w.from===body.p_thread_id&&w.act);for(const w of old)w.act=false;
   plan.items.push(body.p_item);plan.decisions.push({kind:'promise',wakeId:body.p_item.wakeId,time:body.p_item.time,by:'cloud',at:now,note:'RPC durable decision'});return Response.json(true);
  }
  throw Error('unexpected '+url);
 };
 const c=vm.createContext({console,Date:Clock,Response,Request,URL,URLSearchParams,Headers,AbortController,TextEncoder,TextDecoder,Uint8Array,setTimeout:()=>1,clearTimeout(){},Deno:{env:{get:()=> 'https://test'},serve:fn=>handler=fn},fetch:rest});
 vm.runInContext(code+`
 lifeRoll=()=>null;feedbackWithPreviousDay=async()=>null;usageBudget=async()=>({tz:480});usageExceeded=()=>"";usageAdd=async()=>{};
 decryptPayload=async()=>JSON.stringify({generatedResponse:{rawText:"OLD REPLY",createdAt:"2026-09-07T01:00Z"},merge:{sessionId:"s"},notify:{title:"角色"},request:{providerKind:"openai-compatible",url:"https://model.test",headers:{},body:{messages:[{role:"user",content:"__CUSTOM_APP_INSTRUCTION__"}]}}});
 encryptPayload=async p=>({v:1,ct:p});
 `,c);
 const result=await handler(new Request('https://test',{method:'POST',body:JSON.stringify({token:'secret',userId:'u',characterId:'c',planDate:'2026-09-07'})}));
 if(['history-failed','legacy-no-template'].includes(mode)){assert.equal(result.status,503);assert.equal(modelCalls,0);assert.equal(armCalls.length,0);}
 else if(['already-recorded','legacy-session'].includes(mode)){assert.equal(modelCalls,0);assert.equal(armCalls.length,1);assert.equal(armCalls[0].p_item.fireAt,t.due);assert.ok(plan.decisions.some(d=>d.kind==='promise'&&d.wakeId===armCalls[0].p_item.wakeId),'RPC promise decision survives gate write');}
 else {
  assert.equal(modelCalls,1,mode);assert.match(JSON.stringify(models[0]),/三点半回家一趟/);
  if(mode==='cancel'){assert.equal(plan.context.threads[0].status,'cancelled');}
  else{const armed=armCalls.at(-1);assert.equal(armed.p_item.kind,'promise');assert.equal(armed.p_item.fireAt,Date.parse(mode==='reschedule'?'2026-09-07T10:30Z':'2026-09-07T07:30Z'));assert.equal(plan.context.threads.length,1);if(mode==='reschedule'){assert.equal(armed.p_revision,2);assert.equal(armed.p_thread_id,'p1');}}
 }
 for(const arm of armCalls) assert.equal(JSON.parse(arm.p_payload.ct).generatedResponse, undefined, 'new promise must not inherit a cached template reply');
 console.log('PASS real cloud recheck '+mode);
}
