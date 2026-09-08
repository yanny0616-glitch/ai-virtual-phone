import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
const read = p => fs.readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const workerJs = stripTypeScriptTypes(read('supabase/functions/push-generate/index.ts'));
export const at = hm => Date.parse(`2026-09-07T${hm}:00Z`);
export function fixture() {
  const h = { now: at('10:15'), calls: [], outbox: [], mirrors: [], mirrorFails: false, answer: '还没问过的新事情。' };
  h.plan = { state_version: 1, plan_date: '2026-09-07', context: { busyHold: 1, busyBufferMin: 10, busyMaxHoldMin: 180, presendMax: 100,
    day: { tz: 0, wake: '06:00', bed: '23:00', schedule: [{ time: '08:40', end: '11:50', title: '开会', busy: true }] } },
    decisions: [], items: [{ time: '10:15', fireAt: at('10:15'), until: at('10:45'), wakeId: 'w', act: true, intent: '昨晚拉肚子，现在好些了吗' }] };
  class Clock extends Date { constructor(...a) { super(...(a.length ? a : [h.now])); } static now() { return h.now; } }
  const rest = async (path, init = {}) => {
    const u = new URL('https://test/' + path), t = u.pathname.slice(1), body = init.body ? JSON.parse(init.body) : null;
    if (t === 'rpc/push_append_recheck_decision') { h.plan.decisions.push(body.p_entry); return Response.json(null); }
    if (t === 'rpc/push_generation_lease' && h.leaseMissing) return new Response('', {status:404});
    if (t === 'rpc/push_generation_lease') return Response.json(h.leaseAvailable !== false);
    if (t === 'push_server_config') return Response.json([{cron_secret:'cron',payload_key:'test-key'}]);
    if (t === 'push_jobs') {
      if (init.method === 'PATCH') {
        if (u.searchParams.has('status') && h.job.status !== u.searchParams.get('status').slice(3)) return Response.json([]);
        if (u.searchParams.has('execute_at') && Date.parse(h.job.execute_at) > h.now) return Response.json([]);
        Object.assign(h.job, body);
      }
      return Response.json([h.job]);
    }
    if (t === 'push_recheck_plans') { if(h.planReadFails && !init.method) return new Response('',{status:503}); if (init.method === 'PATCH') Object.assign(h.plan, body); return Response.json(h.planRows || [h.plan]); }
    if (t === 'push_subscriptions') return Response.json([{ endpoint: 'shell:test' }]);
    if (t === 'push_chat_mirror') return h.mirrorFails ? new Response('', {status:503}) : Response.json(h.mirrors);
    if (t === 'push_outbox') { if(init.method === 'POST' && h.outboxWriteFails) return new Response('',{status:503}); if(init.method === 'POST') h.outbox.push(...body.map(o=>({...o,created_at:o.created_at||new Clock().toISOString()}))); if(h.outboxFails) return new Response('',{status:503}); return Response.json(init.method === 'POST' ? [] : h.outbox.filter(o => !u.searchParams.has('job_id') || o.job_id === u.searchParams.get('job_id').slice(3)));  }
    return Response.json([]);
  };
  let handler;
  const c = vm.createContext({ console, Date: Clock, Response, Request, URL, Headers, AbortController, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, atob, btoa,
    setTimeout: () => 1, clearTimeout() {},
    Deno: { env: { get: k => k === 'SUPABASE_URL' ? 'https://test' : 'service' }, serve: fn => {handler = fn;} },
    fetch: async (url, init) => {
      if(url.includes('/rest/v1/')) return rest(url.split('/rest/v1/')[1], init);
      if(url === 'https://model.test') { if(h.onModel) await h.onModel(); h.calls.push(JSON.parse(init.body)); return Response.json({choices:[{message:{content:h.answer}}]}); }
      if(url.includes('/realtime/')) return Response.json({});
      throw Error('unexpected fetch: ' + url);
    },
  });
  vm.runInContext(workerJs + '\nglobalThis.api={encryptPayload,decryptPayload,guanianWaitingChance,guanianRoll};',c);
  const init = async (mode = 'pass') => {
    let n=0; while ((c.api.guanianRoll('j'+n+':waiting') < 20) !== (mode === 'pass')) n++;
    h.job = { id:'j'+n,user_id:'u',kind:'timed_task',trigger_key:'timedwake:w',status:'pending',execute_at:new Clock().toISOString(),
      payload: await c.api.encryptPayload(JSON.stringify({request:{url:'https://model.test',headers:{},body:{messages:[]},providerKind:'openai-compatible'}, notify:{title:'角色',characterId:'c'},merge:{sessionId:'s',snapshotAt:new Date(at('09:00')).toISOString()}}),'test-key') };
  };
  const run = () => handler(new Request('https://test', {method:'POST', body:JSON.stringify({jobId:h.job.id,token:'cron'})}));
  return {h,c,init,run};
}