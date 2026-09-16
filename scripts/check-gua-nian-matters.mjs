import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
import * as matters from '../custom-apps/gua-nian/src/domain/matters.mjs';
import { promiseNeedsTask } from '../custom-apps/gua-nian/src/domain/promises.mjs';
import { fixture, at } from './lib/gua-nian-worker-fixture.mjs';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const now = at('10:15');
const ordinary = { wakeId: 'old', fireAt: at('19:30'), act: true, kind: 'extra', intent: '晚上回复那个问题' };
const promise = { id: 'p1', kind: 'promise', text: '晚点给一个答案', due: at('20:00'), revision: 1 };
const promised = { wakeId: 'promised', fireAt: promise.due, act: true, kind: 'promise', from: 'p1' };
const sent = { id: 'output', trigger_key: 'timedwake:old', created_at: new Date(at('10:00')).toISOString(), raw_text: '这是我的答案。' };
{
 const before = JSON.stringify([ordinary, promise, promised, sent]);
 const prepared = matters.prepareMatters([ordinary, promised], [promise], [], {
  links: [{ itemId: 'wake:old', matterId: 'thread:p1' }],
  extra: [{ matterId: 'thread:p1', time: '21:00' }], keep: [],
 }, now);
 assert.match(matters.matterBlock(prepared.items[0], prepared.items, prepared.threads, [], []), /明确约定/);
 assert.equal(matters.matterBlock(prepared.items[1], prepared.items, prepared.threads, [], []), '');
 assert.match(matters.matterBlock({ ...prepared.extra[0], act: true }, prepared.items, prepared.threads, [], []), /明确约定/);
 assert.equal(JSON.stringify([ordinary, promise, promised, sent]), before, 'no inputs mutated');
 const outputOnly = { ...sent, trigger_key: 'timedwake:missing', meta: { guanianContext: { matterId: 'thread:p1' } } };
 assert.match(matters.matterBlock(prepared.items[1], prepared.items, prepared.threads, [outputOnly], []), /已发过/);
 const candidate = { matterId: 'wake:old', matterRelation: 'followup', matterEvidenceId: 'new', fireAt: at('19:00'), act: true };
 for (const msg of [[], [{ id: 'new', role: 'user', t: at('09:59') }], [{ id: 'new', role: 'assistant', t: at('10:01') }]]) {
  assert.match(matters.matterBlock(candidate, [ordinary], [], [sent], msg), /已发过/);
 }
 assert.equal(matters.matterBlock(candidate, [ordinary], [], [sent], [{ id: 'new', role: 'user', t: at('10:01') }]), '');
 assert.equal(matters.matterBlock(candidate, [ordinary], [], [sent], [{ id: 'new', role: 'assistant', media_type: 'offline_summary', t: at('10:01') }]), '');
 assert.match(matters.matterBlock(candidate, [ordinary], [], [], []), /待发送/, 'an earlier proposed time cannot steal an existing reservation');
 assert.equal(matters.prepareMatters([], [], [], { extra: [{}, { matterId: 'invented' }] }, now).extra.length, 0);
 const both = matters.prepareMatters([], [], [], { keep: [{ kind: 'promise', matterId: 'new:1' }], extra: [{ matterId: 'new:1' }] }, now);
 assert.equal(both.keep[0].matterId, both.extra[0].matterId);
 assert.equal(promiseNeedsTask(promise, [{ ...promised, act: false, matterSuppressed: true }], now, at('23:59')), false);
 assert.equal(promiseNeedsTask({ ...promise, revision: 2 }, [{ ...promised, promiseRevision: 1, act: false, matterSuppressed: true }], now, at('23:59')), true);
 console.log('PASS pure identities, priority, evidence timestamps/speaker, missing IDs, same-result IDs and suppression');
}
// Real generation worker: programmatic duplicate gates cannot be bypassed by a model answer.
for (const mode of ['promise-owner', 'already-sent', 'new-progress', 'during-generation']) {
 const { h, init, run } = fixture(); await init(); h.plan.context.day.schedule = [];
 h.plan.items[0].matterId = 'thread:p1';
 if (mode === 'promise-owner') h.plan.context.threads = [{ ...promise, matterId: 'thread:p1' }];
 if (mode === 'already-sent' || mode === 'new-progress') {
  h.outbox.push({ ...sent, job_id: 'other', trigger_key: 'timedwake:earlier', meta: { guanianContext: { matterId: 'thread:p1' } } });
 }
 if (mode === 'new-progress') {
  h.plan.items[0].matterRelation = 'followup'; h.plan.items[0].matterEvidenceId = 'new';
  h.mirrors = [{ id: 'new', role: 'user', content: '情况变了，有个新问题', message_at: new Date(at('10:05')).toISOString() }];
 }
 if (mode === 'during-generation') h.onModel = () => { h.plan.items[0].matterSuppressed = true; };
 const before = h.outbox.length; await run();
 if (mode === 'new-progress') {
  assert.equal(h.outbox.length, before + 1); assert.equal(h.outbox.at(-1).meta.guanianContext.matterId, 'thread:p1');
 } else {
  assert.equal(h.outbox.length, before); assert.match(h.job.result_note, /guanian skip:/);
  assert.equal(h.calls.length, mode === 'during-generation' ? 1 : 0);
 }
 console.log('PASS real sender ' + mode);
}
// Real cloud recheck with generated model results, including differently worded legacy slots.
const source = stripTypeScriptTypes(read('supabase/functions/push-recheck/index.ts'));
for (const mode of ['legacy-duplicates', 'sent-again', 'fresh-progress', 'new-promise-and-extra', 'missing-identity']) {
 let handler; const armed = [], prompts = [];
 const threads = mode === 'legacy-duplicates' ? [promise] : [];
 const plan = { state_version: 1, plan_date: '2026-09-07', session_id: 's', updated_at: 'v1', judged_chat_at: at('09:00'),
  context: { threads, day: { tz: 0, energy: 70, schedule: [] }, quota: 4, minGapMin: 0, gateGapMin: 0, gateFreshMin: 0, gateHorizonMin: 0, gateMinMsgs: 1,
   judgeTemplate: 'judge', sentinelWakeId: 'sentinel', wakePrefix: 'app_', momentsOn: 0 },
  items: mode === 'legacy-duplicates' ? [{ ...ordinary }, { ...promised }] : mode === 'new-promise-and-extra' || mode === 'missing-identity' ? [] : [{ ...ordinary, fireAt: at('09:59') }], decisions: [] };
 const outputs = ['sent-again', 'fresh-progress'].includes(mode) ? [sent] : [];
 const messages = [{ id: 'new', role: 'user', content: '补充一件新事情', message_at: new Date(at('10:05')).toISOString() }];
 const result = { decisions: [], keep: [], settle: [], extra: [], links: [] };
 if (mode === 'legacy-duplicates') result.links = [{ itemId: 'wake:old', matterId: 'thread:p1' }];
 if (mode === 'new-promise-and-extra') {
  result.keep = [{ kind: 'promise', subject: 'user', text: '回头告诉你结果', when: '2026-09-07 20:00', sourceMessageId: 'new', matterId: 'new:1' }];
  result.extra = [{ time: '19:30', about: '再问结果', intent: '问一下结果', matterId: 'new:1', relation: 'new' }];
 } else if (mode !== 'legacy-duplicates') result.extra = [{ time: '19:30', about: '新说法', intent: '再问一下',
  ...(mode === 'missing-identity' ? {} : { matterId: 'wake:old', relation: mode === 'fresh-progress' ? 'followup' : 'same', sourceMessageId: 'new' }) }];
 class Clock extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
 const rest = async (url, init = {}) => {
  if (url === 'https://model.test') { prompts.push(JSON.parse(init.body)); return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] }); }
  const table = new URL(url).pathname.split('/').at(-1), body = init.body ? JSON.parse(init.body) : null;
  if (table === 'push_server_config') return Response.json([{ cron_secret: 'secret', payload_key: 'key' }]);
  if (table === 'push_chat_mirror') return Response.json(messages);
  if (table === 'push_outbox') return Response.json(outputs);
  if (table === 'push_recheck_plans') { if (init.method === 'PATCH') Object.assign(plan, body); return Response.json([plan]); }
  if (table === 'push_jobs') {
   if (init.method === 'POST') { armed.push(...body); return Response.json([]); }
   return Response.json([{ trigger_key: 'timedwake:sentinel', payload: 'template', status: 'pending' }, { trigger_key: 'judge', payload: 'template', status: 'pending' }]);
  }
  if (table === 'push_recheck_judge') return Response.json({ claimed: true });
  if (table === 'push_cancel_stale_promises') return Response.json(0);
  if (table === 'push_arm_promise') { plan.items.push(body.p_item); return Response.json(true); }
  throw Error('unexpected: ' + url);
 };
 const c = vm.createContext({ console, Date: Clock, Response, Request, URL, Headers, AbortController, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto,
  setTimeout: () => 1, clearTimeout() {}, Deno: { env: { get: () => 'https://test' }, serve: f => handler = f }, fetch: rest });
 vm.runInContext(source + `
 lifeRoll=()=>null; feedbackWithPreviousDay=async()=>null; usageBudget=async()=>({tz:0}); usageExceeded=()=>''; usageAdd=async()=>{};
 decryptPayload=async()=>JSON.stringify({merge:{sessionId:'s'},notify:{title:'角色'},request:{providerKind:'openai-compatible',url:'https://model.test',headers:{},body:{messages:[{role:'user',content:'__CUSTOM_APP_INSTRUCTION__'}]}}});
 encryptPayload=async p=>({v:1,ct:p});`, c);
 const response = await handler(new Request('https://test', { method: 'POST', body: JSON.stringify({ token: 'secret', userId: 'u', characterId: 'c', planDate: '2026-09-07' }) }));
 assert.equal(response.status, 200, mode); assert.equal(prompts.length, 1);
 assert.match(JSON.stringify(prompts[0]), /事项去重/);
 if (mode === 'legacy-duplicates') { assert.equal(plan.items.find(w => w.wakeId === 'old').act, false); assert.equal(plan.items.find(w => w.wakeId === 'promised').act, true); }
 if (mode === 'new-promise-and-extra') { assert.equal(plan.items.filter(w => w.act).length, 1); assert.equal(plan.items.find(w => w.act).kind, 'promise'); }
 assert.equal(armed.length, mode === 'fresh-progress' ? 1 : 0, mode);
 if (outputs.length) assert.match(JSON.stringify(prompts[0]), /这是我的答案/);
 console.log('PASS real cloud recheck ' + mode);
}
// Real app recheck: same rules, apply promises before extra, cloud read errors fail closed.
const bundle = read('custom-apps/gua-nian/index.html').match(/<script>([\s\S]*)<\/script>/)[1];
for (const mode of ['legacy-duplicates', 'sent-again', 'fresh-progress', 'new-promise-and-extra', 'history-failed']) {
 const h = { armed: [], cancelled: [], logs: [], calls: [] };
 const result = { decisions: [], keep: [], settle: [], extra: [], links: [] };
 if (mode === 'legacy-duplicates') result.links = [{ itemId: 'wake:old', matterId: 'thread:p1' }];
 if (mode === 'new-promise-and-extra') {
  result.keep = [{ kind: 'promise', subject: 'user', text: '回头告诉你结果', when: '2026-09-07 20:00', sourceMessageId: 'new', matterId: 'new:1' }];
  result.extra = [{ time: '19:30', intent: '再问结果', matterId: 'new:1', relation: 'new' }];
 } else if (mode !== 'legacy-duplicates') result.extra = [{ time: '19:30', intent: '再问一下', matterId: 'wake:old', relation: mode === 'fresh-progress' ? 'followup' : 'same', sourceMessageId: 'new' }];
 class Clock extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
 const c = vm.createContext({ console, Date: Clock, URLSearchParams, setTimeout: () => 1, clearTimeout() {}, at, h, result,
  AiPhone: { push: { cancelWake: async id => { h.cancelled.push(id); return { ok: true }; }, wake: async args => { h.armed.push(args); return { id: 'armed-' + h.armed.length, armed: true }; } } } });
 vm.runInContext(bundle.replace(/  init\(\);\s*\}\)\(\);\s*$/, `
 globalThis.api={S,recheck,ctxOf};
 owns=()=>true; usageOver=()=>''; cloudRecheckOn=()=>false; cloudCfg=()=>({url:'https://test'}); cloudSessionId=async()=> 's';
 pullCloudDecisionsBody=async()=>false; uploadPlanCloud=async()=>{}; render=()=>{}; toast=()=>{};
 upsert=async(table,_find,data)=>table==='plans'?Object.assign(globalThis.cx.plan,data):data;
 log=async(_cx,text)=>h.logs.push(text); readRecentChat=async()=>[{id:'new',role:'user',t:at('10:05'),c:'新进展'}];
 generateJson=async(_cx,request)=>{h.calls.push(request);return JSON.parse(JSON.stringify(result));};
 unansweredStreak=()=>0; moCanPost=()=>false; biasText=()=>''; energyAt=()=>70; syncChatContext=async()=>{}; applyChatSchedEdits=async()=>{};
 parseWhen=value=>value?Date.parse(value.replace(' ','T')+'Z'):0;
 timeToMs=hm=>/^\\d{2}:\\d{2}$/.test(hm)?at(hm):null; inQuiet=()=>false; asleepAt=()=>false; calcScore=()=>({});
 cloudFetchBounded=async()=>{if(globalThis.failHistory)throw Error('history offline');return {sessionId:'s',entries:globalThis.outputs};};
 })();`), c);
 const api = c.api;
 api.S.settings = { threadsOn: true, threadDays: 3, recheckMin: 1, chatCandidates: true, quota: 4, maxUnanswered: 0 };
 c.cx = api.ctxOf({ id: 'c', name: '角色' });
 c.cx.day = { mood: '平静', schedule: [] };
 c.cx.threads = mode === 'legacy-duplicates' ? [{ ...promise }] : [];
 c.cx.plan = { date: '2026-09-07', plannedAt: at('09:00'), items: mode === 'legacy-duplicates' ? [{ ...ordinary }, { ...promised }] : mode === 'new-promise-and-extra' ? [] : [{ ...ordinary, fireAt: at('09:59') }] };
 c.outputs = ['sent-again', 'fresh-progress'].includes(mode) ? [sent] : []; c.failHistory = mode === 'history-failed';
 await api.recheck(c.cx, 'test');
 assert.equal(h.calls.length, mode === 'history-failed' ? 0 : 1, h.logs.join('\n'));
 assert.equal(h.armed.length, ['fresh-progress', 'new-promise-and-extra'].includes(mode) ? 1 : 0, h.logs.join('\n'));
 if (mode === 'legacy-duplicates') { assert.equal(c.cx.plan.items.find(w => w.wakeId === 'old').act, false); assert.ok(h.cancelled.includes('old')); }
 if (mode === 'new-promise-and-extra') assert.equal(c.cx.plan.items.filter(w => w.act).length, 1);
 assert.equal(c.cx._planLock, false);
 console.log('PASS real app recheck ' + mode);
}
