// Execute current host implementations with synthetic stores; no model or network calls.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const compile = s => ts.transpileModule(s.replace(/^import\s[\s\S]*?;\s*$/gm, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function load(file, globals = {}) { const c = vm.createContext({ exports: {}, console, ...globals }); vm.runInContext(compile(read(file)), c); return c.exports; }
const time = { buildCharacterTimeContext: () => ({}), getSystemTimeZone: () => 'UTC', getPromptTimestampOptionsForTimeContext: () => ({}), resolvePromptTimeAware: v => v };
const macro = load('lib/macro-engine.ts', time);
const factory = load('lib/builtin-preset.ts', { getCheckPhonePromptTags: () => [] }).createBuiltinPreset();
const { assemblePromptPayload } = load('lib/llm-prompt-assembler.ts', { ...time, ...macro, formatCharacterRelationsForPrompt: () => '', isNativeToolResultMessage: () => false, matchesActiveTags: (tags, active) => !tags?.length || tags.every(t => active.includes(t)), stripStateAndInnerForPrompt: v => v });
const engine = read('lib/chat-engine.ts'), ec = vm.createContext({ exports: {} });
vm.runInContext(compile(engine.slice(engine.indexOf('function matchesPromptProfileRef('), engine.indexOf('function mergeAppTags('))), ec);
const ac = vm.createContext({});
vm.runInContext(read('custom-apps/xiao-ju-chang/src/gen/assemble.js') + ';globalThis.include = includeList;', ac);
for (const mode of ['host', 'recent', 'none']) {
  const preset = ec.exports.applyCustomPromptProfileToPreset(factory, { include: ac.include({ memory: { mode }, who: 'persona' }) });
  const task = { id: 'task', role: 'user', content: 'UNIQUE_APP_TASK', createdAt: '2026-09-12T12:00:00Z' };
  const input = { character: { id: 'A', name: 'Alice', persona: 'CHARACTER' }, history: [task], preset, worldBooks: [], regexes: [], appId: 'custom_app:xjc', appTags: ['xjc'], timeAware: false, requiredTask: task, recentBlocks: [{ tag: 'events', content: 'HOST_EVENT_SECRET' }] };
  const text = JSON.stringify(assemblePromptPayload(input));
  assert.equal((text.match(/UNIQUE_APP_TASK/g) || []).length, 1, `${mode}: task must appear exactly once`);
  assert.equal(text.includes('HOST_EVENT_SECRET'), mode === 'host', `${mode}: memory isolation`);
  if (mode !== 'host') assert.ok(!JSON.stringify(assemblePromptPayload({ ...input, requiredTask: undefined })).includes('UNIQUE_APP_TASK'), 'ordinary preset history exclusion is preserved');
}
// Verify actual SDK wiring reaches the engine, not just an optional assembler field in isolation.
const host = read('lib/custom-app-host-api.ts');
const start = host.indexOf('export async function generateCustomAppText('), end = host.indexOf('\nexport ', start + 10);
const hc = vm.createContext({ exports: {}, serializeCustomAppContextMessage: m => m, hasPermission: () => false, cleanText: v => String(v || ''), cleanUnboundedText: v => String(v || ''), ensureCharacterSession: () => ({ id: 's' }), resolvePromptProfile: () => ({ history: 'none' }), normalizeCustomAppGenerateMessages: () => [], activeCustomAppWorldBookIds: () => [], readWorldActivations: () => [], buildCustomAppChatTags: () => ['xjc'], flattenCompletionResult: () => 'done',
  generateChatCompletion: async (_session, history, opts) => { assert.equal(opts.requiredTask.content, '[App] REQUIRED_INSTRUCTION'); assert.equal(opts.requiredTask.id, history.at(-1).id); return {}; } });
vm.runInContext(compile(host.slice(start, end)), hc);
await hc.exports.generateCustomAppText({ id: 'xjc', name: 'App' }, { characterId: 'A', instruction: 'REQUIRED_INSTRUCTION' });
assert.match(engine, /requiredTask: options\?\.requiredTask/);
console.log('PASS actual host assembler and SDK: task once, host memory only when selected, normal history suppression unchanged');

const runner = read('components/app-market/custom-app-runner.tsx');
const source = runner.slice(runner.indexOf('    if (action.startsWith("db."))'), runner.indexOf('    if (action === "user.getProfile")'));
const rows = Array.from({ length: 1201 }, (_, i) => ({ id: `row-${i}` }));
const dc = vm.createContext({ app: { id: 'xjc' }, requirePermission() {}, collectionName: n => n, readCustomAppCollection: () => rows });
vm.runInContext(compile(`async function dispatch(action, record) { ${source} };globalThis.dispatch = dispatch;`), dc);
const received = [];
for (const offset of [0, 500, 1000]) received.push(...await dc.dispatch('db.list', { collection: 'favorites', query: { limit: 500, offset } }));
assert.equal(received.length, 1201); assert.equal(new Set(received.map(r => r.id)).size, 1201);
assert.equal((await dc.dispatch('db.list', { collection: 'favorites', query: {} })).length, 100);
console.log('PASS actual SDK pagination: 1201 rows without duplicates; old default limit remains 100');
