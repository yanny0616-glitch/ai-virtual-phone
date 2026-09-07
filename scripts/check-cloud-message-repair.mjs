import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { fixture, at } from './lib/gua-nian-worker-fixture.mjs';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const strip = s => stripTypeScriptTypes(s).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
const hctx = vm.createContext({ Date, Map, Set, Response, encodeURIComponent });
vm.runInContext(strip(read('lib/guanian-cloud-history.ts')) + ';globalThis.readHistory=readGuanianCloudHistory;', hctx);
{
  const mirrors = ['到了', '芳姐说你在睡', '粥在锅里 醒了自己热'].map((content, i) => ({ id: 'm' + i, role: 'assistant', content, message_at: `2026-09-07T10:52:00.00${i}Z` }));
  const outputs = [{ id: 'first', raw_text: '到了\n芳姐说你在睡\n粥在锅里 醒了自己热 [内心] 回来了，她睡着了', created_at: '2026-09-07T08:09Z', consumed_at: '2026-09-07T10:52Z' }];
  const rest = async p => Response.json(p.startsWith('push_chat_mirror') ? mirrors : outputs);
  const history = await hctx.readHistory(rest, 'u', 's');
  assert.equal(history.messages.length, 1); assert.equal(history.messages[0].message_at, outputs[0].created_at);
  mirrors.push({ ...mirrors[0], id: 'unrelated', message_at: '2026-09-07T07:00Z' });
  const next = await hctx.readHistory(rest, 'u', 's');
  assert.equal(next.messages.length, 2); assert.ok(next.messages.some(m => m.id === 'unrelated'));
  console.log('PASS legacy split mirrors merge with their unique consumed output; unrelated identical words survive');
}
{
  const { h, c, init, run } = fixture(); await init(); h.plan.context.day.schedule = []; h.plan.context.day.tz = 480;
  h.mirrors = [{ id: 'm1', role: 'assistant', content: '唯一历史事实', message_at: new Date(at('08:00')).toISOString() }];
  await run(); const prompt = JSON.stringify(h.calls[0]);
  assert.equal(prompt.split('唯一历史事实').length - 1, 1);
  assert.match(prompt, /2026-09-07 16:00/); assert.doesNotMatch(prompt, /2026-09-07 08:00/);
  console.log('PASS generated prompt contains one history block in the character local timezone');
}
for (const fault of ['lease', 'plan-read', 'outbox-write']) {
  const { h, c, init, run } = fixture(); await init(); h.plan.context.day.schedule = [];
  h.plan.context.threads = [{ id: 'p1', kind: 'promise', revision: 1, due: h.now, done: false }];
  Object.assign(h.plan.items[0], { kind: 'promise', from: 'p1', promiseRevision: 1 });
  const originalAt = new Date(h.now).toISOString();
  h.onModel = () => { if (fault === 'lease') h.leaseAvailable = false; if (fault === 'plan-read') h.planReadFails = true; if (fault === 'outbox-write') h.outboxWriteFails = true; };
  await run(); assert.equal(h.calls.length, 1); assert.equal(h.outbox.length, 0); assert.equal(h.job.status, 'pending');
  const saved = JSON.parse(await c.api.decryptPayload(h.job.payload, 'test-key'));
  assert.equal(saved.request.body.messages.length, 0, 'checkpoint must not persist injected history in a reusable template');
  assert.equal(saved.generatedResponse.rawText, h.answer);
  h.onModel = undefined; h.leaseAvailable = true; h.planReadFails = false; h.outboxWriteFails = false; h.now += 60000;
  await run(); assert.equal(h.calls.length, 1); assert.equal(h.outbox.length, 1); assert.equal(h.job.status, 'done');
  assert.equal(h.outbox[0].created_at, originalAt);
  console.log(`PASS ${fault} after generation resumes the saved reply, one model call, original generated timestamp`);
}
// Real consumer and event installer with browser timers and a controlled personal-cloud transport.
{
  let now = 100000, reads = 0, writes = 0; const intervals = [], timeouts = new Map(); let timerId = 0;
  class Clock extends Date { static now() { return now; } }
  const browser = new EventTarget(), doc = new EventTarget(), sw = new EventTarget(); doc.hidden = false;
  browser.setTimeout = f => { timeouts.set(++timerId, f); return timerId; }; browser.clearTimeout = id => timeouts.delete(id);
  browser.setInterval = (f, ms) => { intervals.push({ f, ms }); return 1; };
  const messages = [{ role: 'assistant', content: '另一条回复', createdAt: '2026-09-07T10:00Z', followUpIndex: 1 }];
  const entries = [{ id: 'e1', session_id: 's', trigger_key: 'same', raw_text: '云端第一条', created_at: '2026-09-07T09:00Z', meta: { armAt: '2026-09-07T08:00Z', followUpIndex: 1 } },
    { id: 'e2', session_id: 's', trigger_key: 'same', raw_text: '云端第二条', created_at: '2026-09-07T09:01Z', meta: {} }];
  const c = vm.createContext({ Date: Clock, Event, AbortSignal, console, window: browser, document: doc, refreshChatSessionFromDisk:async()=>{}, navigator: { locks:{request:async(_name,_options,run)=>run({})}, onLine: true, serviceWorker: sw },
    isPersonalPushCloudActive: () => true, getChatPluginRuntime: () => ({ ensureStarted: async () => {} }),
    loadPersonalPushCloudState: () => ({ url: 'https://cloud.test' }), loadChatSessions: () => [{ id: 's' }], loadChatMessages: () => messages,
    personalPushFetch: async (action, init) => {
      assert.equal(action, 'outbox'); // no subscription gate
      assert.ok(init.signal instanceof AbortSignal, "requests must have a timeout signal");
      if (init?.method === 'POST') { const ids = JSON.parse(init.body).ids; for (const id of ids) entries.splice(entries.findIndex(e => e.id === id), 1); return Response.json({ ok: true }); }
      reads++; return Response.json({ ok: true, entries: [...entries] });
    },
    hasPersistedResponseBatch: async (_s,batch) => messages.some(m=>m.responseBatchId===batch), settleDeferredReplyDelivery() {}, removeTimedWakeSchedule() {}, closeChatPushNotifications() {},
    runChatPluginTransform: async (_p, v) => v, stripHallucinatedTimestamps: t => t,
    parseAndSaveResponse: async (text, _s, _n, _f, _m, opts) => { writes++; messages.push({ role: 'assistant', content: text, responseBatchId: opts.responseBatchId }); return { hasVisible: false }; },
    Response,
  });
  vm.runInContext(strip(read('lib/push-outbox-client.ts')) + ';globalThis.install=installServerOutboxConsumer;', c);
  const flush = async () => { for (const [id, fn] of [...timeouts]) { timeouts.delete(id); fn(); } for (let i = 0; i < 60; i++) await Promise.resolve(); };
  c.install(); await flush(); assert.equal(writes, 2); assert.equal(entries.length, 0); assert.equal(reads, 1);
  assert.equal(intervals[0].ms, 20000);
  now += 20000; intervals[0].f(); await flush(); assert.equal(reads, 2);
  doc.hidden = true; now += 20000; intervals[0].f(); await flush(); assert.equal(reads, 2);
  doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange')); await flush(); assert.equal(reads, 3);
  browser.dispatchEvent(new Event('online')); intervals[0].f(); await flush(); assert.equal(reads, 4);
  console.log('PASS distinct replies survive timestamp/follow-up/trigger collisions; foreground polling and visibility/online recovery consume without subscription gating');
}
