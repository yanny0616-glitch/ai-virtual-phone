import assert from 'node:assert/strict';
import { recheckFixture } from './lib/gua-nian-recheck-fixture.mjs';
import { fixture, at } from './lib/gua-nian-worker-fixture.mjs';
const say = (h, role, content) => h.mirrors.push({ id: 'm' + h.mirrors.length, role, content, message_at: new Date(h.now - 60000).toISOString() });
{
  const { h, run } = recheckFixture(); say(h, 'assistant', '粥在锅里，醒了自己热'); await run();
  assert.equal(h.calls.length, 0); console.log('PASS assistant output alone cannot trigger ordinary judgement');
}
{
  const { h, run } = recheckFixture(); say(h, 'assistant', '我三点半回家');
  h.result = { keep: [{ kind: 'promise', subject: 'character', text: '回家', when: '2026-09-07 15:30' }], extra: [{ time: '12:15', intent: '追问醒了没' }], decisions: [] };
  await run(); assert.equal(h.calls.length, 1); assert.equal(h.jobs.length, 0); assert.equal(h.plan.context.threads[0].kind, 'promise');
  await run(); assert.equal(h.calls.length, 1); console.log('PASS assistant promise is recorded once, without the model-suggested ordinary extra');
}
{
  const { h, run } = recheckFixture(); say(h, 'user', '等会儿接着聊这件事');
  h.plan.items = [1,2,3].map(n => ({ kind: 'promise', act: true, time: '13:00', fireAt: h.now + 3600000, wakeId: 'p'+n }));
  h.result.extra = [{ time: '12:15', intent: '接着聊刚才的话题' }]; await run();
  assert.equal(h.jobs.length, 1); assert.equal(h.plan.items.filter(w => w.kind === 'extra').length, 1);
  console.log('PASS promises do not consume ordinary quota or spacing');
}
{
  const { h, run } = recheckFixture(); say(h, 'user', '好');
  h.onRefresh = () => { h.plan.items.push({ kind: 'extra', act: true, fireAt: h.now - 60000, time: '11:59', wakeId: 'new' }); h.plan.state_version++; };
  await run(); assert.equal(h.calls.length, 0); console.log('PASS quota is computed from refreshed cloud slots');
}
{
  const { h, run } = recheckFixture(); say(h, 'user', '好'); h.result.extra = [{ time: '12:15', intent: '接话题' }];
  h.onModel = () => { h.plan.context.mood = 'new state'; h.plan.state_version++; };
  await run(); assert.equal(h.plan.context.mood, 'new state'); assert.equal(h.plan.items.length, 0);
  assert.equal(h.jobs.length, 1); assert.equal(h.jobs[0].status, 'cancelled'); console.log('PASS concurrent plan change rejects old model output and cancels its orphan job');
}
for (const failure of ['historyFails', 'noTemplate', 'modelFails']) {
  const { h, run } = recheckFixture(); say(h, 'user', '好'); h[failure] = true;
  for (let n = 1; n <= 6; n++) {
    await run(); assert.equal(h.plan.retry_count, n, failure);
    const calls = h.calls.length; await run(); assert.equal(h.calls.length, calls, 'backoff does not retry model');
    if (n < 6) h.now = Date.parse(h.plan.next_retry_at);
  }
  assert.equal(h.plan.retry_stopped, true); assert.ok(h.plan.retry_error); await run(); assert.equal(h.plan.retry_count, 6);
  console.log('PASS ' + failure + ': bounded durable backoff and visible stopped state');
}
for (const passive of [true, false]) {
  const { h, init, run } = fixture(); await init(); h.plan.context.day.schedule = []; h.plan.context.minGapMin = 60;
  h.outbox.push({ id: 'old', job_id: 'other', trigger_key: passive ? 'deferred:old' : 'timedwake:old', raw_text: '上一条', created_at: new Date(h.now - 1000).toISOString() });
  await run(); assert.equal(h.calls.length, passive ? 1 : 0);
  if (!passive) assert.equal(Date.parse(h.job.execute_at), h.now - 1000 + 3600000);
}
console.log('PASS passive reply never delays an impulse; actual impulse waits directly until spacing ends');
{
  const { h, init, run } = fixture(); await init(); h.plan.context.day.schedule = []; h.outboxWriteFails = true;
  for (let n = 1; n <= 6; n++) { await run(); if (n < 6) h.now = Date.parse(h.job.execute_at); }
  assert.equal(h.job.status, 'failed'); assert.match(h.job.result_note, /stopped/); assert.equal(h.calls.length, 1);
  h.outboxWriteFails = false; h.job.status = 'pending'; h.job.result_note = 'retry resumed'; await run();
  assert.equal(h.outbox.length, 1); assert.equal(h.calls.length, 1); console.log('PASS exhausted delivery retries preserve cached reply for explicit recovery');
}
{
  const { h, init, run } = fixture(); await init(); h.leaseMissing = true; await run();
  assert.equal(h.job.status, 'failed'); assert.match(h.job.result_note, /schema 12/); assert.equal(h.calls.length, 0);
  console.log('PASS missing schema stops generation explicitly');
}

{
  const { h, run } = recheckFixture(); delete h.plan.state_version;
  const r = await run(); assert.match(await r.text(), /^stopped:/); assert.equal(h.calls.length,0);
  assert.ok(Date.parse(h.plan.last_recheck_at) > h.now + 365*86400000);
  console.log('PASS legacy schema parks the plan outside automatic scans until upgrade and explicit synchronization');
}
