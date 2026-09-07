import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import './build-chat-plugins-dist.mjs';
import { fixture } from './check-deferred-reply-cloud.mjs';
const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const at = hm => new Date(`2026-09-07T${hm}:00`).getTime();
function pluginFixture(source) {
  const f = fixture(), { a, c, h } = f;
  if (source !== undefined) a.setCustomAppReplyGate('gua.nian', 'c', a.normalizeReplyGate(source));
  const hooks = new Map(), data = new Map(), variables = new Map();
  c.getChatPluginHookBus = () => ({ hasHandlers: point => hooks.has(point) });
  c.runChatPluginTransformSync = (point, payload) => hooks.has(point) ? hooks.get(point)(payload) : payload;
  vm.runInContext(read('chat-plugins/busy-reply.js').replace('export default', 'globalThis.plugin ='), c);
  const settings = Object.fromEntries(c.plugin.manifest.settings.map(s => [s.key, s.default]));
  let change = () => {};
  const set = (key, value) => { settings[key] = value; change({ ...settings }); };
  const context = {
    hooks: { transform: (point, fn) => { hooks.set(point, fn); return () => hooks.delete(point); } },
    data: { characters: { list: () => [{ id: 'c' }] }, replyGate: { policyVersion: 1, silenceVersion: 1, get: a.readReplyGate }, variables: { get: (name, scope, id) => variables.get(`${name}:${id}`) } },
    system: {
      settings: { get: k => settings[k], all: () => ({ ...settings }), set, onChange: fn => { change = fn; } },
      storage: { get: k => data.get(k), set: (k, v) => data.set(k, v) },
    },
  };
  c.plugin.setup(context);
  return { ...f, settings, data, variables, set, hooks, resolve: () => a.readEffectiveReplyGate('c'), now: () => h.now };
}
const source = {
  availabilityOnly: true,
  legacyReplySettings: { enabled: false, adaptive: false, peekMin: 0, focusedPeekProb: 0, sleepMode: 'chance', wakeProb: 0, wakeBufferMin: 0 },
  sleep: { bed: '23:00', wake: '07:00' },
  busy: { date: '2026-09-07', windows: [{ from: '08:40', to: '11:50', title: '会议', breaks: [{ from: '10:00', to: '10:10' }] }] },
};
{
  const f = fixture(); f.a.setCustomAppReplyGate('gua.nian', 'c', f.a.normalizeReplyGate(source));
  assert.equal(f.a.readEffectiveReplyGate('c'), null);
  assert.equal(f.a.readReplyGate('c').busy.windows.length, 1); // Presence keeps its source even without the policy plugin.
}
{
  const { settings, data, resolve, set, a, hooks } = pluginFixture(source);
  assert.equal(settings.enabled, false); assert.equal(settings.peekMin, 0); assert.equal(settings.focusedPeekProb, 0);
  assert.equal(settings.wakeProb, 0); assert.equal(settings.wakeBufferMin, 0); assert.equal(data.get('migrationDone'), true);
  assert.equal(resolve(), null);
  set('enabled', true); set('peekMin', 4); set('focusedPeekProb', 30); set('adaptive', true);
  const gate = resolve(); assert.equal(gate.busy.peekMin, 4); assert.equal(gate.busy.focusedPeekProb, 30);
  assert.equal(gate.busy.windows[0].focused, true); assert.equal(gate.busy.windows[0].breaks.length, 1);
  a.setCustomAppReplyGate('gua.nian', 'c', a.normalizeReplyGate({ ...source, legacyReplySettings: { ...source.legacyReplySettings, peekMin: 9 } }));
  assert.equal(resolve().busy.peekMin, 4); // Later APP uploads cannot overwrite plugin edits.
  hooks.clear(); assert.equal(resolve(), null); assert.ok(a.readReplyGate('c').busy);
}
{
  const { a, hooks, resolve } = pluginFixture();
  a.markReplyGatePolicyAdopted(); // Runtime records adoption even before the first chat opens.
  hooks.clear(); assert.equal(resolve(), null);
}
console.log('PASS source-only availability, disabled/zero migration and independent plugin settings');
{
  const { resolve, hooks, a } = pluginFixture();
  assert.equal(resolve().busy.focusedPeekProb, 25); // Old app without availabilityOnly still migrates.
  hooks.clear(); assert.equal(resolve(), null); // Stopping the plugin cannot reactivate the old app policy.
  assert.ok(a.readReplyGate('c').busy);
}
{
  const { h, variables, resolve, set, a } = pluginFixture(null);
  assert.equal(resolve(), null); // No app and no manual state: no delay.
  variables.set('presenceOverride:c', { state: 'busy', at: h.now, label: '专注' });
  assert.equal(resolve().busy.windows[0].focused, true);
  const decision = a.evaluateReplyGate(resolve(), '你好', h.now); assert.equal(decision.busyCheck, true);
  set('urgentBypass', false); assert.equal(a.evaluateReplyGate(resolve(), '快回', h.now).kind, 'delay');
  set('urgentBypass', true); assert.equal(a.evaluateReplyGate(resolve(), '快回', h.now).kind, 'now');
  h.now += 61 * 60_000; assert.equal(resolve(), null);
  h.now = at('23:45'); variables.set('presenceOverride:c', { state: 'busy', at: h.now });
  const gate = resolve(), frozen = a.freezeDeferredReplyTiming({ ...a.evaluateReplyGate(gate, '你好', h.now), characterId: 'c' });
  assert.equal(frozen.windows[0].to, at('23:45') + 3600_000);
  h.now = at('23:45') + 30 * 60_000;
  assert.equal(a.evaluateReplyGate(resolve(), '你好', h.now).kind, 'delay');
  h.now = at('23:45') + 60 * 60_000; assert.equal(resolve(), null);
}
console.log('PASS standalone manual state, urgency switch and cross-midnight expiry');
{
  const { a, h, drain, run, window, hooks, resolve, decrypt } = pluginFixture();
  resolve(); a.installDeferredReplyCloudSync(); await drain();
  a.queueDeferredReplyCloud('s'); await drain(); assert.equal(h.rows.length, 1);
  hooks.clear(); window.dispatchEvent(new Event('reply-policy-updated')); await drain();
  assert.equal((await decrypt(h.rows[0])).deferredReply.timing.disabled, true);
  assert.ok(Date.parse(h.rows[0].execute_at) <= h.now);
  await run(); assert.equal(h.calls.length, 1); assert.equal(h.outbox.length, 1);
  await a.sync('s'); assert.ok(a.readDeferredReply('s').firedAt);
  assert.deepEqual([...a.takeDueDeferredReplies(h.now)], []);
}
console.log('PASS disabling the plugin releases an existing cloud wait exactly once');
{
  const { a, h, drain } = pluginFixture();
  h.legacyGateway = true;
  a.queueDeferredReplyCloud('s'); await drain();
  assert.equal(h.rows.length, 0); assert.equal(a.readDeferredReply('s').cloud, undefined);
}
console.log('PASS old gateway cannot claim support for plugin policy lifecycle');
{
  const runtime = read('lib/chat-plugin-runtime.ts');
  const methods = runtime.slice(runtime.indexOf('    async ensureReady()'), runtime.indexOf('    private async start()'));
  const c = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(`class Runtime { started=true; pendingReloads=0; reloading=Promise.resolve(); ensureStarted(){return Promise.resolve();} ${methods} }; globalThis.runtime=new Runtime();`), c);
  const r = c.runtime;
  let first, second, completed = false;
  r.reloading = new Promise(resolve => { first = resolve; }); r.pendingReloads = 2;
  const ready = r.ensureReady().then(() => { completed = true; });
  await Promise.resolve();
  r.reloading = new Promise(resolve => { second = resolve; });
  first();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(completed, false); assert.equal(r.isReady(), false);
  r.pendingReloads = 0; second(); await ready;
  assert.equal(completed, true); assert.equal(r.isReady(), true);
}
console.log('PASS readiness waits for reloads queued during an earlier reload');
const app = read('custom-apps/gua-nian/index.html');
assert.ok(app.includes('availabilityOnly: true'));
const settingsSource = read('custom-apps/gua-nian/src/ui/settings.js');
for (const key of ['replyGate', 'smartBusyReply', 'focusedPeekProb', 'busyPeekMin']) assert.ok(!settingsSource.includes(`key: "${key}"`));
assert.ok(settingsSource.includes('key: "busyHold"')); // Proactive-message settings remain in Gua Nian.
assert.equal(read('public/chat-plugins/busy-reply.js'), read('chat-plugins/busy-reply.js'));
assert.ok(JSON.parse(read('public/chat-plugins/index.json')).some(p => p.id === 'busy-reply'));
console.log(`Passed busy reply plugin migration and integration (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`);
