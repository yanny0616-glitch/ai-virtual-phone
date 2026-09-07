import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { checkGuaNianBuild } from './build-gua-nian.mjs';

checkGuaNianBuild();
const root = new URL('../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');
const script = read('custom-apps/gua-nian/index.html').match(/<script>([\s\S]*)<\/script>/)[1];
const localTime = hm => new Date(`2026-09-07T${hm}:00`).getTime();
const now = localTime('09:46');
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const h = { requests: [], response: {} };
const context = vm.createContext({ h, Date: Clock, console, Intl, AiPhone: {}, document: {} });
vm.runInContext(script.replace(/  init\(\);\s*\}\)\(\);\s*$/, `
  generateJson = async (_cx, req) => { h.requests.push(req); return h.response; };
  saveSchedule = async (cx, schedule) => { cx.day.schedule = schedule; };
  log = async () => {};
  globalThis.api = { S, SET_DEF, ctxOf, energyAt, schedDetailHtml, parseDayResult,
    buildDayInstruction, refineSchedSteps, refineSchedItem, applyChatSchedEdits };
})();`), context);
const a = context.api;
a.S.settings = { ...a.SET_DEF };
const cx = a.ctxOf({ id: 'c', name: '角色' });
a.S.cur = 'c';
a.S.byId.c = cx;
function worker(name, expose) {
  const ctx = vm.createContext({ Date, console, Deno: { serve() {} } });
  vm.runInContext(stripTypeScriptTypes(read(`supabase/functions/${name}/index.ts`)) + '\n' + expose, ctx);
  return ctx.api;
}
const recheck = worker('push-recheck', 'globalThis.api={guanianNow,parseDayResult};');
const generate = worker('push-generate', 'globalThis.api={guanianStateNote};');
const clone = value => JSON.parse(JSON.stringify(value));

// Existing high-cost records are bounded at read time; the stored day is preserved.
cx.day = {
  energy: 52, wake: '06:25', bed: '23:00', mood: '平静',
  schedule: [
    { time: '06:25', end: '06:55', title: '晨跑', cost: -20 },
    { time: '07:10', end: '07:35', title: '早餐', cost: 9 },
    { time: '08:40', end: '11:50', title: '例会', cost: -25 },
  ],
  conds: [{ startAt: now, energyDelta: -20, halfLifeMin: 240, mood: '发紧', cause: '胃不舒服' }],
};
const before = JSON.stringify(cx.day);
assert.equal(a.energyAt(cx.day, now), 25);
for (const hm of ['06:25', '07:35', '08:40', '09:46', '11:50', '18:00', '23:00']) {
  const ms = localTime(hm);
  const cloudDay = { ...clone(cx.day), tz: -new Date(ms).getTimezoneOffset() };
  const expected = a.energyAt(cx.day, ms);
  assert.equal(recheck.guanianNow(cloudDay, ms).energy, expected, hm);
  assert.ok(generate.guanianStateNote(cloudDay, ms).includes(`精力：${expected}%`), hm);
}
assert.equal(JSON.stringify(cx.day), before);
const html = a.schedDetailHtml(2);
assert.ok(html.includes('消耗 -15'));
assert.ok(html.includes('预计做完后'));
assert.ok(html.includes(`${a.energyAt(cx.day, localTime('11:50'))}% 精力`));
assert.notEqual(a.energyAt(cx.day, localTime('08:40')), a.energyAt(cx.day, localTime('11:50')));

// Both daily parsers and both manual edit paths enforce the same scale.
const input = { energy: 80, wake: '07:00', bed: '23:00', schedule: [
  { time: '09:00', end: '10:00', title: '会议', cost: -25 },
  { time: '12:00', title: '午休', cost: 40 },
], body: [{ label: '不适', energy: -20 }] };
for (const parse of [a.parseDayResult, recheck.parseDayResult]) {
  const day = parse(input, [], a.SET_DEF, now);
  assert.equal(day.energy, 80);
  assert.equal(day.schedule[0].cost, -15);
  assert.equal(day.schedule[1].cost, 15);
  assert.equal(day.conds[0].energyDelta, -8);
}

// The model sees exactly the preset for this task; detail generation preserves the day.
const presets = JSON.parse(read('custom-apps/gua-nian/presets.json')).presets;
const matched = tags => presets.filter(p => p.tags.every(tag => tags.includes(tag))).map(p => p.id);
assert.deepEqual(matched(['companion', 'daily']), ['guanian-daily']);
const old = clone(cx.day.schedule[2]);
h.response = { steps: [
  { time: '12:00', what: '不在时段内' }, { time: '09:30', what: '确认口径' },
  { time: '08:40', what: '开始例会' }, { time: '08:00', what: '还没开始' },
  { time: '11:50', what: '已结束' }, { what: '缺失时间' },
] };
await a.refineSchedSteps(cx, 2);
assert.deepEqual(matched(h.requests.at(-1).appTags), ['guanian-schedule-steps']);
assert.deepEqual(clone(cx.day.schedule[2]), { ...old, steps: [
  { time: '08:40', what: '开始例会' }, { time: '09:30', what: '确认口径' },
] });
const saved = JSON.stringify(cx.day);
h.response = { schedule: input.schedule };
await assert.rejects(a.refineSchedSteps(cx, 2), /steps/);
assert.equal(JSON.stringify(cx.day), saved);
h.response = { time: '08:40', title: '例会', cost: -25 };
await a.refineSchedItem(cx, 2, '别那么累');
assert.deepEqual(matched(h.requests.at(-1).appTags), ['guanian-schedule-edit']);
assert.equal(cx.day.schedule[2].cost, -15);
await a.applyChatSchedEdits(cx, [{ op: 'add', newTime: '20:00', title: '散步', cost: 40 }], now);
assert.equal(cx.day.schedule.at(-1).cost, 15);

// A typical day stays usable through the morning and visibly recovers at lunch.
const ordinary = { energy: 80, wake: '07:00', bed: '23:00', schedule: [
  { time: '07:30', end: '08:00', title: '早餐', cost: 3 },
  { time: '08:00', end: '08:30', title: '通勤', cost: -3 },
  { time: '09:00', end: '12:00', title: '工作会议', cost: -8 },
  { time: '12:00', end: '12:30', title: '午饭休息', cost: 5 },
] };
assert.equal(a.energyAt(ordinary, localTime('12:00')), 66);
assert.ok(a.energyAt(ordinary, localTime('12:30')) > 66);
const instruction = a.buildDayInstruction({ label: '周一', season: '秋' }, '08:00', { lines: [], residue: [] }, [], []);
assert.ok(instruction.includes('70 到 90'));
assert.ok(instruction.includes('普通会议/工作扣 3 到 8'));
console.log(`Passed gua-nian preset routing, detail preservation and energy checks (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`);
