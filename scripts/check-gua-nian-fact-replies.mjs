import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fixture, at } from './lib/gua-nian-worker-fixture.mjs';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

{
 const {h,c,init,run}=fixture(); await init();
 assert.equal(c.api.guanianWaitingChance(at('13:15'),at('10:15'),180),0.5);
 assert.equal(c.api.guanianWaitingChance(at('16:15'),at('10:15'),180),0.25);
 await run(); assert.equal(h.calls.length,0); assert.equal(h.job.status,'pending');
 assert.ok(Date.parse(h.job.execute_at) > at('11:50')); assert.ok(Date.parse(h.job.execute_at) > h.plan.items[0].until);
 h.now=Date.parse(h.job.execute_at); await run(); assert.equal(h.calls.length,1); assert.equal(h.outbox.length,1);
 assert.match(h.job.result_note,/generated/); await run(); assert.equal(h.calls.length,1);
 console.log('PASS busy waits beyond old expiry; free opportunity decays without hard cutoff; one delivery');
}
{
 const {h,init,run}=fixture(); await init(); h.plan.context.day.schedule=[];
 h.mirrors=[{role:'assistant',content:'今天肚子好些了吗？',message_at:new Date(at('10:00')).toISOString()},{role:'user',content:'好多了',message_at:new Date(at('10:01')).toISOString()}];
 h.answer='[挂念作罢：聊天已提过]'; await run();
 assert.equal(h.outbox.length,0); assert.match(h.job.result_note,/聊天已提过/);
 assert.match(JSON.stringify(h.calls[0]),/好多了/); assert.match(JSON.stringify(h.calls[0]),/按实际问答与语义判断/);
 assert.ok(h.plan.decisions.some(d=>d.kind==='factcheck' && d.blocked));
 console.log('PASS semantic skip uses newest conversation, no outbox or message on abandonment');
}
{
 const {h,init,run}=fixture(); await init('fail'); h.now=at('20:15'); h.plan.context.day.schedule=[]; await run();
 assert.equal(h.calls.length,0); assert.match(h.job.result_note,/念头淡去了/);
 console.log('PASS time lowers probability at an opportunity, no repeated API sampling');
}
{
 const {h,init,run}=fixture(); await init(); h.plan.context.day.schedule=[]; h.mirrorFails=true; await run();
 assert.equal(h.calls.length,0); assert.equal(h.job.status,'pending'); assert.match(h.job.result_note,/读取失败/);
 console.log('PASS missing fresh facts defers rather than repeating stale questions');
}
{
 const {h,init,run}=fixture(); await init(); h.plan.items[0].act=false; await run();
 assert.equal(h.calls.length,0); assert.equal(h.outbox.length,0);
 console.log('PASS a cancelled thought cannot send');
}
{
 const raw=read('custom-apps/gua-nian/index.html').match(/<script>([\s\S]*)<\/script>/)[1];
 const c=vm.createContext({console,Date,URLSearchParams});
 vm.runInContext(raw.replace(/  init\(\);\s*\}\)\(\);\s*$/, '\n globalThis.api={S,ctxOf,decStatus,wakeRow,panelPulse};\n})();'),c);
 const a=c.api; a.S.settings={cloudUrl:'https://test',cloudKey:'test',quota:4};a.S.cur='c';
 const cx=a.ctxOf({id:'c',name:'角色'});a.S.byId.c=cx;cx._receiptSource='https://test';
 const slot={time:'10:15',fireAt:Date.now()-3600000,act:true,wakeId:'w',intent:'关心',delivery:'push'};
 cx.plan={items:[slot]};cx._receipts={w:{checkedAt:Date.now(),job:{status:'done',resultNote:'guanian skip: 聊天已提过'}}};
 assert.equal(a.decStatus(slot).status,'skipped');
 assert.match(a.wakeRow(slot,true,'关心',''),/未发送/);assert.doesNotMatch(a.wakeRow(slot,true,'关心',''),/已想起你/);
 const panel=a.panelPulse({now:Date.now(),settings:a.S.settings,plan:cx.plan});
 assert.match(panel,/<div class="num">0<\/div><div class="cap">已发出/);
 assert.match(panel,/<div class="num">1<\/div><div class="cap">作 罢/);
 console.log('PASS timeline and counts follow the same terminal receipt as details');
}
