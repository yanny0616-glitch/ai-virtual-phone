// Actual generation worker and personal gateway, with controlled REST/model fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { fixture } from './lib/gua-nian-worker-fixture.mjs';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const prefix = 'timed_wake_capp_app_gua.nian_01dda58254d4_';
async function setup() {
  const f = fixture(); await f.init();
  f.h.plan.context.day.schedule = [];
  f.h.plan.context.minGapMin = 60;
  f.h.plan.items[0].wakeId = prefix + '123_abc';
  f.h.job.trigger_key = 'timedwake:' + f.h.plan.items[0].wakeId;
  f.h.outbox.push({ id: 'previous', job_id: 'other', trigger_key: 'timedwake:previous', session_id: 's', raw_text: '醒了没', created_at: new Date(f.h.now - 5000).toISOString() });
  f.h.answer = '醒了没';
  return f;
}
for (const missing of [false, true]) {
  const { h, run } = await setup();
  if (missing) h.plan.items = [];
  await run();
  assert.equal(h.calls.length, 0); assert.equal(h.outbox.length, 1);
  assert.match(h.job.result_note, missing ? /未找到有效计划/ : /等待主动消息间隔/);
  console.log('PASS ' + (missing ? 'orphan wake stops instead of bypassing spacing' : 'associated wake respects spacing'));
}
{
  const { h, run } = await setup(); h.planRows = []; await run();
  assert.equal(h.calls.length, 0); assert.match(h.job.result_note, /未找到有效计划/);
  console.log('PASS deleted plans do not permit old Gua Nian wakes');
}
{
  const { h, run } = await setup(); h.planReadFails = true; await run();
  assert.equal(h.calls.length, 0); assert.equal(h.job.status, 'pending');
  assert.match(h.job.result_note, /计划读取失败/);
  console.log('PASS network failure retries instead of treating plan as deleted');
}
{
  const { h, run } = await setup();
  h.job.trigger_key = 'timedwake:' + prefix + 'sentinel_123_abc';
  h.plan.items[0].wakeId = h.job.trigger_key.slice(10); // Even erroneous plan membership cannot make a template send.
  await run(); assert.equal(h.calls.length, 0); assert.match(h.job.result_note, /后台模板/);
  console.log('PASS explicit template identity never generates, even with matching plan item');
}
{
  const { h, run } = await setup();
  h.planRows = [h.plan, { plan_date: '2026-09-06', context: { sentinelWakeId: h.job.trigger_key.slice(10) }, items: [] }];
  await run(); assert.equal(h.calls.length, 0); assert.match(h.job.result_note, /后台模板/);
  console.log('PASS old sentinel is recognized across historical plan rows');
}
{
  const { h, run } = await setup(); h.outbox = [];
  h.onModel = () => { h.plan.items = []; };
  await run(); assert.equal(h.calls.length, 1); assert.equal(h.outbox.length, 0);
  assert.match(h.job.result_note, /撤销或替换/);
  console.log('PASS plan removal during generation stops delivery');
}
{
  const { h, run } = await setup(); h.outbox = [];
  await run(); assert.equal(h.calls.length, 1); assert.equal(h.outbox.length, 1);
  console.log('PASS valid ordinary Gua Nian wake still generates');
}
{
  const { h, run } = await setup(); h.plan.items = [];
  h.job.trigger_key = 'timedwake:timed_wake_capp_other_123_abc';
  await run(); assert.equal(h.calls.length, 1);
  console.log('PASS unrelated app wake keeps existing behavior');
}

// Execute the actual local timed-wake function with template schedules: no model call or session access.
const storage = stripTypeScriptTypes(read('lib/timed-wake-storage.ts')).replace(/^import.*;$/gm, '').replace(/^export /gm, '');
const followup = read('lib/follow-up-service.ts');
const fire = stripTypeScriptTypes(followup.slice(followup.indexOf('async function fireTimedWake('), followup.indexOf('async function fireMenstrualPeriodCare(')));
let removed = 0, cancelled = 0;
const local = vm.createContext({ console, registerKvMigration() {},
  timedWakeFiringSet: new Set(), backgroundGeneratingSessions: new Set(["s"]), cancelledBackgroundSessions: new Set(["s"]),
  cancelBailoutKey() { cancelled++; }, loadChatSessions() { throw Error('template entered local generation'); },
  pushChatMessage() { assert.fail('template should not fail into chat'); },
});
vm.runInContext(storage + '\nremoveTimedWakeSchedule=()=>globalThis.removed();\n' + fire + ';globalThis.testWake=fireTimedWake;', local);
local.removed = () => { removed++; };
for (const schedule of [
  { id: prefix + 'sentinel_123_abc', intent: 'template' },
  { id: prefix + '123_abc', intent: '已经两天没在挂念里排过日程了，忽然想起用户，随口问候一句就好' },
  { id: prefix + '123_def', intent: '挂念后台复核模板，仅供后台调用，不生成聊天消息' },
]) await local.testWake({ ...schedule, sessionId: 's' });
assert.equal(removed, 3); assert.equal(cancelled, 3);
assert.ok(local.backgroundGeneratingSessions.has('s')); assert.ok(local.cancelledBackgroundSessions.has('s'));
assert.equal(local.timedWakeFiringSet.size, 0);
console.log('PASS local generation blocks explicit and legacy sentinels');
// Actual host registration gives templates a durable ID; ordinary tasks cloned from its prefix remain ordinary.
const host = read('lib/custom-app-host-api.ts');
const scheduleCode = stripTypeScriptTypes(host.slice(host.indexOf('export async function scheduleCustomAppTimedWake('), host.indexOf('// push.freeze：'))).replace(/^export /gm, '');
Object.assign(local, {
  cleanText: (s, n) => String(s || '').slice(0, n), CUSTOM_APP_TIMED_WAKE_MIN_DELAY_MS: 60000,
  CUSTOM_APP_TIMED_WAKE_MAX_DELAY_MS: 7 * 86400000, CUSTOM_APP_TIMED_WAKE_MAX_PENDING: 24,
  loadCharacters: () => [{id:'c'}], loadChatContacts: () => [{characterId:'c'}],
  createOrGetSession: () => ({id:'s'}), armTimedWakeBailout: async () => ({ok:true}),
  emitHostStateUpdated() {}, customAppTimedWakePrefix: id => 'timed_wake_capp_' + id + '_',
});
local.localWrites = 0;
vm.runInContext('loadTimedWakeSchedules=()=>[];saveTimedWakeSchedule=()=>{globalThis.localWrites++;};\n' + scheduleCode + ';globalThis.registerWake=scheduleCustomAppTimedWake;', local);
for (const intent of ['已经两天没在挂念里排过日程了，忽然想起用户，随口问候一句就好', '挂念后台复核模板，仅供后台调用，不生成聊天消息']) {
  const registered = await local.registerWake({id:'app_gua.nian_01dda58254d4'}, {characterId:'c', intent, fireAt:Date.now()+48*3600000});
  assert.match(registered.id, /_sentinel_\d+_/);
}
assert.equal(local.localWrites, 0, 'templates must not replace local ordinary schedules');
const ordinary = await local.registerWake({id:'app_gua.nian_01dda58254d4'}, {characterId:'c', intent:'按约定问候', fireAt:Date.now()+3600000});
assert.doesNotMatch(ordinary.id, /_sentinel_/);
assert.equal(local.localWrites, 1);
console.log('PASS actual host registers both legacy and new template intents with dedicated identity');


let handler, failRead = false; const paths = [];
vm.runInNewContext(stripTypeScriptTypes(read('supabase/functions/ai-phone-push/index.ts')), {
  console, Date, Request, Response, URL, Headers, AbortSignal,
  Deno: { env: { get: k => ({ SUPABASE_URL: 'https://test', SUPABASE_SERVICE_ROLE_KEY: 'test' })[k] }, serve: fn => { handler = fn; } },
  fetch: async (url, init = {}) => {
    paths.push({ url, method: init.method || 'GET' });
    if (url.includes('push_outbox')) return failRead ? new Response('', { status: 503 }) : Response.json([
      { id: 'out', job_id: 'old-job', session_id: 's', trigger_key: 'timedwake:' + prefix + '123_abc', raw_text: '醒了没', consumed_at: '2026-09-08T00:00:00Z' },
      { id: 'wrong-session', session_id: 'other', trigger_key: 'timedwake:' + prefix + '123_abc' },
      { id: 'wrong-app', session_id: 's', trigger_key: 'timedwake:other' },
    ]);
    return Response.json([]);
  },
});
const history = session => handler(new Request('https://test?action=guanian-history&sessionId=' + encodeURIComponent(session), { headers: { 'x-ai-phone-service-key': 'test' } }));
let response = await history('s'); assert.equal(response.status, 200);
const data = await response.json(); assert.equal(data.entries.length, 1); assert.equal(data.entries[0].id, 'out');
assert.ok(data.entries[0].consumed_at);
assert.ok(paths.every(p => p.method === 'GET')); assert.ok(paths.some(p => p.url.includes('user_id=eq.owner')));
assert.ok(paths.every(p => !p.url.includes('consumed_at=is.null')));
assert.equal((await history('s&session_id=other')).status, 400);
assert.equal((await handler(new Request('https://test?action=guanian-history&sessionId=s'))).status, 401);
failRead = true; assert.equal((await history('s')).status, 503);
console.log('PASS history includes consumed orphan output, isolates sessions, remains authenticated/read-only, and reports failures');
