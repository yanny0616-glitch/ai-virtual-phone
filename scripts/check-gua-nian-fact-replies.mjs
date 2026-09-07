import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const workerJs = stripTypeScriptTypes(read('supabase/functions/push-generate/index.ts'));
const at = hm => Date.parse(`2026-09-07T${hm}:00Z`);
function fixture() {
  const h = { now: at('10:15'), calls: [], outbox: [], mirrors: [], mirrorFails: false, answer: '还没问过的新事情。' };
  h.plan = { plan_date: '2026-09-07', context: { busyHold: 1, busyBufferMin: 10, busyMaxHoldMin: 180, presendMax: 100,
    day: { tz: 0, wake: '06:00', bed: '23:00', schedule: [{ time: '08:40', end: '11:50', title: '开会', busy: true }] } },
    decisions: [], items: [{ time: '10:15', fireAt: at('10:15'), until: at('10:45'), wakeId: 'w', act: true, intent: '昨晚拉肚子，现在好些了吗' }] };
  class Clock extends Date { constructor(...a) { super(...(a.length ? a : [h.now])); } static now() { return h.now; } }
  const rest = async (path, init = {}) => {
    const u = new URL('https://test/' + path), t = u.pathname.slice(1), body = init.body ? JSON.parse(init.body) : null;
    if (t === 'push_server_config') return Response.json([{cron_secret:'cron',payload_key:'test-key'}]);
    if (t === 'push_jobs') {
      if (init.method === 'PATCH') {
        if (u.searchParams.has('status') && h.job.status !== u.searchParams.get('status').slice(3)) return Response.json([]);
        if (u.searchParams.has('execute_at') && Date.parse(h.job.execute_at) > h.now) return Response.json([]);
        Object.assign(h.job, body);
      }
      return Response.json([h.job]);
    }
    if (t === 'push_recheck_plans') { if (init.method === 'PATCH') Object.assign(h.plan, body); return Response.json([h.plan]); }
    if (t === 'push_subscriptions') return Response.json([{ endpoint: 'shell:test' }]);
    if (t === 'push_chat_mirror') return h.mirrorFails ? new Response('', {status:503}) : Response.json(h.mirrors);
    if (t === 'push_outbox') { if(init.method === 'POST') h.outbox.push(...body); return Response.json([]); }
    return Response.json([]);
  };
  let handler;
  const c = vm.createContext({ console, Date: Clock, Response, Request, URL, Headers, AbortController, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, atob, btoa,
    setTimeout: () => 1, clearTimeout() {},
    Deno: { env: { get: k => k === 'SUPABASE_URL' ? 'https://test' : 'service' }, serve: fn => {handler = fn;} },
    fetch: async (url, init) => {
      if(url.includes('/rest/v1/')) return rest(url.split('/rest/v1/')[1], init);
      if(url === 'https://model.test') { h.calls.push(JSON.parse(init.body)); return Response.json({choices:[{message:{content:h.answer}}]}); }
      if(url.includes('/realtime/')) return Response.json({});
      throw Error('unexpected fetch: ' + url);
    },
  });
  vm.runInContext(workerJs + '\nglobalThis.api={encryptPayload,guanianWaitingChance,guanianRoll};',c);
  const init = async (mode = 'pass') => {
    let n=0; while ((c.api.guanianRoll('j'+n+':waiting') < 20) !== (mode === 'pass')) n++;
    h.job = { id:'j'+n,user_id:'u',kind:'timed_task',trigger_key:'timedwake:w',status:'pending',execute_at:new Clock().toISOString(),
      payload: await c.api.encryptPayload(JSON.stringify({request:{url:'https://model.test',headers:{},body:{messages:[]},providerKind:'openai-compatible'}, notify:{title:'角色',characterId:'c'},merge:{sessionId:'s',snapshotAt:new Date(at('09:00')).toISOString()}}),'test-key') };
  };
  const run = () => handler(new Request('https://test', {method:'POST', body:JSON.stringify({jobId:h.job.id,token:'cron'})}));
  return {h,c,init,run};
}
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
