import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fixture, at } from './lib/gua-nian-worker-fixture.mjs';
import { updatePromiseThreads, promiseNeedsTask, recheckEvidence } from '../custom-apps/gua-nian/src/domain/promises.mjs';
import ts from 'typescript';
const historyCode=ts.transpileModule(fs.readFileSync(new URL('../lib/guanian-cloud-history.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const hc={exports:{},URL,Date,Map,Set};vm.runInNewContext(historyCode,hc);const {readGuanianCloudHistory,guanianHistoryRounds}=hc.exports;
let n=0;async function test(name,fn){await fn();console.log('PASS '+name);n++;}
await test('角色承诺入账；改期沿用 ID 和版本；另一人的同名事件互不覆盖；取消与恢复',async()=>{
 const input=[];let list=updatePromiseThreads(input,[{kind:'promise',text:'回家一趟',subject:'character',due:at('15:30'),sourceMessageId:'m1'}],at('12:00'),'cloud');
 assert.equal(input.length,0);const id=list[0].id;
 list=updatePromiseThreads(list,[{id,when:'ignored',due:at('18:30'),subject:'character'}],at('13:00'),'cloud');
 assert.equal(list.length,1);assert.equal(list[0].id,id);assert.equal(list[0].due,at('18:30'));assert.equal(list[0].revision,2);
 list=updatePromiseThreads(list,[{text:'回家一趟',subject:'user',due:at('18:30')}],at('13:01'),'cloud');assert.equal(list.length,2);
 assert.equal(promiseNeedsTask(list[0],[],at('18:30'),at('23:59')),true);
 assert.equal(promiseNeedsTask(list[0],[{from:id,kind:'promise',promiseRevision:2,act:true}],at('18:30'),at('23:59')),false);
 list=updatePromiseThreads(list,[{id,status:'cancelled'}],at('13:02'),'cloud');assert.equal(list[0].done,true);assert.equal(list[0].status,'cancelled');
 assert.equal(promiseNeedsTask(list[0],[],at('18:30'),at('23:59')),false);
 list=updatePromiseThreads(list,[{id,status:'pending',due:at('19:00')}],at('13:03'),'cloud');assert.equal(list[0].revision,3);assert.equal(list[0].done,false);
});
await test('用户取消线索进入语义复核；角色坚持不能建立、改期或恢复用户约定',async()=>{
 const now=at('12:00'), due=at('19:00');
 const t={id:'user-event',kind:'promise',text:'检查时间她自己约，我不插手但要跟进',subject:'user',due,at:now-60000,revision:1};
 const messages=[{id:'user-no',role:'user',content:'不做检查了',t:now-30000},{id:'pressure',role:'assistant',content:'周五19:00你必须去检查',t:now-10000}];
 assert.equal(recheckEvidence(messages,[t],now-60000).promiseUpdate,true);
 assert.equal(recheckEvidence([{id:'n',role:'user',content:'今天午饭好吃',t:now}], [t],now-1).promiseUpdate,false);
 const change={kind:'promise',text:t.text,subject:'user',due:due+3600000,sourceMessageId:'pressure'};
 assert.equal(updatePromiseThreads([], [change],now,'cloud',messages).length,0);
 assert.deepEqual(updatePromiseThreads([t], [{...change,id:t.id}],now,'cloud',messages),[t]);
 assert.deepEqual(updatePromiseThreads([t], [{...change,id:t.id,subject:'character'}],now,'cloud',messages),[t]);
 assert.deepEqual(updatePromiseThreads([t], [{...change,id:t.id,sourceMessageId:'invented'}],now,'cloud',messages),[t]);
 let list=updatePromiseThreads([t],[{id:t.id,status:'cancelled',sourceMessageId:'user-no'}],now,'cloud',messages);
 assert.equal(list[0].status,'cancelled');assert.equal(promiseNeedsTask(list[0],[],now,due+1),false);
 list=updatePromiseThreads(list,[change],now+1000,'cloud',messages);assert.equal(list.length,1);assert.equal(list[0].done,true);
 const oldYes={id:'old-yes',role:'user',content:'好，我会去检查',t:now-120000};
 list=updatePromiseThreads(list,[{...change,sourceMessageId:'old-yes'}],now+1000,'cloud',[oldYes]);assert.equal(list[0].done,true);
 const newYes={...oldYes,id:'new-yes',t:now+2000};
 list=updatePromiseThreads(list,[{...change,sourceMessageId:'new-yes'}],now+3000,'cloud',[newYes]);assert.equal(list[0].done,false);assert.equal(list[0].revision,2);
 const own={...change,subject:'character',text:'我周五回家',sourceMessageId:'own'};
 assert.equal(updatePromiseThreads([], [own],now,'cloud',[{id:'own',role:'assistant',content:'我周五回家',t:now}]).length,1,'角色仍能承诺自己的事');
});
await test('较新的用户镜像不会吃掉较早 outbox；超过五轮仍读取最近事实；按批次去重',async()=>{
 const outbox=Array.from({length:8},(_,i)=>({id:'o'+i,raw_text:'第'+i+'轮',created_at:new Date(at('09:00')+i*3600000).toISOString(),consumed_at:null}));
 const mirrors=[{id:'u1',role:'user',content:'好',message_at:new Date(at('12:30')).toISOString()}];
 const rest=async path=>Response.json(path.startsWith('push_chat_mirror')?mirrors:outbox);
 let h=await readGuanianCloudHistory(rest,'u','s');assert.equal(h.outputs.length,8);assert.equal(h.messages.length,9);assert.ok(h.messages.some(m=>m.content==='第0轮'));assert.equal(guanianHistoryRounds(h,at('18:00')),4);
 mirrors.push({id:'m7',role:'assistant',content:'第7轮',response_batch_id:'push-outbox:o7',message_at:outbox[7].created_at});outbox[7].consumed_at=new Date(at('18:00')).toISOString();
 h=await readGuanianCloudHistory(rest,'u','s');assert.equal(h.messages.filter(m=>m.content==='第7轮').length,1);
 await assert.rejects(readGuanianCloudHistory(async()=>new Response('',{status:503}),'u','s'),/读取失败/);
});
function setupPromise(h){h.plan.context.day.schedule=[];h.plan.context.threads=[{id:'p1',kind:'promise',subject:'character',text:'回家',due:at('10:15'),revision:1,status:'pending'}];Object.assign(h.plan.items[0],{kind:'promise',from:'p1',promiseRevision:1});}
await test('明确约定不因等待概率作罢，成文包含当前时间与角色归属',async()=>{
 const {h,init,run}=fixture();await init('fail');setupPromise(h);h.now=at('20:15');await run();assert.equal(h.outbox.length,1);assert.match(JSON.stringify(h.calls[0]),/20:15/);assert.match(JSON.stringify(h.calls[0]),/不能替用户宣布完成/);assert.equal(h.outbox[0].meta.guanianContext.eventId,'p1');
});
await test('成文期间改期或取消阻止旧约定入箱',async()=>{
 for(const mode of ['revision','cancelled']){const {h,init,run}=fixture();await init();setupPromise(h);h.onModel=()=>{if(mode==='revision')h.plan.context.threads[0].revision++;else h.plan.context.threads[0].status='cancelled';};await run();assert.equal(h.outbox.length,0);assert.match(h.job.result_note,/成文期间时刻已撤销或替换/);}
});
await test('同会话已有生成任务时不调模型，租约释放后恢复',async()=>{
 const {h,init,run}=fixture();await init();setupPromise(h);h.leaseAvailable=false;await run();assert.equal(h.calls.length,0);assert.equal(h.job.status,'pending');h.leaseAvailable=true;h.now+=60000;await run();assert.equal(h.outbox.length,1);
});
await test('上一轮 16:09 到了；下一轮生成前可见，按实际时间实施间隔',async()=>{
 const {h,init,run}=fixture();await init();h.plan.context.day.schedule=[];h.plan.context.minGapMin=60;h.now=at('16:30');h.outbox.push({id:'first',job_id:'first-job',trigger_key:'timedwake:first',raw_text:'到了，粥在锅里',created_at:new Date(at('16:09')).toISOString()});await run();assert.equal(h.calls.length,0);assert.match(h.job.result_note,/主动消息间隔/);
 h.now=at('17:14');await run();assert.equal(h.calls.length,1);assert.match(JSON.stringify(h.calls[0]),/到了，粥在锅里/);assert.equal(h.outbox.length,2);
});
await test('云端 outbox 读取失败保留任务重试',async()=>{
 const {h,init,run}=fixture();await init();setupPromise(h);h.outboxFails=true;await run();assert.equal(h.calls.length,0);assert.equal(h.job.status,'pending');
});
// Execute real bundled app functions with minimal persistent storage.
await test('本地两次应用同一约定只挂一条；改期撤旧挂新；完成取消待执行项',async()=>{
 const html=fs.readFileSync(new URL('../custom-apps/gua-nian/index.html',import.meta.url),'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
 let wakes=0;const cancelled=[];const rows={};const c=vm.createContext({console,Date,URLSearchParams,AiPhone:{db:{list:async t=>rows[t]||[],create:async(t,row)=>{const r={id:t,...row};(rows[t]||=[]).push(r);return r;},update:async(t,id,row)=>{Object.assign(rows[t][0],row);return rows[t][0];}},push:{wake:async()=>({id:'w'+(++wakes),armed:true}),cancelWake:async id=>cancelled.push(id)}}});
 vm.runInContext(html.replace(/  init\(\);\s*\}\)\(\);\s*$/,'log=async()=>{}; globalThis.api={S,ctxOf,applyThreads,pullCloudDecisionsBody,todayStr,setCloud:(plan)=>{cloudRecheckOn=()=>true;cloudFetch=async()=>({plan});consumeOutbox=async()=>{};}};\n})();'),c);
 c.api.S.settings={threadsOn:true,threadDays:3};const cx=c.api.ctxOf({id:'c'});const items=[];cx.plan={items};
 const d=new Date(Date.now()+3600000);const when=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
 const pressure={id:'pressure',role:'assistant',t:Date.now(),c:'你必须去检查'};
 await c.api.applyThreads(cx,{keep:[{kind:'promise',text:'去检查',subject:'user',when,sourceMessageId:'pressure'}],settle:[]},Date.now(),'app',items,[pressure]);
 assert.equal(wakes,0);assert.equal((cx.threads || []).length,0);
 const parsed={keep:[{kind:'promise',text:'回家',subject:'character',when}],settle:[]};await c.api.applyThreads(cx,parsed,Date.now(),'app',items);assert.equal(wakes,1);const id=cx.threads[0].id;assert.equal(items[0].kind,'promise');
 await c.api.applyThreads(cx,parsed,Date.now(),'app',items);assert.equal(wakes,1);
 await c.api.applyThreads(cx,{keep:[{id,kind:'promise',text:'回家',subject:'character',when:when.slice(0,-2)+String((+when.slice(-2)+5)%60).padStart(2,'0')}],settle:[]},Date.now(),'app',items);assert.equal(wakes,2);assert.deepEqual(cancelled,['w1']);
 await c.api.applyThreads(cx,{keep:[{id,kind:'promise',status:'completed'}],settle:[]},Date.now(),'app',items);assert.equal(cx.threads[0].status,'completed');assert.ok(cancelled.includes('w2'));
 const incoming={id:'cloudp',kind:'promise',text:'一起吃饭',due:Date.now()+3600000,revision:1,subject:'both',at:Date.now()};
 const promise={kind:'promise',from:'cloudp',promiseRevision:1,wakeId:'cloudwake',act:true,time:'18:30',fireAt:incoming.due,source:'约定·一起吃饭'};
 cx.plan.items=[{time:'18:30',wakeId:'ordinary',kind:'extra',act:true,fireAt:incoming.due}];
 c.cloudPlan={plan_date:c.api.todayStr(),context:{threads:[incoming]},items:[promise],decisions:[]};
 c.api.setCloud(c.cloudPlan);
 assert.equal(await c.api.pullCloudDecisionsBody(cx,false),1);assert.equal(cx.plan.items.length,2);assert.equal(cx.plan.items.find(w=>w.wakeId==='ordinary').kind,'extra');
 assert.equal(await c.api.pullCloudDecisionsBody(cx,false),0);assert.equal(cx.plan.items.length,2);

});
console.log(`${n} promise/history checks passed`);
