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
