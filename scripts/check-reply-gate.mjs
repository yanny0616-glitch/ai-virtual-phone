import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const at = hm => new Date(`2026-09-07T${hm}:00`).getTime();
let now = at('09:00');
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const kv = new Map();
const math = Object.create(Math);
math.random = () => 0.5;
const ctx = vm.createContext({
  Date: Clock, Math: math,
  registerKvMigration() {},
  kvGet: key => kv.get(key), kvSet: (key, value) => kv.set(key, value), kvRemove: key => kv.delete(key),
  kvKeysWithPrefix: prefix => [...kv.keys()].filter(key => key.startsWith(prefix)),
  loadInstalledCustomApps: () => [{ id: 'gua.nian', permissions: ['chat.context'] }],
});
const source = stripTypeScriptTypes(read('lib/chat-reply-gate.ts'))
  .replace(/^import\s[\s\S]*?;\s*$/gm, '')
  .replace(/\bexport\s+(?=(?:async\s+)?function|const |class )/g, '');
vm.runInContext(source + '\nglobalThis.api={normalizeReplyGate,evaluateReplyGate,setCustomAppReplyGate,readDeferredReply,writeDeferredReply,takeDueDeferredReplies,retryBusyDeferredReply};', ctx);
const a = ctx.api;
const make = (title, overrides = {}) => a.normalizeReplyGate({ busy: {
  date: '2026-09-07', peekMin: 3, adaptive: true,
  windows: [{ from: '08:40', to: '11:50', title }], ...overrides,
} });
const decide = gate => a.evaluateReplyGate(gate, '今天吃什么？', now);
const install = gate => a.setCustomAppReplyGate('gua.nian', 'c', gate);
const schedule = gate => {
  kv.clear(); install(gate);
  const decision = decide(gate);
  a.writeDeferredReply('s', { ...decision, characterId: 'c' });
  return decision;
};

for (const title of ['整理资料', '整理仓库']) assert.equal(decide(make(title)).until, at('09:03'));
for (const title of ['部门会议', '周一例会+合规', '开车', '课堂', '考试']) assert.equal(decide(make(title)).until, at('11:53'));
assert.equal(decide(make('会议', { adaptive: false })).until, at('09:03'));
assert.equal(decide(make('会议', { adaptive: undefined })).until, at('09:03'));
assert.equal(decide(make('会议', { peekMin: 0 })).kind, 'now');
assert.equal(a.evaluateReplyGate(make('会议'), '请马上回', now).kind, 'now');

const meeting = make('会议', { windows: [{ from: '08:40', to: '11:50', title: '会议', breaks: [
  { from: '10:00', to: '10:10' }, { from: '07:00', to: '08:00' },
  { from: '11:40', to: '12:00' }, { from: '10:30', to: '10:20' },
] }] });
assert.equal(meeting.busy.windows[0].breaks.length, 1);
assert.equal(decide(meeting).until, at('10:03'));
const pauseDecision = schedule(meeting);
assert.deepEqual([...a.takeDueDeferredReplies(at('10:03'))], ['s']);
assert.deepEqual([...a.takeDueDeferredReplies(at('10:04'))], []);

// App resumed after the whole break: wait for the next real opportunity.
schedule(meeting);
assert.deepEqual([...a.takeDueDeferredReplies(at('10:15'))], []);
assert.equal(a.readDeferredReply('s').until, at('11:53'));
assert.deepEqual([...a.takeDueDeferredReplies(at('11:53'))], ['s']);
assert.ok(a.readDeferredReply('s').note.includes('现在才有空'));

// Schedule changes are re-read at dispatch, with no LLM call.
schedule(meeting);
install(make('会议延长', { windows: [{ from: '08:40', to: '12:50', title: '会议延长' }] }));
assert.deepEqual([...a.takeDueDeferredReplies(at('10:03'))], []);
assert.equal(a.readDeferredReply('s').until, at('12:53'));
schedule(make('整理资料'));
install(a.normalizeReplyGate({ sleep: { bed: '09:01', wake: '10:00', bufferMin: 0 }, busy: make('整理资料').busy }));
assert.deepEqual([...a.takeDueDeferredReplies(at('09:03'))], []);
assert.equal(a.readDeferredReply('s').reason, 'sleep');
assert.equal(a.readDeferredReply('s').until, at('10:00'));
schedule(meeting);
install(null);
assert.deepEqual([...a.takeDueDeferredReplies(pauseDecision.until)], ['s']);
assert.equal(a.readDeferredReply('s').note, '');

// Busy model execution retries keep the scheduling metadata and cannot revive a cancelled task.
schedule(meeting);
a.takeDueDeferredReplies(at('10:03'));
a.retryBusyDeferredReply('s', at('10:03'), at('10:03'));
assert.equal(a.readDeferredReply('s').characterId, 'c');
assert.equal(a.readDeferredReply('s').busyAvailableUntil, at('10:10'));
a.writeDeferredReply('s', null);
a.retryBusyDeferredReply('s', at('10:03'), at('10:04'));
assert.equal(a.readDeferredReply('s'), null);

// Focused work without steps gets one chance per checkpoint, not per send.
const probabilistic = make('会议', { focusedPeekProb: 25 });
const checkpoint = schedule(probabilistic);
assert.equal(checkpoint.until, at('09:03'));
assert.equal(checkpoint.busyCheck, true);
let draws = 0;
math.random = () => { draws++; return 0.5; };
assert.deepEqual([...a.takeDueDeferredReplies(at('09:03'))], []);
assert.equal(a.readDeferredReply('s').until, at('09:06'));
assert.equal(draws, 2); // Chance check plus the next interval's jitter.
assert.deepEqual([...a.takeDueDeferredReplies(at('09:03'))], []);
assert.equal(draws, 2);
math.random = () => { draws++; return 0.1; };
assert.deepEqual([...a.takeDueDeferredReplies(at('09:06'))], ['s']);
assert.equal(a.readDeferredReply('s').busyCheck, false);
assert.ok(a.readDeferredReply('s').note.includes('不要声称活动已经结束'));
assert.equal(draws, 3);
a.retryBusyDeferredReply('s', at('09:06'), at('09:06'));
assert.deepEqual([...a.takeDueDeferredReplies(at('09:06') + 20_000)], ['s']);
assert.equal(draws, 3); // A busy generation retry does not roll again.
math.random = () => 0.5;
assert.equal(decide(make('会议', { focusedPeekProb: 0 })).until, at('11:53'));
schedule(make('会议', { focusedPeekProb: 100 }));
math.random = () => 0.99;
assert.deepEqual([...a.takeDueDeferredReplies(at('09:03'))], ['s']);
math.random = () => 0.5;
schedule(probabilistic);
draws = 0;
math.random = () => { draws++; return 0.5; };
assert.deepEqual([...a.takeDueDeferredReplies(at('11:40'))], []);
assert.equal(draws, 2); // Reopening late does not replay missed checkpoints.
assert.equal(a.readDeferredReply('s').until, at('11:43'));
assert.deepEqual([...a.takeDueDeferredReplies(at('11:49'))], []);
assert.equal(a.readDeferredReply('s').until, at('11:50'));
assert.deepEqual([...a.takeDueDeferredReplies(at('11:50'))], ['s']);
assert.ok(a.readDeferredReply('s').note.includes('现在才有空'));
math.random = () => 0.5;
schedule({ ...meeting, busy: { ...meeting.busy, focusedPeekProb: 25 } });
assert.deepEqual([...a.takeDueDeferredReplies(at('09:59'))], []);
assert.equal(a.readDeferredReply('s').until, at('10:00'));
math.random = () => { throw new Error('An explicit break needs no chance roll'); };
assert.deepEqual([...a.takeDueDeferredReplies(at('10:00'))], ['s']);
assert.ok(a.readDeferredReply('s').note.includes('休息间隙'));
math.random = () => 0.5;
assert.equal(make('会议', { focusedPeekProb: -5 }).busy.focusedPeekProb, 0);
assert.equal(make('会议', { focusedPeekProb: 125 }).busy.focusedPeekProb, 100);
assert.equal(make('会议', { focusedPeekProb: 'invalid' }).busy.focusedPeekProb, 0);

// Run the real chat-room entry: repeated sends, including just after the deadline, remain one wait.
const room = read('components/chat/chat-room.tsx');
const start = room.indexOf('    const scheduleGatedReply =');
const end = room.indexOf('    // 「触发回复」按钮', start);
let generated = 0, pending;
Object.assign(ctx, {
  session: { id: 's', contactId: 'c', isGroup: false },
  queueDeferredReplyCloud() {}, cancelDeferredReplyCloud: async () => true,
  activeGenerationRuns: new Map(), isGeneratingRef: { current: false },
  triggerAIResponse: () => generated++, showChatToast() {}, setPendingGenerate: value => { pending = value; },
});
vm.runInContext(stripTypeScriptTypes(room.slice(start, end)) + '\nglobalThis.send=scheduleGatedReply;', ctx);
kv.clear(); install(make('整理资料'));
for (let i = 0; i < 5; i++) { ctx.send('普通消息' + i); now += 1000; }
assert.equal(a.readDeferredReply('s').until, at('09:03'));
assert.equal(generated, 0);
assert.equal(pending, false);
now = at('09:03') + 1; ctx.send('最后补一句');
assert.equal(a.readDeferredReply('s').until, at('09:03'));
assert.deepEqual([...a.takeDueDeferredReplies(now)], ['s']);
ctx.isGeneratingRef.current = true; ctx.activeGenerationRuns.set('s', {});
ctx.send('再点一次');
assert.ok(a.readDeferredReply('s').firedAt);
ctx.isGeneratingRef.current = false; ctx.activeGenerationRuns.clear();
now = at('09:00'); schedule(meeting); ctx.send('请马上回');
assert.equal(generated, 1);
assert.equal(a.readDeferredReply('s'), null);
assert.deepEqual([...a.takeDueDeferredReplies(at('10:03'))], []);

now = at('09:00'); kv.clear(); install(probabilistic);
draws = 0;
math.random = () => { draws++; return 0.5; };
for (let i = 0; i < 5; i++) ctx.send('补充消息' + i);
assert.equal(draws, 1); // Only the first send samples the initial interval.
assert.equal(a.readDeferredReply('s').until, at('09:03'));
assert.equal(a.readDeferredReply('s').busyCheck, true);
now = at('09:03'); ctx.send('到点补充');
assert.equal(draws, 1);
assert.deepEqual([...a.takeDueDeferredReplies(now)], []);
assert.equal(draws, 3);
ctx.send('继续补充');
assert.equal(draws, 3);
assert.equal(a.readDeferredReply('s').until, at('09:06'));
now = at('09:00'); math.random = () => 0.5;

// The packaged app projects only explicit rest steps into the host gate.
const app = read('custom-apps/gua-nian/index.html').match(/<script>([\s\S]*)<\/script>/)[1];
let gatePayload;
const appCtx = vm.createContext({ Date: Clock, AiPhone: { chat: { setReplyGate: async value => { gatePayload = value; } } } });
vm.runInContext(app.replace(/  init\(\);\s*\}\)\(\);\s*$/, 'globalThis.api={S,SET_DEF,syncReplyGate};})();'), appCtx);
appCtx.api.S.settings = { ...appCtx.api.SET_DEF };
const character = { character: { id: 'c' }, day: { date: '2026-09-07', wake: '07:00', bed: '23:00', schedule: [{
  time: '08:40', end: '11:50', title: '会议', busy: true, steps: [
    { time: '08:40', what: '汇报进展' }, { time: '10:00', what: '茶歇休息' },
    { time: '10:10', what: '继续讨论' }, { time: '11:00', what: '不休息继续讨论' },
  ],
}] } };
await appCtx.api.syncReplyGate(character);
assert.equal(gatePayload.gate.busy.adaptive, true);
assert.equal(gatePayload.gate.busy.focusedPeekProb, 25);
assert.deepEqual(JSON.parse(JSON.stringify(gatePayload.gate.busy.windows[0].breaks)), [{ from: '10:00', to: '10:10' }]);
appCtx.api.S.settings.focusedPeekProb = 0;
await appCtx.api.syncReplyGate(character);
assert.equal(gatePayload.gate.busy.focusedPeekProb, 0);
appCtx.api.S.settings.smartBusyReply = false;
await appCtx.api.syncReplyGate(character);
assert.equal(gatePayload.gate.busy.adaptive, false);
console.log(`Passed adaptive reply timing, task merging and app gate integration (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`);
