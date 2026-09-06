// Exercise the real log store and usage SDK dispatch with isolated browser storage.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';

const root = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');
function load(file, globals, exports) {
    const source = stripTypeScriptTypes(read(file))
        .replace(/^import\s[\s\S]*?;\s*$/gm, '')
        .replace(/\bexport\s+(?=(?:async\s+)?function|const )/g, '');
    return vm.runInNewContext(`${source}\n;({${exports}})`, globals);
}
const kv = new Map();
const globals = {
    window: {}, Date, registerKvMigration() {},
    kvGet: key => kv.get(key) ?? null,
    kvSet: (key, value) => kv.set(key, value),
    kvRemove: key => kv.delete(key),
};
const stats = load('lib/api-usage-stats.ts', globals, 'recordApiUsage,getApiUsageDays,USAGE_MAX_DAYS');
const store = load('lib/api-log-store.ts', { ...globals, ...stats },
    'pushApiLog,getApiLogs,getQaApiLogs,getUsageApiLogs,getUsageApiLog,getApiLogCapacity,setApiLogCapacity,API_LOG_CAPACITY_OPTIONS,clearApiLogs,clearQaApiLogs');
const runner = read('components/app-market/custom-app-runner.tsx');
const dispatchSource = runner.slice(runner.indexOf('    if (action === "usage.readDaily")'), runner.indexOf('    if (action === "characters.list")'));
assert.ok(dispatchSource.includes('usage.readLogDetail'));
const permissions = new Set(['usage.read', 'usage.logs', 'usage.settings']);
const dispatch = vm.runInNewContext(stripTypeScriptTypes(`(function(action: string, record: Record<string, unknown> = {}) {${dispatchSource}})`), {
    ...store, ...stats,
    requirePermission(permission) { if (!permissions.has(permission)) throw new Error(`Missing ${permission}`); },
    resolveUsageSourceNames: sources => Object.fromEntries([...sources].map(source => [source, source === 'qa' ? '工坊' : source])),
});
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS', name); }
function entry(channel, index) {
    return {
        characterName: channel === 'qa' ? '工坊' : '小卷',
        source: channel === 'qa' ? 'qa' : 'mascot', channel,
        model: 'test-model', messages: [{ role: 'user', content: `prompt ${index}` }],
        rawResponse: `reply ${index}`, reasoning: 'reasoning',
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    };
}
test('19 workshop and 9 ordinary calls are readable without counting usage twice', () => {
    for (let i = 0; i < 19; i++) store.pushApiLog(entry('qa', i));
    for (let i = 0; i < 9; i++) store.pushApiLog(entry('chat', i));
    const before = JSON.stringify(stats.getApiUsageDays({ days: 1 }));
    const result = dispatch('usage.readLogs', { limit: 500 });
    assert.equal(result.total, 28);
    assert.equal(result.logs.filter(log => log.source === 'qa').length, 19);
    assert.equal(store.getApiLogs().length, 9);
    assert.equal(store.getQaApiLogs().length, 19);
    assert.equal(JSON.stringify(stats.getApiUsageDays({ days: 1 })), before);
    assert.equal(stats.getApiUsageDays({ days: 1 })[0].bySource.qa.calls, 19);
});
test('Workshop statistics drilldown, source filter and detail all find the same logs', () => {
    const result = dispatch('usage.readLogs', { characterName: '工坊', source: 'qa', limit: 500 });
    assert.equal(result.logs.length, 19);
    const log = result.logs[0];
    assert.equal(log.sourceName, '工坊');
    assert.equal(log.messages, undefined);
    assert.equal(log.rawResponse, undefined);
    const detail = dispatch('usage.readLogDetail', { id: log.id });
    assert.equal(detail.usage.total_tokens, 110);
    assert.ok(detail.messages[0].content.startsWith('prompt '));
    assert.ok(detail.rawResponse.startsWith('reply '));
    assert.equal(detail.reasoning, 'reasoning');
    assert.equal(dispatch('usage.readLogDetail', { id: 'missing' }), null);
});
test('Role IDs and failure filters remain effective with both channels', () => {
    store.pushApiLog({ ...entry('chat', 30), characterId: 'role-qa-name', characterName: '工坊' });
    store.pushApiLog({ ...entry('qa', 31), failed: true });
    assert.equal(dispatch('usage.readLogs', { source: 'qa', failedOnly: true }).total, 1);
    const result = dispatch('usage.readLogs', { characterId: 'role-qa-name' });
    assert.equal(result.total, 1);
    assert.equal(result.logs[0].source, 'mascot');
});
test('Metadata and detail still require their respective permissions', () => {
    permissions.delete('usage.logs');
    assert.ok(dispatch('usage.readLogs').logs.length);
    assert.throws(() => dispatch('usage.readLogDetail', { id: store.getQaApiLogs()[0].id }), /Missing usage.logs/);
    permissions.add('usage.logs');
    permissions.delete('usage.read');
    assert.throws(() => dispatch('usage.readLogs'), /Missing usage.read/);
    permissions.add('usage.read');
});
test('Merged order uses actual timestamps even when logs use different timezone offsets', () => {
    kv.set('ai_phone_api_logs_v1', JSON.stringify([{ ...entry('chat', 1), id: 'middle', timestamp: '2026-09-07T00:30:00Z' }]));
    kv.set('ai_phone_qa_api_logs_v1', JSON.stringify([
        { ...entry('qa', 2), id: 'older', timestamp: '2026-09-07T08:00:00+08:00' },
        { ...entry('qa', 3), id: 'newer', timestamp: '2026-09-07T09:00:00+08:00' },
    ]));
    assert.deepEqual(Array.from(dispatch('usage.readLogs').logs, log => log.id), ['newer', 'middle', 'older']);
});
test('Merged capacity, settings and details agree while original rings remain intact', () => {
    const workshopId = store.getQaApiLogs()[0].id;
    kv.set('ai_phone_qa_api_logs_v1', JSON.stringify(store.getQaApiLogs().map(log => ({ ...log, timestamp: '2000-01-01T00:00:00Z' }))));
    for (let i = 0; i < 55; i++) store.pushApiLog(entry('chat', i));
    const result = dispatch('usage.setSettings', { logCapacity: 50 });
    assert.equal(result.logCount, 50);
    assert.equal(dispatch('usage.readLogs', { limit: 500 }).logs.length, 50);
    assert.equal(dispatch('usage.getSettings').logCount, 50);
    assert.equal(dispatch('usage.getSettings').logChars, JSON.stringify(store.getUsageApiLogs()).length);
    assert.equal(store.getQaApiLogs().length, 2);
    assert.equal(dispatch('usage.readLogs', { limit: 500 }).logs.some(log => log.id === workshopId), false);
    assert.equal(dispatch('usage.readLogDetail', { id: workshopId }).id, workshopId);
});
test('Clearing ordinary logs preserves workshop logs and never removes daily usage', () => {
    const before = JSON.stringify(stats.getApiUsageDays({ days: 1 }));
    store.clearApiLogs();
    assert.equal(dispatch('usage.readLogs').total, 2);
    store.clearQaApiLogs();
    assert.equal(dispatch('usage.readLogs').total, 0);
    assert.equal(JSON.stringify(stats.getApiUsageDays({ days: 1 })), before);
});
console.log(`Passed ${checks} usage log regression checks.`);
