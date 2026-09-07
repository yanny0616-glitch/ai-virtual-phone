import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
const code = stripTypeScriptTypes(fs.readFileSync(new URL('../../supabase/functions/push-recheck/index.ts', import.meta.url), 'utf8'));
export function recheckFixture() {
  const h = { now: Date.parse('2026-09-07T12:00Z'), calls: [], jobs: [], mirrors: [], outputs: [], result: { decisions: [], extra: [], keep: [], settle: [] } };
  h.plan = { state_version: 1, updated_at: '2026-09-07T10:00Z', session_id: 's', plan_date: '2026-09-07', judged_chat_at: h.now - 3600000,
    recheck_count: 0, context: { threads: [], day: { tz: 0, wake: '07:00', bed: '23:00', schedule: [] }, quota: 1, gateDailyCap: 100,
      gateGapMin: 0, gateFreshMin: 0, gateHorizonMin: 0, gateMinMsgs: 1, selfImpulseCap: 0, sentinelWakeId: 'sentinel', wakePrefix: 'app_', judgeTemplate: 'judge', minGapMin: 0, momentsOn: 0 }, items: [], decisions: [] };
  class Clock extends Date { constructor(...a) { super(...(a.length ? a : [h.now])); } static now() { return h.now; } }
  let handler;
  const c = vm.createContext({ console, Date: Clock, Response, Request, URL, Headers, TextEncoder, TextDecoder, Uint8Array, AbortController,
    crypto: webcrypto, setTimeout: () => 1, clearTimeout() {},
    Deno: { env: { get: () => 'https://test' }, serve: fn => handler = fn },
    fetch: async (url, init = {}) => {
      if (url === 'https://model.test') {
        h.calls.push(JSON.parse(init.body)); if (h.onModel) h.onModel();
        return h.modelFails ? new Response('', { status: 503 }) : Response.json({ choices: [{ message: { content: JSON.stringify(h.result) } }] });
      }
      const u = new URL(url), table = u.pathname.split('/').at(-1), body = init.body ? JSON.parse(init.body) : null;
      if (table === 'push_server_config') return Response.json([{ cron_secret: 'secret', payload_key: 'key' }]);
      if (table === 'push_chat_mirror') return h.historyFails ? new Response('', { status: 503 }) : Response.json(h.mirrors);
      if (table === 'push_outbox') return Response.json(h.outputs);
      if (table === 'push_recheck_plans') {
        if (init.method === 'PATCH') {
          if (h.onPatch) h.onPatch(body);
          if (u.searchParams.has('state_version') && +u.searchParams.get('state_version').slice(3) !== h.plan.state_version) return Response.json([]);
          if (u.searchParams.has('updated_at') && u.searchParams.get('updated_at').slice(3) !== h.plan.updated_at) return Response.json([]);
          const changed = ['context', 'items', 'decisions'].some(k => k in body && JSON.stringify(body[k]) !== JSON.stringify(h.plan[k]));
          Object.assign(h.plan, body); if (changed) h.plan.state_version++;
        } else if (u.searchParams.get('select')?.includes('state_version') && h.onRefresh) { h.onRefresh(); h.onRefresh = null; }
        return Response.json([h.plan]);
      }
      if (table === 'push_jobs') {
        if (init.method === 'POST') { h.jobs.push(...body); return Response.json(body); }
        if (init.method === 'PATCH') { for (const j of h.jobs) if (j.status === 'pending') Object.assign(j, body); return Response.json(h.jobs); }
        return Response.json(h.noTemplate ? [] : [{ trigger_key: 'timedwake:sentinel', payload: 'template', status: 'pending' }, { trigger_key: 'judge', payload: 'template', status: 'pending' }]);
      }
      if (table === 'push_recheck_judge') { if (body.p_action === 'claim') h.plan.judge_token = body.p_token; return Response.json({ claimed: true }); }
      if (table === 'push_cancel_stale_promises') return Response.json(0);
      if (table === 'push_arm_promise') { h.plan.items.push(body.p_item); h.plan.state_version++; return Response.json(true); }
      throw Error('unexpected request ' + url);
    },
  });
  vm.runInContext(code + `
    lifeRoll=()=>null;feedbackWithPreviousDay=async()=>null;usageBudget=async()=>({tz:0});usageExceeded=()=>"";usageAdd=async()=>{};
    decryptPayload=async()=>JSON.stringify({request:{url:"https://model.test",headers:{},providerKind:"openai-compatible",body:{messages:[{role:"user",content:"__CUSTOM_APP_INSTRUCTION__"}]}},merge:{sessionId:"s"},notify:{title:"角色"}});
    encryptPayload=async text=>({ct:text});
  `, c);
  const run = () => handler(new Request('https://test', { method: 'POST', body: JSON.stringify({ token: 'secret', userId: 'u', characterId: 'c', planDate: '2026-09-07' }) }));
  return { h, run };
}
