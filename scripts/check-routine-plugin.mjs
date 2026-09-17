// 忙碌回复 1.2：固定作息、今天的例外、分神、打电话接不接。宿主闸门和插件一起跑。
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
// 2026-09-07 是周一
const at = (hm, day = 7) => new Date(`2026-09-${String(day).padStart(2, '0')}T${hm}:00`).getTime();
let now = at('09:30');
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const math = Object.create(Math);
let roll = 0.5;
math.random = () => roll;
const kv = new Map(), hooks = new Map(), events = new Map(), vars = new Map(), store = new Map([['migrationDone', true]]), topics = new Map();
const ctx = vm.createContext({
  Date: Clock, Math: math,
  getChatPluginHookBus: () => ({ hasHandlers: point => hooks.has(point) }),
  runChatPluginTransformSync: (point, p) => hooks.has(point) ? hooks.get(point)(p) : p,
  registerKvMigration() {},
  kvGet: k => kv.get(k), kvSet: (k, v) => kv.set(k, v), kvRemove: k => kv.delete(k),
  kvKeysWithPrefix: prefix => [...kv.keys()].filter(k => k.startsWith(prefix)),
  loadInstalledCustomApps: () => [{ id: 'gua.nian', permissions: ['chat.context'] }],
});
vm.runInContext(stripTypeScriptTypes(read('lib/chat-reply-gate.ts'))
  .replace(/^import\s[\s\S]*?;\s*$/gm, '')
  .replace(/\bexport\s+(?=(?:async\s+)?function|const |class )/g, '')
  + '\nglobalThis.api={normalizeReplyGate,evaluateReplyGate,setCustomAppReplyGate,readReplyGate,readEffectiveReplyGate};', ctx);
const a = ctx.api;
vm.runInContext(read('chat-plugins/busy-reply.js').replace('export default', 'globalThis.plugin ='), ctx);
const settings = Object.fromEntries(ctx.plugin.manifest.settings.map(s => [s.key, s.default]));
const wakes = [], messages = [];
let offline = false;
const V = (name, id) => `${name}:${id}`;
ctx.plugin.setup({
  hooks: { transform: (point, fn) => hooks.set(point, fn), on: (point, fn) => events.set(point, fn) },
  data: {
    characters: { list: () => [{ id: 'c' }] },
    sessions: { get: id => id === 's' ? { id: 's', contactId: 'c', isGroup: false } : null },
    messages: { list: () => messages },
    replyGate: { policyVersion: 1, silenceVersion: 1, get: id => a.readReplyGate(id) },
    variables: {
      get: (n, s, id) => vars.get(V(n, id)),
      set: (n, v, s, id) => vars.set(V(n, id), JSON.parse(JSON.stringify(v))),
      unset: (n, s, id) => vars.delete(V(n, id)),
    },
  },
  chat: { offline: { get: () => offline }, scheduleWake: async w => { wakes.push(w); return { armed: true }; }, cancelWake: key => wakes.push({ cancel: key }) },
  system: {
    settings: { get: k => settings[k], all: () => ({ ...settings }), set: (k, v) => { settings[k] = v; }, onChange() {} },
    storage: { get: k => store.get(k), set: (k, v) => store.set(k, v) },
    bus: { emit: (t, d) => (topics.get(t) || []).forEach(fn => fn(d)), on: (t, fn) => topics.set(t, [...(topics.get(t) || []), fn]) },
    log() {},
  },
});
const gate = () => a.readEffectiveReplyGate('c', now);
const decide = (pending = 1) => a.evaluateReplyGate(gate(), '在吗', now, pending);
const ask = (topic, d) => { const q = { characterId: 'c', nowMs: now, ...d }; (topics.get(topic) || []).forEach(fn => fn(q)); return q.result; };
const say = text => hooks.get('llm.response')({ text, sessionId: 's', purpose: 'chat' }).text;
const exs = () => (vars.get(V('routineExceptions', 'c')) || { items: [] }).items;
const hint = () => hooks.get('prompt.system')({ sessionId: 's', characterId: 'c', isGroup: false, hint: '' }).hint;

assert.equal(gate(), null);
vars.set(V('routine', 'c'), { items: [
  { id: 'r1', title: '上课', from: '09:00', to: '11:40', days: [1, 2, 3, 4, 5], kind: 'focus' },
  { id: 'r2', title: '做饭', from: '18:00', to: '19:00', days: [], kind: 'distracted' },
  { id: 'r3', title: '睡觉', from: '01:00', to: '08:30', days: [], kind: 'sleep' },
] });
let g = gate();
assert.equal(g.busy.windows[0].title, '上课'); assert.equal(g.busy.windows[0].focused, true); assert.equal(decide().reason, 'busy');
now = at('09:30', 12); assert.equal(gate(), null); // 周六没课
now = at('18:20');
assert.equal(gate().distracted.title, '做饭');
const d = decide(); assert.equal(d.reason, 'distracted'); assert.ok(d.until - now >= 30_000 && d.until - now <= 120_000);
assert.equal(decide(3).kind, 'now');
settings.distracted = false; assert.equal(gate(), null); settings.distracted = true;
now = at('02:00'); g = gate(); assert.deepEqual([g.sleep.bed, g.sleep.wake], ['01:00', '08:30']); assert.equal(decide().reason, 'sleep');
console.log('PASS fixed routine: weekdays, focus / distracted / sleep, pulled by repeated sends');

a.setCustomAppReplyGate('gua.nian', 'c', a.normalizeReplyGate({ availabilityOnly: true, sleep: { bed: '23:00', wake: '07:00' },
  busy: { date: '2026-09-07', windows: [{ from: '14:00', to: '15:00', title: '会议' }] } }));
now = at('23:30'); assert.equal(gate(), null); // 固定作息写了睡觉，挂念的 23:00 不再算
now = at('14:10'); assert.equal(gate().busy.windows.find(w => w.title === '会议').focused, true);
let q = ask('availability.query'); assert.equal(q.state, 'busy'); assert.equal(q.origin, '挂念日程');
now = at('18:20'); q = ask('availability.query');
assert.equal(q.state, 'distracted'); assert.equal(q.label, '分神 · 一边做饭一边看手机'); assert.equal(q.origin, '固定作息'); assert.equal(q.authoritative, true);
now = at('09:30'); assert.equal(ask('availability.query').label, '忙碌 · 上课');
console.log('PASS routine beats app sleep, app busy windows still count, availability for the presence line');

now = at('00:40', 8);
assert.match(hint(), /01:00–08:30 睡觉（睡觉）/); assert.match(hint(), /\[作息:推迟\|睡觉\|03:00\]/);
assert.equal(say('好，陪你把这部看完再睡。[作息:推迟|睡觉|03:00]'), '好，陪你把这部看完再睡。');
assert.equal(exs().length, 1);
assert.deepEqual([exs()[0].label, exs()[0].quote, exs()[0].via], ['睡觉推迟到 03:00', '好，陪你把这部看完再睡', '聊天']);
now = at('01:30', 8); assert.equal(gate(), null); assert.equal(ask('availability.query').label, '本该睡了 · 还在陪你');
now = at('03:10', 8); assert.equal(gate().sleep.bed, '03:00');
assert.match(hint(), /今天已经改过：睡觉推迟到 03:00/);
now = at('00:50', 8); offline = true;
say('明早翘了，睡到自然醒[作息:取消|明天09:00上课]');
offline = false;
const skip = exs().find(x => x.op === 'skip');
assert.equal(skip.title, '上课'); assert.equal(skip.via, '线下'); assert.equal(skip.maskFrom, at('09:00', 8)); assert.equal(skip.label, '09:00 上课，不去了');
now = at('09:30', 8); assert.equal(gate(), null);
now = at('12:00', 8); say('下午得去趟医院。[作息:加|14:00-16:00|去医院|忙]');
now = at('14:30', 8); assert.ok(gate().busy.windows.some(w => w.title === '去医院')); assert.equal(ask('availability.query').label, '忙碌 · 去医院');
now = at('09:30', 9); assert.equal(gate().busy.windows[0].title, '上课'); // 例外只管当天
now = at('01:30', 8); settings.exceptions = false; assert.equal(gate().sleep.bed, '01:00');
const before = exs().length;
assert.equal(say('好[作息:取消|上课]'), '好'); assert.equal(exs().length, before); // 关掉也把标记从正文拿掉
assert.doesNotMatch(hint(), /作息:推迟/);
settings.exceptions = true;
now = at('10:00', 8);
const agenda = ask('routine.agenda');
assert.ok(agenda.some(o => o.title === '做饭'));
assert.ok(ask('routine.exception', { op: '推迟', arg: '|19:30', target: agenda.find(o => o.title === '做饭') }));
now = at('18:20', 8); assert.equal(gate(), null);
now = at('19:40', 8); assert.equal(gate(), null); // 推迟到 19:30 开始、原来 19:00 结束：这次就不做了
console.log('PASS today exceptions: shift, skip after midnight, add, expiry, switch off, manual add');

vars.delete(V('routineExceptions', 'c'));
const call = () => hooks.get('call.beforeConnect')({ sessionId: 's', characterId: 'c', kind: 'voice', outcome: 'answer', ringMs: 3000 });
const end = outcome => events.get('call.ended')({ sessionId: 's', characterId: 'c', kind: 'voice', outcome, durationSec: 0 });
now = at('03:00', 8); roll = 0.5;
let r = call(); assert.equal(r.outcome, 'noAnswer'); assert.equal(r.ringMs, 20_000); end('noAnswer');
await Promise.resolve();
assert.equal(wakes.at(-1).key, 'missed:c'); assert.equal(wakes.at(-1).fireAt, at('08:40', 8)); assert.match(wakes.at(-1).intent, /1 个语音电话/);
now += 2 * 60_000; r = call(); assert.equal(r.outcome, 'answer'); // 5 分钟内第二通 70%
assert.match(hint(), /被这通电话吵醒/);
end('answer');
assert.deepEqual({ ...wakes.at(-1) }, { cancel: 'missed:c' }); assert.equal(gate(), null); assert.ok(vars.get(V('wokenByCall', 'c')));
assert.equal(ask('availability.query').label, '被电话叫醒 · 还醒着');
assert.doesNotMatch(hint(), /被这通电话吵醒/);
now += 31 * 60_000; assert.ok(gate().sleep); // 醒了半小时又睡回去
store.set('missed:c', [now - 120_000, now - 60_000]); roll = 0.99; assert.equal(call().outcome, 'answer'); end('cancel');
roll = 0.5; now = at('09:30', 8);
r = call(); assert.equal(r.outcome, 'reject'); assert.equal(r.reason, '在上课'); end('reject');
await Promise.resolve();
assert.equal(wakes.at(-1).key, 'callback:c'); assert.equal(wakes.at(-1).fireAt, at('11:41', 8));
messages.push({ role: 'user', content: '我在医院', createdAt: new Date(now - 60_000).toISOString() });
assert.equal(call().outcome, 'answer'); end('cancel'); messages.length = 0;
settings.enabled = false; assert.equal(call().outcome, 'answer'); settings.enabled = true;
now = at('18:20', 8); assert.equal(call().outcome, 'answer'); assert.match(hint(), /一边做饭一边接电话/);
end('answer'); assert.doesNotMatch(hint(), /一边做饭一边接电话/);
console.log('PASS calls: wake chain, missed follow-up, focus reject with callback, urgent, distracted');

assert.equal(read('public/chat-plugins/busy-reply.js'), read('chat-plugins/busy-reply.js'));
assert.equal(read('public/chat-plugins/presence-status.js'), read('chat-plugins/presence-status.js'));
console.log(`Passed routine, exceptions, distraction and call rules (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`);
