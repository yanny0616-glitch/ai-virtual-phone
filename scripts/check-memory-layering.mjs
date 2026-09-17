// 记忆方案阶段二纯逻辑检查：预算按模型校准、核心去重、核心合并输入（剥类型后在沙箱里跑）
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

const src = fs.readFileSync(new URL('../lib/memory-layering.ts', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(src).replace(/^export /gm, '') + '\nglobalThis.api={budgetForModel,isSupersededCore,dropCoveredLongTerm,buildCoreMergeEvents,earliestCoreStart,CORE_MERGE_NOTE};', ctx);
const m = ctx.api;

assert.equal(m.budgetForModel(100000, 1.25), 80000, 'Claude-like ratio shrinks the estimate-side budget');
assert.equal(m.budgetForModel(100000, 0.8), 125000);
assert.equal(m.budgetForModel(100000, null), 100000, 'no samples keeps budget');
assert.equal(m.budgetForModel(0, 1.4), 0, 'unlimited budget stays unlimited');
console.log('PASS budget scales by calibration ratio');

const lt = [
  { id: 'a', content: 'A', createdAt: '2026-09-10T00:00:00.000Z' },
  { id: 'b', content: 'B', createdAt: '2026-09-12T00:00:00.000Z' },
  { id: 'c', content: 'C', createdAt: '2026-09-15T00:00:00.000Z' },
];
assert.deepEqual(m.dropCoveredLongTerm(lt, '2026-09-12T00:00:00.000Z').map(e => e.id), ['c'], 'entries up to the core watermark are covered');
assert.deepEqual(m.dropCoveredLongTerm(lt, null).map(e => e.id), ['a', 'b', 'c'], 'no core yet keeps everything');
assert.equal(m.isSupersededCore({ id: 'x', content: '', createdAt: '', metadata: { supersededBy: 'y' } }), true);
assert.equal(m.isSupersededCore({ id: 'x', content: '', createdAt: '' }), false);
console.log('PASS long-term entries covered by core are dropped');

const cores = [
  { id: 'k2', content: '第二版核心', createdAt: '2026-09-14T00:00:00.000Z', metadata: { timeSpan: '2026-09-05T00:00:00.000Z ~ 2026-09-12T00:00:00.000Z' } },
  { id: 'k1', content: '第一版核心', createdAt: '2026-09-08T00:00:00.000Z', metadata: { timeSpan: '2026-08-30T00:00:00.000Z ~ 2026-09-04T00:00:00.000Z' } },
];
const merged = m.buildCoreMergeEvents(cores, ['新事一', '新事二']);
assert.ok(merged.startsWith(m.CORE_MERGE_NOTE), 'merge note leads');
assert.ok(merged.indexOf('第一版核心') < merged.indexOf('第二版核心'), 'old cores in time order');
assert.ok(merged.indexOf('【新增长期记忆】') > merged.indexOf('第二版核心') && merged.endsWith('- 新事一\n- 新事二'));
assert.equal(m.buildCoreMergeEvents([], ['新事一']), '- 新事一', 'no previous core keeps the old format');
assert.equal(m.earliestCoreStart(cores, '2026-09-13T00:00:00.000Z'), '2026-08-30T00:00:00.000Z');
assert.equal(m.earliestCoreStart([], '2026-09-13T00:00:00.000Z'), '2026-09-13T00:00:00.000Z');
console.log('PASS core merge input keeps old cores and new entries');

{
  const src2 = fs.readFileSync(new URL('../lib/memory-layering.ts', import.meta.url), 'utf8');
  const c2 = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(src2).replace(/^export /gm, '') + '\nglobalThis.split=splitSummaryBatches;globalThis.count=countRounds;', c2);
  let t = Date.parse('2026-09-10T00:00:00Z');
  const at = () => new Date(t += 60_000).toISOString();
  // 一轮：用户连发 userMsgs 条，角色回 bubbles 个气泡
  const round = (userMsgs = 1, bubbles = 3, session = 's1') => [
    ...Array.from({ length: userMsgs }, () => ({ sourceApp: 'chat', sourceDetail: 'direct', authorType: 'user', sessionId: session, timestamp: at() })),
    ...Array.from({ length: bubbles }, () => ({ sourceApp: 'chat', sourceDetail: 'direct', authorType: 'character', sessionId: session, timestamp: at() })),
  ];
  const sizes = b => Array.from(b, x => x.length);
  const chat = Array.from({ length: 10 }, (_, i) => round(i % 2 + 1, 3)).flat();
  assert.equal(c2.count(chat), 10, 'multi-message user input + multi-bubble reply is one round');
  assert.deepEqual(sizes(c2.split(chat, 4)), [18, 18, 9], 'batches cut only at round starts');
  const withMoment = [...round(), { sourceApp: 'moments', timestamp: at() }, ...round()];
  assert.equal(c2.count(withMoment), 3, 'a moments entry is its own round');
  const proactive = [...round(1, 2), { sourceApp: 'chat', sourceDetail: 'direct', authorType: 'character', sessionId: 's1', timestamp: new Date(t += 3 * 3600_000).toISOString() }];
  assert.equal(c2.count(proactive), 2, 'character reaching out hours later starts a new round');
  const tail = [...round(1, 3), ...round(1, 3), { sourceApp: 'moments', timestamp: at() }];
  assert.deepEqual(sizes(c2.split(tail, 2)), [9], 'tail under 4 entries merges into previous batch');
  const same = [...round(1, 3)];
  const tied = { sourceApp: 'moments', timestamp: same[same.length - 1].timestamp };
  assert.deepEqual(sizes(c2.split([...same, tied, ...round(), ...round()], 1)), [5, 4, 4], 'same-instant entries stay together');
  assert.deepEqual(sizes(c2.split([], 30)), []);
  console.log('PASS summary batches split by rounds');
}

{
  const src3 = fs.readFileSync(new URL('../lib/memory-layering.ts', import.meta.url), 'utf8');
  const c3 = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(src3).replace(/^export /gm, '') + '\nglobalThis.win=shortTermWindowStart;', c3);
  assert.equal(c3.win('2026-09-16T14:39:00.000Z', 3), '2026-09-13T14:39:00.000Z', 'window starts N days before the watermark');
  assert.equal(c3.win('2026-09-16T14:39:00.000Z', 0), '2026-09-16T14:39:00.000Z', '0 days = only after summary');
  assert.equal(c3.win(null, 3), null, 'never summarized falls back to budget');
  assert.equal(c3.win('garbage', 3), null);
  console.log('PASS short-term window anchors on the summary watermark');
}
