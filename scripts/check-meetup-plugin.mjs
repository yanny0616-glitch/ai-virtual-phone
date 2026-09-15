import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../chat-plugins/meetup.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(src.replace(/^export default /m, 'globalThis.plugin = '), ctx);
const { parseWhen, takeDirectives } = ctx.plugin.helpers;
assert.equal(ctx.plugin.manifest.id, 'meetup');

// 2026-09-15 是周二
const now = new Date(2026, 8, 15, 12, 0).getTime();
const at = (m, d, h, mi = 0, y = 2026) => new Date(y, m - 1, d, h, mi).getTime();
const cases = [
  ['9月20日 19:00', at(9, 20, 19)],
  ['2026-09-20 19:30', at(9, 20, 19, 30)],
  ['明天 19:30', at(9, 16, 19, 30)],
  ['今晚7点半', at(9, 15, 19, 30)],
  ['后天下午3点', at(9, 17, 15)],
  ['中午1点', at(9, 15, 13)],
  ['19:00', at(9, 15, 19)],
  ['9:00', at(9, 16, 9)],
  ['周五 19:00', at(9, 18, 19)],
  ['下周五 19:00', at(9, 25, 19)],
  ['周二 10:00', at(9, 22, 10)],
  ['现在', now],
  ['周末', null],
  ['25:00', null],
  ['', null],
];
for (const [input, want] of cases) assert.equal(parseWhen(input, now), want, `parseWhen(${input})`);
assert.equal(parseWhen('1月3日 18:00', new Date(2026, 11, 20).getTime()), at(1, 3, 18, 0, 2027), 'next-year rollover');
assert.equal(parseWhen('下周五 19:00', new Date(2026, 8, 19, 9).getTime()), at(9, 25, 19), 'Saturday: 下周五 is 6 days later');
console.log('PASS parseWhen');

let r = takeDirectives('好呀，那就这么说定了。\n[约见答应]');
assert.equal(r.text, '好呀，那就这么说定了。');
assert.deepEqual(JSON.parse(JSON.stringify(r.found)), [{ kind: 'accept', arg: '' }]);
r = takeDirectives('那天下午要开会。\n[约见改时间：明天 20:00]');
assert.equal(r.found[0].kind, 'retime');
assert.equal(r.found[0].arg, '明天 20:00');
r = takeDirectives('周五带你去挑唱片？\n[约见:9月18日 19:00|江边那家旧书店|新到了一批唱片]');
assert.equal(r.found[0].kind, 'invite');
assert.deepEqual(r.found[0].arg.split('|'), ['9月18日 19:00', '江边那家旧书店', '新到了一批唱片']);
assert.equal(r.text, '周五带你去挑唱片？');
r = takeDirectives('[约见邀请] 9月20日（周日）19:00 · 火锅（待答复）');
assert.equal(r.found.length, 0, 'card text echoed back is not a directive');
const plain = '今天好累\n\n\n想你';
assert.equal(takeDirectives(plain).text, plain, 'text without directives is untouched');
r = takeDirectives('[约见推掉]');
assert.equal(r.text, '');
assert.equal(r.found[0].kind, 'decline');
console.log('PASS directives');
