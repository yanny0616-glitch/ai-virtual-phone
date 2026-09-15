import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

const src = fs.readFileSync(new URL('../lib/menstrual-predict.ts', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(src).replace(/^export /gm, '') + '\nglobalThis.api={estimateCycle,predictWindow,windowsUntil,carePhaseForWindow,eveReminderDate,shiftDate};', ctx);
const { estimateCycle, predictWindow, windowsUntil, carePhaseForWindow, eveReminderDate, shiftDate } = ctx.api;
const plain = v => JSON.parse(JSON.stringify(v));
const manual = { cycleLength: 28, periodLength: 5 };
const startsFromGaps = (last, gaps) => { const s = [last]; for (const g of [...gaps].reverse()) s.unshift(shiftDate(s[0], -g)); return s; };
const periodsOf = (starts, len = 5) => starts.map(s => ({ startDate: s, endDate: shiftDate(s, len - 1) }));

const starts = startsFromGaps('2026-08-21', [28, 31, 58, 29, 32, 30]);
let est = estimateCycle(starts, periodsOf(starts), manual, true);
assert.equal(est.source, 'records');
assert.equal(est.cycleLength, 30);
assert.equal(est.spread, 2);
assert.equal(est.periodLength, 5);
assert.deepEqual(plain(est.intervals).filter(x => x.skipped).map(x => x.days), [58]);
let win = predictWindow('2026-08-21', est, '2026-09-15');
assert.deepEqual(plain(win), { anchor: '2026-08-21', peak: '2026-09-20', start: '2026-09-18', end: '2026-09-22', lateDays: 0 });
console.log('PASS 漏记一次被剔掉，按记录算出 30±2，窗口 9/18–22');

est = estimateCycle(['2026-08-21'], periodsOf(['2026-08-21']), manual, true);
assert.equal(est.source, 'manual'); assert.equal(est.cycleLength, 28);
est = estimateCycle(startsFromGaps('2026-08-21', [30]), [], manual, true);
assert.equal(est.source, 'records'); assert.equal(est.cycleLength, 30); assert.equal(est.spread, 2);
est = estimateCycle(startsFromGaps('2026-08-21', [58]), [], manual, true);
assert.deepEqual([est.source, est.cycleLength], ['records', 58], '只有一段间隔时没得比，照记录算');
est = estimateCycle(startsFromGaps('2026-08-21', [30, 58]), [], manual, true);
assert.deepEqual([est.source, est.cycleLength], ['records', 30]);
console.log('PASS 记录不够两次退回手填；两段里剔掉加倍的那段');

est = estimateCycle(starts, periodsOf(starts), manual, false);
assert.deepEqual([est.source, est.cycleLength, est.spread], ['manual', 28, 2]);
console.log('PASS 关掉「按记录自动算」就用手填');

est = estimateCycle(startsFromGaps('2026-08-21', [26, 27, 26, 27, 26, 27]), [], manual, true);
assert.equal(est.spread, 1, '周期很稳时窗口收窄');
est = estimateCycle(startsFromGaps('2026-08-21', [24, 36, 25, 35, 26, 34]), [], manual, true);
assert.ok(est.spread >= 4, '波动大时窗口放宽');
console.log('PASS 窗口随波动变宽变窄');

est = estimateCycle(starts, periodsOf(starts), manual, true);
win = predictWindow('2026-08-21', est, '2026-09-25');
assert.equal(win.peak, '2026-09-20'); assert.equal(win.lateDays, 3);
win = predictWindow('2026-08-21', est, '2026-10-17');
assert.equal(win.peak, '2026-09-20', '下一个窗口开始前一直停在晚了');
win = predictWindow('2026-08-21', est, '2026-10-18');
assert.deepEqual([win.peak, win.lateDays], ['2026-10-20', 0]);
console.log('PASS 晚了不跳周期，到下一个窗口才往后推');

const list = windowsUntil(predictWindow('2026-08-21', est, '2026-09-15'), est, '2026-12-31');
assert.deepEqual(Array.from(list, w => w.peak), ['2026-09-20', '2026-10-20', '2026-11-19', '2026-12-19']);
console.log('PASS 往后投影的窗口');

win = predictWindow('2026-08-21', est, '2026-09-15');
assert.equal(eveReminderDate(win), '2026-09-17');
const phase = (d, lead, eve) => carePhaseForWindow(predictWindow('2026-08-21', est, d), d, lead, eve);
assert.equal(phase('2026-09-16', 1, false), null);
assert.equal(phase('2026-09-17', 1, false), 'before');
assert.equal(phase('2026-09-17', 1, true), null, '前一晚提醒开着时同一天不再提前关心');
assert.equal(phase('2026-09-16', 2, true), 'before');
assert.equal(phase('2026-09-19', 1, false), null);
assert.equal(phase('2026-09-20', 1, false), 'active');
assert.equal(phase('2026-09-24', 1, false), null);
assert.equal(phase('2026-09-25', 1, false), 'late');
console.log('PASS 关心时机：提前、当天、晚了三天，前一晚提醒不重复');
console.log('menstrual-predict: all passed');
