import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const source = read('custom-apps/gua-nian/src/ui/diagnostics.js');
const worker = read('supabase/functions/ai-phone-push/index.ts');
const ast = ts.createSourceFile('gateway.ts', worker, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'jobDiagnosticFields');
const gateway = vm.createContext({});
vm.runInContext(ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText + ';globalThis.fields=jobDiagnosticFields;', gateway);
const templateId = 'timed_wake_capp_app_gua.nian_abc_sentinel_1789000000000_ab12';
const job = (id, overrides = {}) => ({ triggerKey: 'timedwake:' + id, status: 'pending', executeAt: '2026-09-12T00:00:00Z', ...overrides });
const payload = { notify: { characterId: 'c' }, merge: { sessionId: 's', cooldownRounds: 0 }, request: { secret: 'DO_NOT_EXPOSE' } };
const fields = gateway.fields('timedwake:' + templateId, payload);
assert.equal(fields.taskType, 'template');
assert.equal(fields.characterId, 'c');
assert.ok(!JSON.stringify(fields).includes('DO_NOT_EXPOSE'));
assert.equal(gateway.fields('timedwake:p', { ...payload, merge: { guanianPromise: { id: 'p' } } }).taskType, 'promise');
assert.equal(gateway.fields('timedwake:m', null).detailsAvailable, false);
assert.equal(gateway.fields('timedwake:m', null).cooldownConfigured, false);
const elements = new Map();
const el = id => {
  if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', className: '', hidden: false, classList: { toggle() {}, contains() { return false; } }, appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; } });
  return elements.get(id);
};
const cx = { character: { id: 'c', name: '测试角色' }, plan: { items: [{ wakeId: 'p', kind: 'promise', act: true, source: '<约定>', fireAt: Date.now() + 3600000 }] } };
const calls = [];
const sample = [job(templateId, fields), job('foreign', { ...gateway.fields('timedwake:foreign', { notify: { characterId: 'other' } }) })];
const context = vm.createContext({ console, Date, Map, Set, S: { tab: 'back', sub: 'diag', settings: { sentinels: { c: { wakeId: templateId, previousWakeIds: ['old-template'] } } }, characters: [cx.character] },
  cur: () => cx, $: el, esc: s => String(s ?? '').replaceAll('<', '&lt;').replaceAll('>', '&gt;'), cloudCfg: () => ({ url: 'https://test.invalid' }), owns: () => true,
  todayStr: () => '2026-09-11', fmtHM: () => '08:00', timeToMs: () => 0, cloudRecheckOn: () => true, replanLabel: () => '重置今天', readOwner: async () => {},
  AiPhone: { push: { listWakes: async () => [] } },
  cloudFetch: async (action, _init, params) => {
    calls.push({ action, params });
    if (action === 'health') return { functionsVersion: 3, schemaVersion: 12, capabilities: ['job-status', 'job-diagnostics-v2', 'chat-mirror', 'recheck-plan'] };
    if (action === 'chat-mirror') return { entries: [{ session_id: 's', message_at: '2026-09-11T00:00:00Z', role: 'user' }] };
    if (action === 'jobs' && params.triggerKeys) return { queriedTriggerKeys: JSON.parse(params.triggerKeys), jobs: [job('p', gateway.fields('timedwake:p', { ...payload, merge: { guanianPromise: { id: 'p' } } }))] };
    if (action === 'jobs') return { jobs: sample };
    if (action === 'recheck-plan') return { plan: { items: [], recheck_count: 0 } };
    throw new Error(action);
  },
});
vm.runInContext(source + ';globalThis.api={diagnosticJobGroups,diagnosticCooldownLabel,diagnosticJobsView,renderDiag};', context);
const { diagnosticJobGroups: group, diagnosticCooldownLabel: label, diagnosticJobsView: view } = context.api;
const rows = [...sample, job('old-template'), job('p'), job('done', { characterId: 'c', taskType: 'promise', status: 'cancelled', resultNote: 'promise changed or settled' }), job('unknown'), job('running', { characterId: 'c', taskType: 'message', status: 'running', cooldownConfigured: true, cooldownRounds: 0 })];
const before = JSON.stringify(rows);
const groups = group(rows, 'c', cx.plan.items, context.S.settings.sentinels, 's');
assert.equal(groups.waiting.length, 2);
assert.equal(groups.templates.length, 2);
assert.equal(groups.others.length, 1);
assert.equal(groups.history.length, 1);
assert.equal(groups.unknown.length, 1);
assert.equal(JSON.stringify(rows), before);
assert.match(label(groups.waiting.find(j => j.type === 'promise')), /不适用/);
assert.equal(label(groups.waiting.find(j => j.status === 'running')), '未启用普通降速');
assert.equal(label({ type: 'message' }), '降速配置未确认');
assert.equal(group([job('old')], 'c', [], {}, '').unknown.length, 1);
assert.equal(group([job('m', { sessionId: 'other' })], 'c', [], {}, '').others.length, 0);
assert.equal(group([job('m', { sessionId: 's', taskType: 'message' })], 'c', [], {}, 's').waiting.length, 1);
const rendered = view(groups, rows.length, context.S.characters);
assert.match(rendered.summary, /待执行 1 · 处理中 1 · 模板 2/);
assert.match(rendered.html, /不是全账号任务总数/);
assert.match(rendered.html, /&lt;约定&gt;/);
assert.doesNotMatch(rendered.html, /有旧预约|未带阈值|重置今天/);
await context.api.renderDiag();
for (let i = 0; i < 20; i++) await Promise.resolve();
assert.ok(calls.some(c => c.action === 'jobs' && c.params.triggerKeys === '["timedwake:p"]'), 'sample must not hide current plan task');
assert.match(el('#dgs-jobs').textContent, /待执行 1 · 模板 1/);
assert.doesNotMatch(el('#diag-jobs').innerHTML, /有旧预约/);
assert.equal(el('#dgs-recheck').className, 'sm', 'not yet checked is not a fault');
assert.match(el('#dgs-cloud').textContent, /部署包 v3/);
assert.doesNotMatch(el('#dg-sum').innerHTML, /一切正常|都在正常跑/);
assert.equal(typeof el('#btn-diag-refresh').onclick, 'function');
console.log('PASS: gateway metadata privacy; current/previous templates; ownership and unknowns; promise cooldown; sampled counts; directed lookup; neutral recheck; refresh; no false health guarantee');
