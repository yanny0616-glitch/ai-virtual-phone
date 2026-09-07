import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const js = s => stripTypeScriptTypes(s).replace(/^import\s[\s\S]*?;\s*$/gm, '').replace(/^export\s*\{[^}]*\};?\s*$/gm, '').replace(/^export /gm, '');
const json = (v, status = 200) => Response.json(v, { status });
const at = hm => new Date(`2026-09-07T${hm}:00`).getTime();
const clone = structuredClone;

function fixture() {
  const h = { now: at('09:00'), random: 0.5, rows: [], outbox: [], calls: [], notifications: [], lost: false, supported: true, claimOnUpdate: false, project: 'https://cloud.test', config: 'A' };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [h.now])); } static now() { return h.now; } }
  const math = Object.create(Math); math.random = () => h.random;
  const common = { console, Date: Clock, Math: math, Response, Request, Headers, URL, URLSearchParams, AbortController, AbortSignal, TextEncoder, TextDecoder, Uint8Array, crypto: webcrypto, btoa, atob, setTimeout: () => 1, clearTimeout() {} };
  const rest = async (path, init = {}) => {
    const url = new URL('https://cloud.test/rest/v1/' + path);
    const table = url.pathname.split('/').pop(), method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    if (table === 'push_server_config') return json([{ cron_secret: 'test-cron', payload_key: 'test-encryption-key', site_origin: 'https://phone.test' }]);
    if (table === 'push_subscriptions') return json([{ endpoint: 'shell:test' }]);
    if (table === 'push_outbox') {
      if (method === 'POST') { h.outbox.push(...body); return json(body); }
      return json(url.searchParams.has("job_id") ? h.outbox.filter(row => row.job_id === url.searchParams.get("job_id").slice(3)) : h.outbox);
    }
    if (table !== 'push_jobs') return json([]);
    const match = row => [...url.searchParams].every(([k, v]) => {
      if (['select', 'order', 'limit', 'on_conflict'].includes(k)) return true;
      if (v.startsWith('eq.')) return String(row[k]) === v.slice(3);
      if (v.startsWith('neq.')) return String(row[k]) !== v.slice(4);
      if (v.startsWith('lte.')) return Date.parse(row[k]) <= Date.parse(v.slice(4));
      throw Error('Unhandled filter ' + k + ':' + v);
    });
    if (method === 'GET') return json(h.rows.filter(match));
    if (method === 'POST') {
      const created = [];
      for (const r of body) if (!h.rows.some(old => old.user_id === r.user_id && old.trigger_key === r.trigger_key)) {
        const row = { updated_at: new Clock().toISOString(), ...r }; h.rows.push(row); created.push(row);
      }
      return json(created);
    }
    if (method === 'PATCH') {
      if (h.claimOnUpdate && url.searchParams.has('updated_at')) { h.claimOnUpdate = false; h.rows[0].status = 'running'; }
      const rows = h.rows.filter(match); rows.forEach(r => Object.assign(r, clone(body))); return json(rows);
    }
    throw Error('Unhandled rest method');
  };
  let worker;
  const w = vm.createContext({ ...common, Deno: { env: { get: name => name === 'SUPABASE_URL' ? 'https://cloud.test' : 'test-service' }, serve: handler => { worker = handler; } }, fetch: async (url, init) => {
    if (url.includes('/rest/v1/')) return rest(url.split('/rest/v1/')[1], init);
    if (url === 'https://model.test/chat') { h.calls.push(JSON.parse(init.body)); return json({ choices: [{ message: { content: '嗯，我看到了。' } }] }); }
    if (url.includes('/realtime/')) return json({});
    throw Error('Unexpected worker fetch ' + url);
  } });
  vm.runInContext(js(read('supabase/functions/push-generate/index.ts')) + '\nglobalThis.cryptoApi={encryptPayload,decryptPayload,advanceCloudReplyTiming};', w);
  const encrypt = value => w.cryptoApi.encryptPayload(JSON.stringify(value), 'test-encryption-key');
  const decrypt = async row => JSON.parse(await w.cryptoApi.decryptPayload(row.payload, 'test-encryption-key'));
  const gatewaySource = read('supabase/functions/ai-phone-push/index.ts');
  const block = gatewaySource.slice(gatewaySource.indexOf('    if (action === "deferred-reply")'), gatewaySource.indexOf('    if (action === "jobs" && request.method === "GET")'));
  const g = vm.createContext({ ...common, rest, json, cleanText: (v, max) => String(v ?? '').trim().slice(0, max),
    OWNER_ID: 'owner', supabaseUrl: 'https://cloud.test', serviceKey: 'test-service', MAX_PAYLOAD_BYTES: 900_000,
    loadConfig: async () => ({ cron_secret: 'test-cron', payload_key: 'test-encryption-key' }),
    encryptPayload: w.cryptoApi.encryptPayload, decryptPayload: w.cryptoApi.decryptPayload,
    fetch: async (url, init) => h.supported ? worker(new Request(url, init)) : json({ capabilities: [] }),
  });
  vm.runInContext(js(`async function gateway(request) { const url = new URL(request.url); const action = "deferred-reply"; ${block} }`) + '\nglobalThis.gateway=gateway;', g);
  const gateway = (method, key, payload) => g.gateway(new Request('https://cloud.test?'+new URLSearchParams(key ? { key } : {}), { method, ...(payload ? { body: JSON.stringify({ payload }) } : {}) }));
  const kv = new Map();
  const window = new EventTarget(); window.setInterval = () => 1;
  window.addEventListener('deferred-reply-cloud-status', e => h.notifications.push(e.detail.message));
  const history = [{ id: 'u1', sessionId: 's', role: 'user', content: '在忙吗', createdAt: new Clock().toISOString() }];
  const c = vm.createContext({ ...common, window, document: new EventTarget(), Event, CustomEvent,
    registerKvMigration() {}, kvGet: k => kv.get(k), kvSet: (k, v) => kv.set(k, v), kvRemove: k => kv.delete(k), kvKeysWithPrefix: prefix => [...kv.keys()].filter(k => k.startsWith(prefix)),
    loadInstalledCustomApps: () => [{ id: 'gua.nian', permissions: ['chat.context'] }],
    isPersonalPushCloudActive: () => true, loadPersonalPushCloudState: () => ({ url: h.project }), hasAccountPushSubscription: async () => true,
    personalPushFetch: async (action, init, params) => {
      const response = await gateway(init.method, params?.key, init.body ? JSON.parse(init.body).payload : undefined);
      if (h.lost && init.method === 'POST') { h.lost = false; throw Error('response lost'); }
      return response;
    },
    CHAT_MESSAGE_PUSHED_EVENT: 'chat-message-pushed', loadChatMessages: () => clone(history), loadChatSessions: () => [{ id: 's', contactId: 'c', isGroup: false }],
    buildChatPromptMessages: async (session, messages) => ({ llmMessages: messages.map(m => ({ role: m.role, content: m.content })), character: { id: 'c', name: '角色' }, config: h.config, preset: null, regexes: [], userIdentity: { name: '用户' } }),
    maybeAppendShortcutCapability() {}, toLlmRequestMessages: v => v,
    buildProviderRequest: (config, preset, messages) => ({ url: 'https://model.test/chat', headers: { Authorization: 'test-' + config }, body: { model: config, messages }, providerKind: 'openai-compatible' }),
  });
  vm.runInContext(js(read('lib/chat-reply-gate.ts')) + js(read('lib/deferred-reply-cloud.ts')) + '\nglobalThis.api={normalizeReplyGate,setCustomAppReplyGate,evaluateReplyGate,readDeferredReply,writeDeferredReply,takeDueDeferredReplies,queueDeferredReplyCloud,cancelDeferredReplyCloud,installDeferredReplyCloudSync,freezeDeferredReplyTiming,sync,locks};', c);
  const a = c.api;
  const gate = a.normalizeReplyGate({ busy: { date: '2026-09-07', peekMin: 3, adaptive: true, focusedPeekProb: 25, windows: [{ from: '08:40', to: '11:50', title: '会议' }] } });
  a.setCustomAppReplyGate('gua.nian', 'c', gate);
  a.writeDeferredReply('s', { ...a.evaluateReplyGate(gate, '在忙吗', h.now), characterId: 'c' });
  const drain = async () => { for (let i = 0; i < 1000 && a.locks.size; i++) await pause(5); assert.equal(a.locks.size, 0); };
  const run = () => worker(new Request('https://cloud.test/functions/v1/push-generate', { method: 'POST', body: JSON.stringify({ jobId: h.rows[0].id, token: 'test-cron' }) }));
  return { h, a, history, window, drain, run, gateway, encrypt, decrypt, w };
}

// Actual client -> authenticated gateway -> encrypted database -> actual worker -> outbox.
{
  const { h, a, history, window, drain, run, decrypt } = fixture();
  a.queueDeferredReplyCloud('s');
  assert.ok(a.readDeferredReply('s').cloud);
  await drain(); assert.equal(h.rows.length, 1); assert.equal(a.readDeferredReply('s').cloud.state, 'active');
  const key = h.rows[0].trigger_key, firstAt = h.rows[0].execute_at;
  assert.ok(!JSON.stringify(h.rows[0].payload).includes('test-A'));
  for (let i = 0; i < 5; i++) { history.push({ id: 'u'+i, sessionId: 's', role: 'user', content: '补充'+i, createdAt: new Date(h.now).toISOString() }); a.queueDeferredReplyCloud('s'); }
  await drain(); assert.equal(h.rows.length, 1); assert.equal(h.rows[0].execute_at, firstAt);
  assert.equal((await decrypt(h.rows[0])).request.body.messages.length, 6);
  assert.deepEqual([...a.takeDueDeferredReplies(at('12:00'))], []);
  await run(); assert.equal(h.calls.length, 0); // Not due: even a stale cron dispatch cannot claim.
  h.now = at('09:03'); await run(); assert.equal(h.calls.length, 0);
  assert.equal(h.rows[0].execute_at, new Date(at('09:06')).toISOString());
  a.installDeferredReplyCloudSync(); await drain();
  h.config = 'B'; window.dispatchEvent(new Event('settings-api-configs-updated')); await drain();
  assert.equal(h.rows[0].execute_at, new Date(at('09:06')).toISOString());
  assert.equal((await decrypt(h.rows[0])).request.headers.Authorization, 'test-B');
  h.now = at('09:06'); h.random = 0.1;
  await Promise.all([run(), run()]);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].model, 'B');
  assert.equal(h.outbox.length, 1); assert.equal(h.outbox[0].trigger_key, key);
  assert.ok(JSON.stringify(h.calls[0]).includes('不要声称活动结束'));
  assert.equal(h.rows[0].status, 'done'); assert.deepEqual(h.rows[0].payload, {});
  await a.sync('s'); assert.ok(a.readDeferredReply('s').firedAt);
  assert.deepEqual([...a.takeDueDeferredReplies(at('12:00'))], []);
}
console.log('PASS offline probability, merged messages, API switching, exclusive claim, outbox and credential cleanup');
{
  const { h, a, drain } = fixture(); h.lost = true;
  a.queueDeferredReplyCloud('s'); await drain();
  assert.equal(h.rows.length, 1); assert.equal(a.readDeferredReply('s').cloud.state, 'error');
  assert.deepEqual([...a.takeDueDeferredReplies(at('12:00'))], []);
  await a.sync('s'); assert.equal(h.rows.length, 1); assert.equal(a.readDeferredReply('s').cloud.state, 'active');
}
console.log('PASS lost upload acknowledgement retries the same task without local fallback');
{
  const { h, a, drain, gateway, decrypt } = fixture();
  a.queueDeferredReplyCloud('s'); await drain();
  const payload = await decrypt(h.rows[0]), key = h.rows[0].trigger_key;
  assert.equal(await a.cancelDeferredReplyCloud('s'), true);
  payload.deferredReply.revision++;
  assert.equal((await (await gateway('POST', key, payload)).json()).status, 'cancelled');
  assert.equal(h.rows.length, 1); assert.deepEqual(h.rows[0].payload, {});
}
console.log('PASS cancellation tombstone prevents a delayed upload from recreating the task');
{
  const { h, a, drain, gateway, decrypt } = fixture(); a.queueDeferredReplyCloud('s'); await drain();
  const payload = await decrypt(h.rows[0]); payload.deferredReply.revision++; payload.request.body.model = 'B';
  h.claimOnUpdate = true;
  const result = await (await gateway('POST', h.rows[0].trigger_key, payload)).json();
  assert.equal(result.status, 'running'); assert.equal((await decrypt(h.rows[0])).request.body.model, 'A');
  assert.equal(await a.cancelDeferredReplyCloud('s'), false);
}
console.log('PASS an already claimed task cannot be overwritten or cancelled into a duplicate');
{
  const { h, a, drain } = fixture(); h.supported = false;
  a.queueDeferredReplyCloud('s'); await drain();
  assert.equal(h.rows.length, 0); assert.equal(a.readDeferredReply('s').cloud, undefined);
  assert.ok(h.notifications.some(n => n.includes('更新网关')));
}
{
  const { h, a, drain } = fixture(); a.queueDeferredReplyCloud('s'); await drain(); h.project = 'https://different.test';
  await a.sync('s'); assert.equal(h.rows.length, 1); assert.equal(a.readDeferredReply('s').cloud.state, 'error');
  assert.equal(await a.cancelDeferredReplyCloud('s'), false);
}
console.log('PASS old-worker fallback and personal-cloud project isolation');
// Shared rules exercise deterministic boundaries without network/LLM calls.
{
  const { h, a, w } = fixture(); const t = a.freezeDeferredReplyTiming(a.readDeferredReply('s'));
  const next = w.cryptoApi.advanceCloudReplyTiming;
  assert.equal(next(t, at('09:03'), () => 0.5).ready, false);
  assert.equal(next(t, at('11:50'), () => 0.99).ready, true);
  const breaks = clone(t); breaks.windows[0].breaks = [{ from: at('10:00'), to: at('10:10') }];
  assert.equal(next(breaks, at('10:00'), () => { throw Error('No probability during break'); }).ready, true);
  const asleep = { ...t, sleepWakeProbability: 0, sleeps: [{ from: at('09:01'), to: at('10:00') }], sleepBufferMin: 0 };
  assert.equal(next(asleep, at('09:03'), () => 0.5).nextAt, at('10:00'));
  assert.equal(next({ ...asleep, sleepWakeProbability: 100 }, at('09:03'), () => 0.5).ready, true);
  const moved = clone(t); moved.windows[0].key = 'new-window'; moved.windows[0].to = at('12:50');
  assert.equal(next(moved, at('09:03'), () => 0.5).ready, false);
  assert.equal(next({ ...t, probability: 100 }, at('09:03'), () => 0.99).ready, true);
  h.now = at('09:00');
}
console.log(`Passed deferred cloud integration (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`);
